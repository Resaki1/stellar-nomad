import type { QuatTuple, Vec3Tuple } from "@/save/types";
import { isFrameId } from "@/sim/frames";
import { cleanPointName } from "@/sim/replication/points";
import type { Transfer } from "@/sim/world/commands";
import { getIndustrySource, INDUSTRY_TUNING as T } from "./catalog";
import { decodeDroneJob } from "./reducer";
import { droneLegSeconds } from "./route";
import { DRONE_STATUSES, emptyIndustry, type DepotRecord, type DroneRecord, type DroneWaypoint, type IndustryState } from "./types";

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
const maxLegS = Math.max(204, droneLegSeconds(T.maxRouteKm));
const maxLegKg = Math.max(41, Math.ceil(1 + T.maxRouteKm / T.legFuelDistanceKm));

function waypoint(v: unknown): DroneWaypoint | null {
  if (!obj(v) || !isFrameId(v.frameId) || !position(v.positionKm) || !finite(v.fraction) || v.fraction <= 0 || v.fraction >= 1) return null;
  return { frameId: v.frameId, positionKm: [...v.positionKm], fraction: v.fraction };
}

function drone(v: unknown, depots: Map<string, DepotRecord>): DroneRecord | null {
  if (!obj(v) || !id(v.id) || !id(v.homeId) || !depots.has(v.homeId)) return null;
  const configured = decodeDroneJob(v.job);
  const job = configured && (configured.kind === "extract" || depots.has(configured.targetId) && v.homeId !== configured.targetId) ? configured : null;
  const returnS = num(v.returnS, maxLegS);
  const durationS = num(v.durationS, maxLegS);
  const phase = returnS >= T.minLegSeconds && durationS > 0 &&
      (v.phase === "outbound" || v.phase === "working" || v.phase === "returning")
    ? v.phase : "idle";
  const restored = DRONE_STATUSES.find(s => s === v.status) ?? (job ? "paused" : "unassigned");
  const status = !job && phase !== "idle" && phase !== "returning" ? "returning" : restored;
  return {
    id: v.id, homeId: v.homeId, job, phase, status, returnS, durationS, via: waypoint(v.via),
    remainingS: num(v.remainingS, durationS), fuelKg: num(v.fuelKg, maxLegKg),
    cargo: storage(v.cargo, Math.max(T.loadUnits, T.extractUnits), T.loadFuelKg),
  };
}

export function sanitizeIndustry(v: unknown): IndustryState {
  if (!obj(v)) return emptyIndustry();
  const depots = new Map<string, DepotRecord>();
  for (const value of Array.isArray(v.depots) ? v.depots.slice(0, T.maxDepots) : []) {
    const next = depot(value);
    if (next && !depots.has(next.id)) depots.set(next.id, next);
  }
  const drones: DroneRecord[] = [];
  const droneIds = new Set<string>();
  const counts = new Map<string, number>();
  for (const value of Array.isArray(v.drones) ? v.drones.slice(0, T.maxDepots * T.dronesPerDepot) : []) {
    const next = drone(value, depots);
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
  return { depots: Array.from(depots.values()), drones, sources, remainderS: num(v.remainderS, 1 - Number.EPSILON) };
}
