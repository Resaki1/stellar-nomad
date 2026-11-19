import type { OperationOutcome } from "@/sim/world/commands";
import { describeRejection } from "@/store/operations";
import { getItemDef, materialName } from "@/data/content";

export function industryMessage(reason: string): string {
  switch (reason) {
    case "too_far": return "Fly within depot access range.";
    case "no_kit": return "Fabricate a depot kit first.";
    case "near_body": return "Aim farther from the surface.";
    case "near_rock": return "Aim away from nearby rocks.";
    case "near_depot": return "Aim farther from the nearest depot.";
    case "near_ship": return "Aim away from nearby ships.";
    case "depot_full": return "Depot storage is full. Withdraw stock to make room.";
    case "drone_limit": return "All drone bays are in use.";
    case "source_out_of_range": return "Choose a prospect within extraction range.";
    case "route_out_of_range": return "Choose a closer destination.";
    case "depot_limit": return "All depot slots in this world are in use.";
    case "emergence_blocked": return "Choose a clear approach.";
    case "invalid": return "Choose a clear location in the current flight region.";
    case "no_capacity": return "Ship cargo hold is full.";
    case "tank_full": return "The receiving fuel tank is full.";
    case "host_unavailable": return "Waiting for the host. Try again when reconnected.";
    case "busy": return "The drone is airborne. Stop after this trip, then edit its job.";
    case "dead": return "Recover your ship to use the depot.";
    default: return reason.replaceAll("_", " ");
  }
}

export function industryRejection(outcome: Extract<OperationOutcome, { status: "rejected" }>): string {
  if (outcome.reason === "materials" && outcome.missing) {
    const missing = Object.entries(outcome.missing).map(([id, amount]) =>
      id === "fuel" ? `${Number(amount.toFixed(2))} kg of propellant` : `${amount} ${getItemDef(id)?.name ?? materialName(id)}`,
    );
    return `Supply ${missing.join(", ")}.`;
  }
  const message = industryMessage(outcome.reason);
  return message === outcome.reason.replaceAll("_", " ") ? describeRejection(outcome) : message;
}
