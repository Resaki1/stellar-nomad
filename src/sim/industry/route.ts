import type { ShipPose } from "@/save/types";
import { prepareFieldShape } from "@/sim/asteroids/shapes";
import { allBodyDefs } from "@/sim/celestialConstants";
import { frameOriginXyzKm, SYSTEM_FRAME_ID } from "@/sim/frames";
import { REPLICATION_TUNING } from "@/sim/replication/points";
import { DEFAULT_RESOURCE_TUNING } from "@/sim/ship/resourceTuning";
import { activeSystem } from "@/sim/systemRegistry";
import { DRONE_FUEL_ID, INDUSTRY_TUNING as T, type IndustrySource } from "./catalog";
import { canExtractAt, depotDistanceKm } from "./placement";
import { prospectWorksite } from "./prospects";
import type { DepotRecord, DroneFlightProfile } from "./types";

type Position = Pick<ShipPose, "frameId" | "positionKm">;

export interface DroneRoute {
  pathKm: number;
  legSeconds: number;
  profile: DroneFlightProfile;
  fieldName: string | null;
  returnFuelAtDryKg: number;
  /** The round trip with an empty hold. */
  roundTripFuelKg: number;
}

type RejectedRoute = "different_frame" | "out_of_field" | "blocked" | "tank";
type RouteCheck = { route: DroneRoute; reason: null } | { route: null; reason: RejectedRoute };

// Allow for the rendered berths and the extractor's worksite approach offset.
const ENDPOINT_MARGIN_KM = 0.05;
const frameOrigin = { x: 0, y: 0, z: 0 };
const ACCEL = T.accelerationKmPerS2;
const CRUISE = T.cruiseKmPerS;
const ACCEL_DISTANCE_KM = CRUISE * CRUISE / ACCEL;
const TERMINAL_BURN_S = CRUISE / ACCEL;
const TERMINAL_S = T.terminalDistanceKm / CRUISE + TERMINAL_BURN_S / 2;
const FIELD_ACCEL = T.fieldAccelerationKmPerS2;
const FIELD_START_KM = 2 * T.terminalDistanceKm;
export const DRONE_FUEL_PER_KMPS = DEFAULT_RESOURCE_TUNING.propellantKgPerMps * 1000 * T.dronePropellantScale;

const fields = activeSystem().asteroidFields.filter(field => field.enabled !== false).map(field => ({
  field,
  shape: prepareFieldShape(field.shape),
}));

export const maxDroneLegSeconds = (): number => Math.max(
  204, // Longest funded legacy interbody leg.
  droneLegSeconds(T.maxLocalRouteKm, "local"),
  ...fields.map(({ shape }) => droneLegSeconds(2 * shape.boundingRadiusKm, "field")),
);

function fieldPeakKmps(km: number): number {
  return Math.sqrt(CRUISE ** 2 + FIELD_ACCEL * (km - FIELD_START_KM));
}

/** Rest-to-rest time under the ordinary thruster limits. Short legs never reach cruise. */
export function minimumDroneFlightS(km: number, profile: DroneFlightProfile = "local"): number {
  if (profile === "field" && km > FIELD_START_KM) {
    return 2 * (TERMINAL_S + (fieldPeakKmps(km) - CRUISE) / FIELD_ACCEL);
  }
  return km <= ACCEL_DISTANCE_KM
    ? 2 * Math.sqrt(km / ACCEL)
    : km / CRUISE + TERMINAL_BURN_S;
}

export const droneLegSeconds = (km: number, profile: DroneFlightProfile = "local"): number =>
  Math.max(T.minLegSeconds, Math.ceil(minimumDroneFlightS(km + ENDPOINT_MARGIN_KM, profile)));

export function localDronePeakKmps(km: number, durationS: number): number {
  return 2 * km / (durationS + Math.sqrt(Math.max(0, durationS ** 2 - 4 * km / ACCEL)));
}

function fieldDistanceKm(elapsedS: number): number {
  if (elapsedS <= TERMINAL_BURN_S) return 0.5 * ACCEL * elapsedS ** 2;
  if (elapsedS <= TERMINAL_S) return CRUISE * (elapsedS - TERMINAL_BURN_S / 2);
  const burnS = elapsedS - TERMINAL_S;
  return T.terminalDistanceKm + CRUISE * burnS + 0.5 * FIELD_ACCEL * burnS ** 2;
}

