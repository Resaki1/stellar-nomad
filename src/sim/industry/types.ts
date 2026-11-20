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
  kind: "extract" | "haul";
  targetId: string;
  /** Accepted resources, in selection order. Ordinary propellant is "propellant". */
  priorities: string[];
  /** Ordinary fuel, kg, left in the home tank after departure, beyond the funded round trip. */
  reserveKg: number;
  /** Maximum of each selected resource at the receiving depot, in units or kg. */
  stopAt: number;
  enabled: boolean;
}

export type DronePhase = "idle" | "outbound" | "working" | "returning";
export const DRONE_STATUSES = [
  "unassigned", "paused", "needs_fuel", "source_out_of_range", "destination_full", "no_cargo",
  "route_out_of_range", "extracting", "delivering", "returning", "unload_blocked", "departing",
] as const;
export type DroneStatus = (typeof DRONE_STATUSES)[number];

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
  /** Escrow for the return leg, funded before departure. Separate from delivery cargo. */
  fuelKg: number;
  returnS: number;
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
  /** Active-time remainder under one second. No calendar or wall-clock timestamp is persisted. */
  remainderS: number;
}

/** Changed records only. No records can be deleted by the M5 operations. */
export interface IndustryDelta {
  depots: DepotRecord[];
  drones: DroneRecord[];
  sources: Record<string, SourceStock>;
}

export type IndustryOperation =
  | ({ type: "depot.place"; opId: string; name: string } & ShipPose)
  | { type: "depot.transfer"; opId: string; depotId: string; direction: "deposit" | "withdraw"; kind: GiftKind; itemId: string; amount: number }
  | { type: "depot.fabricate"; opId: string; depotId: string; recipeId: string }
  | { type: "drone.configure"; opId: string; droneId: string; job: DroneJob };

export type IndustryResult =
  | { type: "depot.place"; depotId: string }
  | { type: "depot.transfer"; depotId: string; direction: "deposit" | "withdraw"; kind: GiftKind; itemId: string; amount: number }
  | { type: "depot.fabricate"; depotId: string; recipeId: string; droneId?: string }
  | { type: "drone.configure"; droneId: string };

export const emptyIndustry = (): IndustryState => ({ depots: [], drones: [], sources: {}, remainderS: 0 });
export const emptyStorage = (): Transfer => ({ items: {}, consumables: {}, fuelKg: 0 });
