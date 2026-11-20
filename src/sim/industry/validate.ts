import type { QuatTuple, ReplicationPoint, Vec3Tuple } from "@/save/types";
import { isFrameId } from "@/sim/frames";
import { cleanPointName } from "@/sim/replication/points";
import type { Transfer } from "@/sim/world/commands";
import { getIndustrySource, INDUSTRY_TUNING as T, POINT_TANK_CAPACITY_KG } from "./catalog";
import { decodeDroneJob } from "./reducer";
import { finiteMiningJob } from "./mining";
import { maxDroneLegSeconds } from "./route";
import { DRONE_STATUSES, emptyIndustry, type DepotRecord, type DroneFlight, type DroneRecord, type DroneRockTarget, type DroneWaypoint, type IndustryState } from "./types";

type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, max: number): number => typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, v)) : 0;
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 160;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const position = (v: unknown): v is Vec3Tuple =>
  Array.isArray(v) && v.length === 3 && v.every(x => finite(x) && Math.abs(x) <= 1e12);
const safeKey = (v: string): boolean => id(v) && !Object.hasOwn(Object.prototype, v);

function storage(v: unknown, capacity: number, tankKg: number): Transfer {
  const items: Transfer["items"] = {};
  const consumables: Transfer["consumables"] = {};
  if (!obj(v)) return { items, consumables, fuelKg: 0 };
  let free = capacity;
  const fill = (from: unknown, into: Record<string, number>) => {
    if (!obj(from)) return;
    for (const key of Object.keys(from)) {
      if (!safeKey(key)) continue;
      const amount = Math.floor(num(from[key], free));
      if (amount > 0) into[key] = amount;
      free -= amount;
    }
  };
  fill(v.items, items);
  fill(v.consumables, consumables);
  return { items, consumables, fuelKg: num(v.fuelKg, tankKg) };
}

function depot(v: unknown): DepotRecord | null {
  if (!obj(v) || !id(v.id) || !isFrameId(v.frameId) ||
      !position(v.positionKm) ||
      !Array.isArray(v.quaternion) || v.quaternion.length !== 4 || !v.quaternion.every(finite) ||
      Math.abs(Math.hypot(...v.quaternion) - 1) > 1e-3) return null;
  return {
    id: v.id, frameId: v.frameId, positionKm: [...v.positionKm] as Vec3Tuple, quaternion: [...v.quaternion] as QuatTuple,
    by: id(v.by) ? v.by : "", name: cleanPointName(v.name, "Depot"), refinery: v.refinery === true,
    storage: storage(v.storage, T.cargoCapacity, T.fuelCapacityKg), refineProgressS: Math.floor(num(v.refineProgressS, T.refineSeconds - 1)),
  };
}

// Existing funded trips keep the original countdown, waypoint, payload and return escrow.
const maxLegS = maxDroneLegSeconds();
const maxLegacyLegKg = 41;

function rockTarget(v: unknown): DroneRockTarget | null {
  if (!obj(v) || !id(v.fieldId) || !id(v.chunkKey) || !v.chunkKey.startsWith(v.fieldId + ":") ||
      !finite(v.instanceId) || !Number.isInteger(v.instanceId) || v.instanceId < 0 || v.instanceId > 0xffffffff ||
      !isFrameId(v.frameId) || !position(v.positionKm) || !finite(v.radiusM) || v.radiusM <= 0 || v.radiusM > 10_000 ||
      !finite(v.workSeconds) || !Number.isInteger(v.workSeconds) || v.workSeconds < 1 || v.workSeconds > 60) return null;
  return { fieldId: v.fieldId, chunkKey: v.chunkKey, instanceId: v.instanceId, frameId: v.frameId,
    positionKm: [...v.positionKm], radiusM: v.radiusM, workSeconds: v.workSeconds };
}

function fundedFlight(v: unknown): DroneFlight | null | undefined {
  if (v === null) return null;
  if (!obj(v) || (v.profile !== "local" && v.profile !== "field") ||
      !finite(v.returnFuelAtDryKg) || v.returnFuelAtDryKg < 0 || v.returnFuelAtDryKg > T.droneTankKg) return undefined;
  const extractUnits = finite(v.extractUnits) ? Math.floor(num(v.extractUnits, T.extractUnits)) : undefined;
  const rock = rockTarget(v.rock);
  return { profile: v.profile, returnFuelAtDryKg: v.returnFuelAtDryKg,
    ...(extractUnits === undefined ? {} : { extractUnits }), ...(rock && { rock }) };
}

