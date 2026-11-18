import type { PlayerId, PlayerState, Vec3Tuple, WreckRecord } from "@/save/types";

export type AsteroidDestroyCause = "mined" | "collision";

/**
 * Typed domain operations. `opId` is stable per intent: a retry reuses it, and an accepted id
 * has no second effect (receipt log + durable object state).
 */
export type WorldOperation =
  | { type: "asteroid.destroy"; opId: string; fieldId: string; chunkKey: string; instanceId: number; cause: AsteroidDestroyCause }
  /** `yield` / `assaySamples` are the miner's computed reward; the authority bounds them by capacity. */
  | { type: "asteroid.mine"; opId: string; fieldId: string; chunkKey: string; instanceId: number; yield: Record<string, number>; assaySamples: number }
  | { type: "item.craft"; opId: string; itemId: string }
  | { type: "research.start"; opId: string; nodeId: string }
  /** `elapsedS`: the player's executed research time (the old per-player timer, PR 1 only). */
  | { type: "research.complete"; opId: string; nodeId: string; elapsedS: number }
  /** Dev tools only: replace the world's completed research. */
  | { type: "research.devSet"; opId: string; nodeIds: string[] }
  /** Death and emergency abandonment share this: cargo, ordinary fuel and unconverted feedstock go to the wreck. */
  | { type: "ship.destroy"; opId: string; frameId: string; positionKm: Vec3Tuple; cause?: "impact" | "abandon" }
  /** The recovery pose is committed with the respawn, so no flush can store alive-at-the-wreck. */
  | { type: "ship.respawn"; opId: string; frameId: string; positionKm: Vec3Tuple }
  | { type: "wreck.collect"; opId: string; wreckId: string }
  /** Reserve `units` of the recipe's feedstock from cargo into one onboard batch. */
  | { type: "processing.start"; opId: string; recipeId: string; units: number }
  /** Return the batch's unconverted feedstock; committed output stays in the tank. */
  | { type: "processing.cancel"; opId: string; batchId: string }
  /** `pct` whole percent points of max hull, paid in structural material. Not receipted. */
  | { type: "ship.repair"; opId: string; pct: number }
  | { type: "time.set"; opId: string; epochMs?: number; rate?: number };

export type OperationType = WorldOperation["type"];

export interface Transfer {
  items: Record<string, number>;
  consumables: Record<string, number>;
  fuelKg: number;
}

export type OperationResult =
  | { type: "asteroid.destroy" }
  | { type: "asteroid.mine"; granted: Record<string, number>; overflow: Record<string, number>; assaySamples: number }
  | { type: "item.craft"; itemId: string; spent: Record<string, number>; autoEquipped: boolean; hotbarIndex: number | null }
  | { type: "research.start"; nodeId: string; spentAssay: number }
  /** `refundedAssay` > 0 when another player had already completed the node. */
  | { type: "research.complete"; nodeId: string; unlockedItems: string[]; refundedAssay: number }
  | { type: "research.devSet"; count: number }
  | { type: "ship.destroy"; wreckId: string | null; dropped: Transfer; cause: "impact" | "abandon" }
  | { type: "ship.respawn"; health: number }
  | { type: "wreck.collect"; wreckId: string; taken: Transfer; removed: boolean }
  | { type: "processing.start"; batchId: string; inputId: string; units: number; outputKg: number }
  | { type: "processing.cancel"; batchId: string; refunded: Record<string, number>; committedKg: number }
  | { type: "ship.repair"; pct: number; spent: Record<string, number>; health: number }
  | { type: "time.set" };

export type RejectReason =
  | "invalid"
  | "unknown_player"
  | "dead"
  | "not_dead"
  | "already_done"
  | "not_found"
  | "unknown_item"
  | "locked"
  | "owned"
  | "stack_full"
  | "materials"
  | "busy"
  | "prerequisites"
  | "assay"
  | "not_active"
  | "incomplete"
  | "no_capacity"
  | "tank_full"
  | "full_hull";

/**
 * A remote authority (M4) answers `pending` and settles later through an `op.settled` event:
 * grants and UI follow the settled outcome, never the act of submitting.
 */
export type OperationOutcome =
  | { status: "accepted"; opId: string; by: PlayerId; result: OperationResult }
  | { status: "rejected"; opId: string; by: PlayerId; reason: RejectReason; missing?: Record<string, number> }
  | { status: "duplicate"; opId: string; by: PlayerId }
  | { status: "pending"; opId: string; by: PlayerId };

export type WorldEvent =
  | { type: "asteroid.destroyed"; by: PlayerId; fieldId: string; chunkKey: string; instanceId: number; cause: AsteroidDestroyCause }
  | { type: "wreck.created"; by: PlayerId; wreck: WreckRecord }
  | { type: "wreck.changed"; by: PlayerId; wreck: WreckRecord }
  | { type: "wreck.removed"; by: PlayerId; wreckId: string }
  | { type: "research.changed"; by: PlayerId; completedNodes: readonly string[] }
  /** The listed slices of `playerId` were replaced by a committed operation. */
  | { type: "player.changed"; by: PlayerId; playerId: PlayerId; keys: readonly (keyof PlayerState)[] }
  /** Carries only the fields the command set: the live clock is ahead of the stored epoch. */
  | { type: "time.changed"; by: PlayerId; epochMs?: number; rate?: number }
  /** Last event of every submit, after the state events it caused. */
  | { type: "op.settled"; outcome: OperationOutcome };