/** Distance fraction at the given time. A whole-second scheduled leg uses a slightly lower
 * cruise speed or a shorter burn to arrive at rest exactly on the countdown boundary. */
export function droneFlightProgress(km: number, elapsedS: number, durationS: number, profile: DroneFlightProfile = "local"): number {
  if (km <= 0 || elapsedS >= durationS) return 1;
  if (elapsedS <= 0) return 0;
  if (profile === "field" && km > FIELD_START_KM) {
    const fromNearestEndS = Math.min(elapsedS, durationS - elapsedS);
    const scaledS = fromNearestEndS * minimumDroneFlightS(km, "field") / durationS;
    const fraction = fieldDistanceKm(scaledS) / km;
    return elapsedS <= durationS / 2 ? fraction : 1 - fraction;
  }
  const peak = localDronePeakKmps(km, durationS);
  const burnS = peak / ACCEL;
  const remainingS = durationS - elapsedS;
  if (elapsedS <= burnS) return 0.5 * ACCEL * elapsedS ** 2 / km;
  if (remainingS <= burnS) return 1 - 0.5 * ACCEL * remainingS ** 2 / km;
  return peak * (elapsedS - burnS / 2) / km;
}

interface DroneFuelPlan {
  outboundFuelKg: number;
  returnFuelKg: number;
  roundTripFuelKg: number;
}

export function planDroneReturnFuel(baseKg: number, cargoKg: number): number {
  return baseKg * (1 + cargoKg / T.droneDryMassKg);
}

/** Fund propulsion separately from cargo. The outbound leg also carries the return propellant. */
export function planDroneFuel(route: Pick<DroneRoute, "returnFuelAtDryKg">, outboundCargoKg: number, returnCargoKg: number): DroneFuelPlan {
  const baseKg = route.returnFuelAtDryKg;
  const returnFuelKg = planDroneReturnFuel(baseKg, returnCargoKg);
  const outboundFuelKg = planDroneReturnFuel(baseKg, outboundCargoKg + returnFuelKg);
  return { outboundFuelKg, returnFuelKg, roundTripFuelKg: outboundFuelKg + returnFuelKg };
}

interface DroneLoad extends DroneFuelPlan {
  amount: number;
}

export function dronePayloadMassKg(itemId: string, amount: number): number {
  return amount * (itemId === DRONE_FUEL_ID ? 1 : T.cargoUnitMassKg);
}

/** Reserve enough propellant to bring an undelivered manifest all the way home. */
export function planDroneLoad(route: DroneRoute, itemId: string, request: number, availableKg: number): DroneLoad {
  const fuelCargo = itemId === DRONE_FUEL_ID;
  const perUnitKg = dronePayloadMassKg(itemId, 1);
  const emptyKg = route.roundTripFuelKg;
  const marginalKg = planDroneFuel(route, perUnitKg, perUnitKg).roundTripFuelKg - emptyKg;
  // Each added unit increases both trip fuel and, for a fuel manifest, the debit as cargo.
  const tankAmount = marginalKg ? (T.droneTankKg - emptyKg) / marginalKg : Infinity;
  const depotAmount = availableKg < emptyKg ? 0 : (marginalKg || fuelCargo)
    ? (availableKg - emptyKg) / (marginalKg + Number(fuelCargo)) : Infinity;
  const feasible = Math.max(0, Math.min(request, fuelCargo ? T.loadFuelKg : T.loadUnits, tankAmount, depotAmount));
  const amount = fuelCargo ? feasible : Math.floor(feasible);
  const payloadKg = dronePayloadMassKg(itemId, amount);
  return { amount, ...planDroneFuel(route, payloadKg, payloadKg) };
}

function clearsBodies(home: Position, destination: Position): boolean {
  const [x, y, z] = home.positionKm;
  const [dx, dy, dz] = [destination.positionKm[0] - x, destination.positionKm[1] - y, destination.positionKm[2] - z];
  const lengthSq = dx ** 2 + dy ** 2 + dz ** 2;
  frameOriginXyzKm(home.frameId, frameOrigin);
  return allBodyDefs().every(body => {
    const [bx, by, bz] = body.positionKm;
    const rx = bx - frameOrigin.x - x;
    const ry = by - frameOrigin.y - y;
    const rz = bz - frameOrigin.z - z;
    const along = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (rx * dx + ry * dy + rz * dz) / lengthSq));
    const clearanceKm = body.radiusKm + REPLICATION_TUNING.minBodyAltitudeKm + ENDPOINT_MARGIN_KM;
    return (rx - dx * along) ** 2 + (ry - dy * along) ** 2 + (rz - dz * along) ** 2 >= clearanceKm ** 2;
  });
}