function waypoint(v: unknown): DroneWaypoint | null {
  if (!obj(v) || !isFrameId(v.frameId) || !position(v.positionKm) || !finite(v.fraction) || v.fraction <= 0 || v.fraction >= 1) return null;
  return { frameId: v.frameId, positionKm: [...v.positionKm], fraction: v.fraction };
}

function drone(v: unknown, depots: Map<string, DepotRecord>, pointTanks: IndustryState["pointTanks"]): DroneRecord | null {
  if (!obj(v) || !id(v.id) || !id(v.homeId) || !depots.has(v.homeId)) return null;
  const configured = decodeDroneJob(v.job);
  const validDelivery = configured?.targetKind === "point" ? Object.hasOwn(pointTanks, configured.targetId)
    : !!configured && depots.has(configured.targetId) && v.homeId !== configured.targetId;
  const returnS = num(v.returnS, maxLegS);
  const durationS = num(v.durationS, maxLegS);
  const phase = returnS >= T.minLegSeconds && durationS > 0 &&
      (v.phase === "outbound" || v.phase === "working" || v.phase === "returning")
    ? v.phase : "idle";
  const valid = configured && (configured.kind !== "haul" || validDelivery) ? configured : null;
  const job = valid && phase === "idle" ? finiteMiningJob(valid) : valid;
  const restored = DRONE_STATUSES.find(s => s === v.status) ?? (job ? "paused" : "unassigned");
  const status = !job && phase !== "idle" && phase !== "returning" ? "returning" : restored;
  const flight = fundedFlight(v.flight);
  return {
    id: v.id, homeId: v.homeId, job, phase, status, returnS, durationS, via: waypoint(v.via),
    ...(flight === undefined ? {} : { flight }),
    remainingS: num(v.remainingS, durationS), fuelKg: num(v.fuelKg, flight ? T.droneTankKg : maxLegacyLegKg),
    cargo: storage(v.cargo, Math.max(T.loadUnits, T.extractUnits), T.loadFuelKg),
  };
}

export function sanitizeIndustry(v: unknown, points: readonly ReplicationPoint[] = []): IndustryState {
  if (!obj(v)) return emptyIndustry();
  const depots = new Map<string, DepotRecord>();
  for (const value of Array.isArray(v.depots) ? v.depots.slice(0, T.maxDepots) : []) {
    const next = depot(value);
    if (next && !depots.has(next.id)) depots.set(next.id, next);
  }
  const pointTanks: IndustryState["pointTanks"] = {};
  const inputTanks = v.pointTanks;
  if (obj(inputTanks)) {
    for (const point of points) {
      if (!point.starter && safeKey(point.id) && Object.hasOwn(inputTanks, point.id) && finite(inputTanks[point.id])) {
        pointTanks[point.id] = num(inputTanks[point.id], POINT_TANK_CAPACITY_KG);
      }
    }
  }
  const drones: DroneRecord[] = [];
  const droneIds = new Set<string>();
  const counts = new Map<string, number>();
  for (const value of Array.isArray(v.drones) ? v.drones.slice(0, T.maxDepots * T.dronesPerDepot) : []) {
    const next = drone(value, depots, pointTanks);
    if (!next || droneIds.has(next.id)) continue;
    const count = counts.get(next.homeId) ?? 0;
    if (count >= T.dronesPerDepot) continue;
    counts.set(next.homeId, count + 1);
    droneIds.add(next.id);
    drones.push(next);
  }
  const sources: IndustryState["sources"] = {};
  if (obj(v.sources)) {
    for (const [key, stock] of Object.entries(v.sources)) {
      if (getIndustrySource(key) && obj(stock)) {
        sources[key] = {
          available: Math.floor(num(stock.available, T.sourceCapacity)),
          replenishProgressS: Math.floor(num(stock.replenishProgressS, T.sourceSecondsPerUnit - 1)),
        };
      }
    }
  }
  return { depots: Array.from(depots.values()), drones, sources, pointTanks, remainderS: num(v.remainderS, 1 - Number.EPSILON) };
}
