import type { ShipPose, Vec3Tuple } from "@/save/types";
import { INDUSTRY_TUNING as T } from "./catalog";
import { droneFlightProgress, droneLegSeconds, DRONE_FUEL_PER_KMPS, localDronePeakKmps, planDroneReturnFuel } from "./route";
import type { DroneMiningLeg, DroneMiningSortie, DroneRecord, DroneRockTarget } from "./types";

const A = T.accelerationKmPerS2;
const MAX_BURN = T.cruiseKmPerS * DRONE_FUEL_PER_KMPS;
const FULL_HOLD_KG = T.cargoUnitMassKg * T.loadUnits;
// Carry enough for one capped local leg per cargo unit plus a turn and the flight home.
export const miningTankKg = Math.min(T.droneTankKg,
  Math.ceil(planDroneReturnFuel(MAX_BURN * (2 * T.loadUnits + 3), FULL_HOLD_KG + T.droneTankKg)));

export function miningBerthPosition(home: ShipPose, lane: number): Vec3Tuple {
  const [qx, qy, qz, qw] = home.quaternion;
  const x = lane * 0.008, y = 0.01, z = -0.012;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  const p = home.positionKm;
  return [
    p[0] + x + qw * tx + qy * tz - qz * ty,
    p[1] + y + qw * ty + qz * tx - qx * tz,
    p[2] + z + qw * tz + qx * ty - qy * tx,
  ];
}

export function miningApproachPosition(fromKm: Vec3Tuple, rock: DroneRockTarget, lane: number): Vec3Tuple {
  const p = rock.positionKm;
  const dx = fromKm[0] - p[0], dy = fromKm[1] - p[1], dz = fromKm[2] - p[2];
  const distance = Math.hypot(dx, dy, dz);
  if (distance === 0) return [p[0], p[1] + (rock.radiusM + 14) / 1000, p[2]];
  const along = Math.min(distance, (rock.radiusM + 14) / 1000) / distance;
  const lateral = Math.hypot(dz, dx);
  const side = lane * 0.005;
  return [
    p[0] + dx * along + (lateral > 1e-6 ? side * dz / lateral : side),
    p[1] + dy * along,
    p[2] + dz * along - (lateral > 1e-6 ? side * dx / lateral : 0),
  ];
}