function makeRoute(pathKm: number, fieldName: string | null): DroneRoute {
  const profile = fieldName ? "field" : "local";
  const legSeconds = droneLegSeconds(pathKm, profile);
  const peak = profile === "field" && pathKm > FIELD_START_KM
    ? fieldPeakKmps(pathKm) * minimumDroneFlightS(pathKm, "field") / legSeconds
    : localDronePeakKmps(pathKm, legSeconds);
  const returnFuelAtDryKg = 2 * peak * DRONE_FUEL_PER_KMPS;
  const { roundTripFuelKg } = planDroneFuel({ returnFuelAtDryKg }, 0, 0);
  return { pathKm, legSeconds, profile, fieldName, returnFuelAtDryKg, roundTripFuelKg };
}

/** Longer deliveries must fit entirely inside one convex field in their shared frame. */
export function checkDroneRoute(home: Position, destination: Position): RouteCheck {
  if (home.frameId !== destination.frameId) return { route: null, reason: "different_frame" };
  const pathKm = depotDistanceKm(home, destination);
  const match = fields.find(({ field, shape }) => {
    const frameId = field.anchorBody ?? SYSTEM_FRAME_ID;
    const anchor = field.anchorBody ? field.anchorOffsetKm : field.anchorKm;
    if (!anchor || frameId !== home.frameId) return false;
    const [x, y, z] = anchor;
    const a = home.positionKm, b = destination.positionKm;
    return shape.isInsideKm(a[0] - x, a[1] - y, a[2] - z) && shape.isInsideKm(b[0] - x, b[1] - y, b[2] - z);
  });
  if (!Number.isFinite(pathKm) || (!match && pathKm > T.maxLocalRouteKm)) return { route: null, reason: "out_of_field" };
  if (!clearsBodies(home, destination)) return { route: null, reason: "blocked" };
  const route = makeRoute(pathKm, match?.field.name ?? null);
  return route.roundTripFuelKg <= T.droneTankKg ? { route, reason: null } : { route: null, reason: "tank" };
}

export function estimateDroneRoute(home: Position, destination: Position): DroneRoute | null {
  return checkDroneRoute(home, destination).route;
}

export function estimateDroneExtractionRoute(home: Position, source: IndustrySource, depots: readonly DepotRecord[]): DroneRoute | null {
  if (!canExtractAt(home, source.id)) return null;
  return estimateDroneWorkRoute(home, prospectWorksite(source, depots));
}

export function estimateDroneWorkRoute(home: Position, target: Position): DroneRoute | null {
  if (home.frameId !== target.frameId) return null;
  const pathKm = depotDistanceKm(home, target);
  return pathKm <= T.extractionRangeKm && clearsBodies(home, target) ? makeRoute(pathKm, null) : null;
}

/** The local half-space above each body's clearance sphere contains the whole triangle,
 * including any abort point on the planned segment and the straight path back home. */
export function clearsMiningCorridor(home: Position, from: Position, to: Position): boolean {
  if (home.frameId !== from.frameId || home.frameId !== to.frameId) return false;
  frameOriginXyzKm(home.frameId, frameOrigin);
  const [x, y, z] = home.positionKm;
  const a = from.positionKm, b = to.positionKm;
  return allBodyDefs().every(body => {
    const rx = frameOrigin.x + x - body.positionKm[0];
    const ry = frameOrigin.y + y - body.positionKm[1];
    const rz = frameOrigin.z + z - body.positionKm[2];
    const distance = Math.hypot(rx, ry, rz);
    const margin = distance - (body.radiusKm + REPLICATION_TUNING.minBodyAltitudeKm);
    const aProjection = (rx * (a[0] - x) + ry * (a[1] - y) + rz * (a[2] - z)) / distance;
    const bProjection = (rx * (b[0] - x) + ry * (b[1] - y) + rz * (b[2] - z)) / distance;
    return margin >= 0 && Math.min(aProjection, bProjection) >= -margin;
  });
}
