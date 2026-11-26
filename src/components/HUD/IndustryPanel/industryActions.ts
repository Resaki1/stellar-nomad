import type { OperationOutcome, WorldOperation } from "@/sim/world/commands";
import { describeRejection } from "@/store/operations";
import { getItemDef, materialName } from "@/data/content";

export function industryMessage(reason: string): string {
  switch (reason) {
    case "too_far": return "Fly closer to the depot and try again.";
    case "no_kit": return "Build a depot kit first.";
    case "near_body": return "Aim farther from the surface.";
    case "near_rock": return "Aim away from nearby rocks.";
    case "near_depot": return "Aim farther from the nearest depot.";
    case "near_ship": return "Aim away from nearby ships.";
    case "moving": return "Brake to deploy.";
    case "depot_full": return "The depot cargo hold needs more room. Withdraw cargo first.";
    case "drone_limit": return "All drone bays are in use.";
    case "drone_assigned": return "This drone already has a job. Choose another drone for the request.";
    case "source_out_of_range": return "This depot can't reach that asteroid field. Choose a field within reach or deliver supplies to another depot.";
    case "route_out_of_range": return "The drone can't reach this destination. Choose another depot.";
    case "depot_limit": return "This world has reached its depot limit.";
    case "emergence_blocked": return "Choose a clear approach.";
    case "invalid": return "Choose a clear location in the current flight region.";
    case "no_capacity": return "Your ship's cargo hold needs more room. Deposit some cargo first.";
    case "tank_full": return "Your ship's fuel tank needs more room. Deposit some propellant first.";
    case "stack_full": return "Your ship is carrying its limit of this item.";
    case "not_found": return "This depot, drone or recipe is no longer available.";
    case "owned": return "This depot already has a refinery.";
    case "unknown_item": return "This item can't be transferred.";
    case "already_done": return "This action is already complete.";
    case "host_unavailable": return "Try again when you're connected to the host.";
    case "busy": return "The drone is flying. Stop after this trip, then edit its job.";
    case "dead": return "Recover your ship to use the depot.";
    default: return reason.replaceAll("_", " ");
  }
}

type Transfer = Pick<Extract<WorldOperation, { type: "depot.transfer" }>, "direction" | "kind">;

export function industryRejection(outcome: Extract<OperationOutcome, { status: "rejected" }>, transfer?: Transfer): string {
  if (outcome.reason === "depot_full" && transfer?.kind === "fuel") {
    return "The depot fuel tank needs more room. Withdraw propellant first.";
  }
  if (outcome.reason === "invalid" && transfer) return "Select an item and enter a whole number greater than zero.";
  if (outcome.reason === "materials" && outcome.missing) {
    const missing = Object.entries(outcome.missing).map(([id, amount]) =>
      id === "fuel" ? `${Number(amount.toFixed(2))} kg of propellant` : `${amount} ${getItemDef(id)?.name ?? materialName(id)}`,
    );
    if (transfer) {
      const source = transfer.direction === "deposit" ? "Your ship" : "The depot";
      return `${source} is short by ${missing.join(", ")}.`;
    }
    return `You need ${missing.join(", ")} more.`;
  }
  const message = industryMessage(outcome.reason);
  return message === outcome.reason.replaceAll("_", " ") ? describeRejection(outcome) : message;
}