export function miningDistanceKm(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function miningReturnFuelAtRestKg(homeKm: Vec3Tuple, fromKm: Vec3Tuple, cargoKg: number, fuelKg: number): number {
  const km = miningDistanceKm(homeKm, fromKm);
  return planDroneReturnFuel(2 * localDronePeakKmps(km, droneLegSeconds(km)) * DRONE_FUEL_PER_KMPS, cargoKg + fuelKg);
}

function localSpeed(km: number, elapsedS: number, durationS: number): number {
  return Math.max(0, Math.min(A * elapsedS, localDronePeakKmps(km, durationS), A * (durationS - elapsedS)));
}

function stoppedFrom(leg: DroneMiningLeg, d: number): number {
  return leg.fromKm[d] + (leg.brake ? leg.brake.velocityKmps[d] * leg.brake.seconds / 2 : 0);
}

/** Evaluate the same local curve that funds the leg. Output is in the home inertial frame. */
export function miningLegPosition(leg: DroneMiningLeg, elapsedS: number, durationS: number, out: Vec3Tuple): Vec3Tuple {
  const t = Math.max(0, Math.min(durationS, elapsedS));
  const brakeS = leg.brake?.seconds ?? 0;
  if (leg.brake && t < brakeS) {
    const scale = t * (1 - t / (2 * brakeS));
    for (let i = 0; i < 3; i++) out[i] = leg.fromKm[i] + leg.brake.velocityKmps[i] * scale;
    return out;
  }
  const x = stoppedFrom(leg, 0), y = stoppedFrom(leg, 1), z = stoppedFrom(leg, 2);
  const dx = leg.toKm[0] - x, dy = leg.toKm[1] - y, dz = leg.toKm[2] - z;
  const progress = droneFlightProgress(Math.hypot(dx, dy, dz), t - brakeS, durationS - brakeS);
  out[0] = x + dx * progress;
  out[1] = y + dy * progress;
  out[2] = z + dz * progress;
  return out;
}

export function miningLegVelocity(leg: DroneMiningLeg, elapsedS: number, durationS: number, out: Vec3Tuple): Vec3Tuple {
  const t = Math.max(0, Math.min(durationS, elapsedS));
  const brakeS = leg.brake?.seconds ?? 0;
  if (leg.brake && t < brakeS) {
    const scale = 1 - t / brakeS;
    for (let i = 0; i < 3; i++) out[i] = leg.brake.velocityKmps[i] * scale;
    return out;
  }
  const dx = leg.toKm[0] - stoppedFrom(leg, 0), dy = leg.toKm[1] - stoppedFrom(leg, 1), dz = leg.toKm[2] - stoppedFrom(leg, 2);
  const km = Math.hypot(dx, dy, dz);
  const scale = km ? localSpeed(km, t - brakeS, durationS - brakeS) / km : 0;
  out[0] = dx * scale;
  out[1] = dy * scale;
  out[2] = dz * scale;
  return out;
}

export function planMiningHop(homeKm: Vec3Tuple, fromKm: Vec3Tuple, toKm: Vec3Tuple, fuelKg: number, cargoKg: number): {
  leg: DroneMiningLeg; durationS: number; returnS: number; loadUnits: number;
} {
  const km = miningDistanceKm(fromKm, toKm);
  const durationS = droneLegSeconds(km);
  const peak = localDronePeakKmps(km, durationS);
  const burnKg = planDroneReturnFuel(2 * peak * DRONE_FUEL_PER_KMPS, cargoKg + fuelKg);
  // With the standoff/berth triangle clear, even an immediate turn and return costs
  // at most the leg's peak-speed brake plus a return from the farthest point.
  const toHomeKm = miningDistanceKm(toKm, homeKm);
  const farthestKm = Math.max(miningDistanceKm(fromKm, homeKm), toHomeKm);
  const returnPeak = Math.min(T.cruiseKmPerS, Math.sqrt(A * farthestKm));
  const base = (peak + 2 * returnPeak) * DRONE_FUEL_PER_KMPS;
  const roomKg = base > 0 ? T.droneDryMassKg * ((fuelKg - burnKg) / base - 1) - cargoKg - fuelKg : Infinity;
  const loadUnits = Math.max(0, Math.min(T.loadUnits, Math.floor(roomKg / T.cargoUnitMassKg + 1e-9)));
  return { leg: { fromKm, toKm, burnKg }, durationS, returnS: droneLegSeconds(toHomeKm), loadUnits };
}

/** Existing records funded one empty departure and a loaded return. Its unspent outward
 * budget still covers the braking portion if a recall cuts that first leg short. */
function legacySortie(drone: DroneRecord, home: ShipPose, lane: 1 | -1): DroneMiningSortie | null {
  const rock = drone.flight?.rock;
  if (!rock) return null;
  const homeKm = miningBerthPosition(home, lane);
  const burnKg = planDroneReturnFuel(drone.flight!.returnFuelAtDryKg, drone.fuelKg);
  return { homeKm, lane, leg: { fromKm: homeKm, toKm: miningApproachPosition(homeKm, rock, lane), burnKg } };
}

export function beginMiningReturn(
  drone: DroneRecord, home: ShipPose, lane: 1 | -1, cargoKg: number, fractionS = 0,
): DroneRecord {
  if (drone.phase === "returning" || drone.phase === "idle") return drone;
  const sortie = drone.sortie ?? legacySortie(drone, home, lane);
  if (!sortie) return drone;
  const { leg, homeKm } = sortie;
  const underway = drone.phase === "outbound";
  const elapsedS = Math.min(drone.durationS, drone.durationS - drone.remainingS + fractionS);
  const position = underway ? miningLegPosition(leg, elapsedS, drone.durationS, [0, 0, 0]) : leg.toKm;
  const velocity = underway ? miningLegVelocity(leg, elapsedS, drone.durationS, [0, 0, 0]) : [0, 0, 0] as Vec3Tuple;
  const speed = Math.hypot(...velocity);
  let fuelKg = drone.fuelKg;
  if (underway) {
    const peak = localDronePeakKmps(miningDistanceKm(leg.fromKm, leg.toKm), drone.durationS);
    if (peak > 0) {
      const spent = elapsedS <= drone.durationS - peak / A ? speed : 2 * peak - speed;
      fuelKg += leg.burnKg * (1 - spent / (2 * peak));
    }
  }
  const brakeS = speed / A;
  const stop: Vec3Tuple = [position[0] + velocity[0] * brakeS / 2,
    position[1] + velocity[1] * brakeS / 2, position[2] + velocity[2] * brakeS / 2];
  const km = miningDistanceKm(stop, homeKm);
  const durationS = Math.ceil(brakeS + droneLegSeconds(km));
  const burnKg = planDroneReturnFuel((speed + 2 * localDronePeakKmps(km, durationS - brakeS)) * DRONE_FUEL_PER_KMPS, cargoKg + fuelKg);
  // A pre-sortie save may have less reserve than the new model. Keep its already-funded
  // one-leg work/return path rather than launching an unfunded diversion.
  if (burnKg > fuelKg + 1e-9) return drone;
  return { ...drone, phase: "returning", status: "returning", durationS, remainingS: durationS,
    fuelKg: Math.max(0, fuelKg - burnKg), returnS: durationS, via: null,
    sortie: { homeKm, lane, leg: { fromKm: position, toKm: homeKm, burnKg,
      ...(brakeS > 0 && { brake: { velocityKmps: velocity, seconds: brakeS } }) } },
    flight: { profile: "local", returnFuelAtDryKg: 0 } };
}
