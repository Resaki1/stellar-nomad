import type { ShipPose } from "@/save/types";
import type { RejectReason } from "@/sim/world/commands";
import { checkPlacement, poseDistanceKm, type DestroyedLookup, type PlacementCheck } from "@/sim/replication/placement";
import { getIndustrySource, INDUSTRY_TUNING as T } from "./catalog";
import type { DepotRecord } from "./types";

type Position = Pick<ShipPose, "frameId" | "positionKm">;
const clearance: PlacementCheck = { refusal: null, bodyAltKm: 0, bodyId: null, rockClearM: 0 };

export function depotDistanceKm(a: Position, b: Position): number {
  if (a.frameId === b.frameId) return Math.hypot(a.positionKm[0] - b.positionKm[0], a.positionKm[1] - b.positionKm[1], a.positionKm[2] - b.positionKm[2]);
  return poseDistanceKm(a.frameId, a.positionKm, b.frameId, b.positionKm);
}

/** Exactly the same spatial clearance rules drive the preview and accepted placement. */
export function checkDepotPlacement(
  pose: ShipPose, ship: Position | null, kits: number, destroyed: DestroyedLookup | null,
  depots: readonly DepotRecord[], otherPositions: readonly Position[] = [],
): RejectReason | null {
  if (depots.length >= T.maxDepots) return "depot_limit";
  const { refusal } = checkPlacement(pose, ship, kits, destroyed, clearance);
  // A depot only needs its own clearance; a replication point checks an additional spawn offset.
  if (refusal && refusal !== "emergence_blocked") return refusal;
  if (ship && depotDistanceKm(pose, ship) < T.shipClearanceKm) return "near_ship";
  if (otherPositions.some(p => depotDistanceKm(pose, p) < T.shipClearanceKm)) return "near_ship";
  if (depots.some(d => depotDistanceKm(pose, d) < T.depotClearanceKm)) return "near_depot";
  return null;
}

export function depotBlocksPose(depots: readonly DepotRecord[], pose: Position, clearanceKm: number = T.shipClearanceKm): boolean {
  return depots.some(depot => depotDistanceKm(depot, pose) < clearanceKm);
}

export function canExtractAt(depot: Position, sourceId: string): boolean {
  const source = getIndustrySource(sourceId);
  return !!source && source.frameId === depot.frameId && depotDistanceKm(depot, source) <= source.rangeKm;
}
