import type { PlayerId, ShipPose, Vec3Tuple } from "@/save/types";
import type { GiftKind, Transfer } from "@/sim/world/commands";

export interface DepotRecord extends ShipPose {
  id: string;
  name: string;
  by: PlayerId;
  refinery: boolean;
  storage: Transfer;
  refineProgressS: number;
}

export interface DroneJob {
  kind: "extract" | "haul" | "mine";
  targetId: string;
  /** Fuel-only haul to a replication tank. Omitted for depots and prospects. */
  targetKind?: "point";
  /** Accepted resources, in selection order. Ordinary propellant is "propellant". */
  priorities: string[];
  /** Any selected class or any selected yielded resource qualifies the entire rock. */
  mineFilter?: DroneMineFilter;
  /** Ordinary fuel, kg, left in the home tank after departure, beyond the funded round trip. */
  reserveKg: number;
  /** Maximum of each selected resource at the receiving depot, in units or kg. */
  stopAt: number;
  enabled: boolean;
}

export type DroneMineFilter = { mode: "all" } | { mode: "class" | "resource"; ids: string[] };

/** Pausing is always safe during flight. Haul priorities are ordered, mining filters are sets. */
export function sameDroneAssignment(a: DroneJob | null, b: DroneJob | null): boolean {
  if (!a || !b) return a === b;
  const left = a.mineFilter, right = b.mineFilter;
  const sameFilter = left?.mode === right?.mode && (!left || left.mode === "all" ||
    (right && right.mode !== "all" && left.ids.length === right.ids.length && left.ids.every(id => right.ids.includes(id))));
  return !!sameFilter && a.kind === b.kind && a.targetId === b.targetId && a.targetKind === b.targetKind &&
    a.reserveKg === b.reserveKg && a.stopAt === b.stopAt &&
    a.priorities.length === b.priorities.length && a.priorities.every((id, i) => id === b.priorities[i]);
}

export interface DroneRockId {
  fieldId: string;
  chunkKey: string;
  instanceId: number;
}

export interface DroneRockTarget extends DroneRockId {
  frameId: string;
  positionKm: Vec3Tuple;
  radiusM: number;
  workSeconds: number;
}

export type DronePhase = "idle" | "outbound" | "working" | "returning";
export const DRONE_STATUSES = [
  "unassigned", "paused", "needs_fuel", "source_out_of_range", "destination_full", "no_cargo",
  "route_out_of_range", "extracting", "delivering", "returning", "unload_blocked", "departing",
  "searching", "no_matching_rock", "mining",
] as const;
export type DroneStatus = (typeof DRONE_STATUSES)[number];
export type DroneFlightProfile = "local" | "field";

export interface DroneFlight {
  profile: DroneFlightProfile;
  /** Base return burn before adding the actual payload mass. */
  returnFuelAtDryKg: number;
  /** Largest amount of hydrates already funded for the return. */
  extractUnits?: number;
  rock?: DroneRockTarget;
}

export interface DroneWaypoint {
  frameId: string;
  positionKm: Vec3Tuple;
  /** Fraction along the outbound path at the waypoint. */
  fraction: number;
}

export interface DroneRecord {
  id: string;
  homeId: string;
  job: DroneJob | null;
  phase: DronePhase;
  status: DroneStatus;
  remainingS: number;
  durationS: number;
  /** Propulsion fuel held for the return, or unused fuel to unload at home. */
  fuelKg: number;
  /** Older funded trips keep their original schedule and fuel accounting. */
  flight?: DroneFlight | null;
  returnS: number;
  /** Retained for funded routes written before local drone routing. */
  via: DroneWaypoint | null;
  cargo: Transfer;
}

export interface SourceStock {
  available: number;
  replenishProgressS: number;
}

export interface IndustryState {
  depots: DepotRecord[];
  drones: DroneRecord[];
  sources: Record<string, SourceStock>;
  /** Ordinary propellant by installed replication point ID. An installed tank can hold zero. */
  pointTanks: Record<string, number>;
  /** Active-time remainder under one second. No calendar or wall-clock timestamp is persisted. */
  remainderS: number;
}

/** Changed records only. No records can be deleted by the M5 operations. */
export interface IndustryDelta {
  depots: DepotRecord[];
  drones: DroneRecord[];
  sources: Record<string, SourceStock>;
  /** Deplete the shared asteroid and change drone cargo in the same published update. */
  mined?: DroneRockId[];
  pointTanks?: Record<string, number>;
}

export type IndustryOperation =
  | ({ type: "depot.place"; opId: string; name: string } & ShipPose)
  | { type: "depot.rename"; opId: string; depotId: string; name: string }
  | { type: "depot.transfer"; opId: string; depotId: string; direction: "deposit" | "withdraw"; kind: GiftKind; itemId: string; amount: number }
  | { type: "depot.fabricate"; opId: string; depotId: string; recipeId: string }
  | { type: "replication.tank.install"; opId: string; pointId: string }
  | { type: "replication.tank.transfer"; opId: string; pointId: string; direction: "deposit" | "withdraw"; amount: number }
  | { type: "drone.configure"; opId: string; droneId: string; job: DroneJob; onlyIfUnassigned?: true };

export type IndustryResult =
  | { type: "depot.place"; depotId: string }
  | { type: "depot.rename"; depotId: string; name: string }
  | { type: "depot.transfer"; depotId: string; direction: "deposit" | "withdraw"; kind: GiftKind; itemId: string; amount: number }
  | { type: "depot.fabricate"; depotId: string; recipeId: string; droneId?: string }
  | { type: "replication.tank.install"; pointId: string }
  | { type: "replication.tank.transfer"; pointId: string; direction: "deposit" | "withdraw"; amount: number }
  | { type: "drone.configure"; droneId: string };

export const emptyIndustry = (): IndustryState => ({ depots: [], drones: [], sources: {}, pointTanks: {}, remainderS: 0 });
export const emptyStorage = (): Transfer => ({ items: {}, consumables: {}, fuelKg: 0 });
