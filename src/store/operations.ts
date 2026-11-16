import { sampleCollectors } from "@/save/activeSave";
import { getLocalPlayerId } from "@/save/playerId";
import type { OperationOutcome, WorldOperation } from "@/sim/world/commands";
import { worldAuthority } from "@/sim/world/worldAuthority";

export { newOpId } from "@/sim/world/worldAuthority";

/**
 * Submit as the local player; `onSettled` runs once with the final outcome (now for the local
 * authority, later for a pending remote one). Grants and feedback belong in `onSettled`.
 */
export function runOperation(op: WorldOperation, onSettled?: (o: OperationOutcome) => void): OperationOutcome {
  let unsubscribe: (() => void) | null = null;
  // Live sampled values (fuel, heat, batch, hull, pose) into the record the reducer validates.
  sampleCollectors();
  const first = worldAuthority.submit(op, getLocalPlayerId());
  if (first.status !== "pending") {
    onSettled?.(first);
    return first;
  }
  unsubscribe = worldAuthority.subscribe((e) => {
    if (e.type !== "op.settled" || e.outcome.opId !== op.opId || e.outcome.status === "pending") return;
    unsubscribe?.();
    onSettled?.(e.outcome);
  });
  return first;
}

export function describeRejection(o: Extract<OperationOutcome, { status: "rejected" }>): string {
  switch (o.reason) {
    case "materials":
      return `Missing: ${Object.entries(o.missing ?? {}).map(([k, n]) => `${n} ${k}`).join(", ")}`;
    case "locked":
      return "Blueprint not researched";
    case "owned":
      return "Already owned";
    case "stack_full":
      return "Stack is full";
    case "assay":
      return `Need ${o.missing?.assaySamples ?? "more"} more assay samples`;
    case "busy":
      return "Research already in progress";
    case "prerequisites":
      return "Prerequisites not met";
    case "dead":
      return "Ship destroyed";
    case "no_capacity":
      return "No room aboard";
    case "tank_full":
      return "Tank is full";
    case "full_hull":
      return "Hull is intact";
    default:
      return o.reason.replace(/_/g, " ");
  }
}
