import type { ShipPose } from "@/save/types";
import { allBodyDefs } from "@/sim/celestialConstants";
import { frameOriginXyzKm } from "@/sim/frames";
import { REPLICATION_TUNING } from "@/sim/replication/points";
import { INDUSTRY_TUNING as T, type IndustrySource } from "./catalog";
import { canExtractAt, depotDistanceKm } from "./placement";
import { prospectWorksite } from "./prospects";
import type { DepotRecord } from "./types";

type Position = Pick<ShipPose, "frameId" | "positionKm">;

export interface DroneRoute {
  pathKm: number;
  legSeconds: number;
  roundTripFuelKg: number;
}

// Allow for the rendered berths and the extractor's worksite approach offset.
const ENDPOINT_MARGIN_KM = 0.05;
const frameOrigin = { x: 0, y: 0, z: 0 };
const ACCEL = T.accelerationKmPerS2;
const CRUISE = T.cruiseKmPerS;
const ACCEL_DISTANCE_KM = CRUISE * CRUISE / ACCEL;

/** Rest-to-rest time under the ordinary thruster limits. Short legs never reach cruise. */
export function minimumDroneFlightS(km: number): number {
  return km <= ACCEL_DISTANCE_KM
    ? 2 * Math.sqrt(km / ACCEL)
    : km / CRUISE + CRUISE / ACCEL;
}

export const droneLegSeconds = (km: number): number =>
  Math.max(T.minLegSeconds, Math.ceil(minimumDroneFlightS(km + ENDPOINT_MARGIN_KM)));

/** Distance fraction at the given time. A whole-second scheduled leg uses a slightly lower
 * cruise speed or a shorter burn to arrive at rest exactly on the countdown boundary. */
export function droneFlightProgress(km: number, elapsedS: number, durationS: number): number {
  if (km <= 0 || elapsedS >= durationS) return 1;
  if (elapsedS <= 0) return 0;
  const peak = 2 * km / (durationS + Math.sqrt(Math.max(0, durationS ** 2 - 4 * km / ACCEL)));
  const burnS = peak / ACCEL;
  const remainingS = durationS - elapsedS;
  if (elapsedS <= burnS) return 0.5 * ACCEL * elapsedS ** 2 / km;
  if (remainingS <= burnS) return 1 - 0.5 * ACCEL * remainingS ** 2 / km;
  return peak * (elapsedS - burnS / 2) / km;
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

/** Local thrusters support short, direct routes in one inertial frame. */
export function estimateDroneRoute(home: Position, destination: Position): DroneRoute | null {
  if (home.frameId !== destination.frameId) return null;
  const pathKm = depotDistanceKm(home, destination);
  if (!Number.isFinite(pathKm) || pathKm > T.maxRouteKm || !clearsBodies(home, destination)) return null;
  return { pathKm, legSeconds: droneLegSeconds(pathKm), roundTripFuelKg: 2 * Math.ceil(1 + pathKm / T.legFuelDistanceKm) };
}

export function estimateDroneExtractionRoute(home: Position, source: IndustrySource, depots: readonly DepotRecord[]): DroneRoute | null {
  return canExtractAt(home, source.id) ? estimateDroneRoute(home, prospectWorksite(source, depots)) : null;
}
