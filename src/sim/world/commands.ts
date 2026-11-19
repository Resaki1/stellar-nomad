import type { PlayerId, PlayerState, QuatTuple, ReplicationPoint, Vec3Tuple, WreckRecord } from "@/save/types";
import type { RecoveryDestination } from "@/sim/replication/placement";

export type AsteroidDestroyCause = "mined" | "collision";

/**
 * Typed domain operations. `opId` is stable per intent: a retry reuses it, and an accepted id
 * has no second effect (receipt log + durable object state).
 */
export type WorldOperation =
  | { type: "asteroid.destroy"; opId: string; fieldId: string; chunkKey: string; instanceId: number; cause: AsteroidDestroyCause }
  /**
   * `yield` is the miner's preview; an authority with a mine resolver ignores it and re-derives the
   * reward. `beamS`: executed beam seconds (activity reference, checked by the host).
   */
  | { type: "asteroid.mine"; opId: string; fieldId: string; chunkKey: string; instanceId: number; yield?: Record<string, number>; beamS?: number }
  | { type: "item.craft"; opId: string; itemId: string }
  /**
   * Close inspection of a targeted rock. The claim (class, composition estimate, pose) is the
   * scanner's, from the same deterministic generator mining uses; an M4 remote authority re-derives it.
   */
  | {
      type: "survey.inspect"; opId: string; fieldId: string; chunkKey: string; instanceId: number;
      classId: string; radiusM: number; frameId: string; positionKm: Vec3Tuple; composition: Record<string, number>;
    }
  /** Unlock a research option: its evidence must be recorded and its analysis material aboard. */
  | { type: "research.unlock"; opId: string; nodeId: string }
  /** A client-detected safe trial (first batch, sustained beam, transit leg); recorded once. */
  | { type: "trial.record"; opId: string; trialId: string }
  /** Close inspection of an authored site within its inspection range. */
  | { type: "site.inspect"; opId: string; siteId: string }
  /** One-time recovery of an inspected site: its reward into cargo, its evidence into the world. */
  | { type: "site.recover"; opId: string; siteId: string }
  /** The player's own bookmark of a world source; `name: null` removes it. */
  | { type: "bookmark.set"; opId: string; sourceId: string; name: string | null }
  /** Equip an owned module (`itemId: null` empties the slot); refused if fuel or cargo would overflow. */
  | { type: "module.equip"; opId: string; slot: string; itemId: string | null }
  /** Dev tools only: replace the world's completed research. */
  | { type: "research.devSet"; opId: string; nodeIds: string[] }
  /** Death and emergency abandonment share this: cargo, ordinary fuel and unconverted feedstock go to the wreck. */
  | { type: "ship.destroy"; opId: string; frameId: string; positionKm: Vec3Tuple; cause?: "impact" | "abandon" }
  /**
   * Recovery: the authority resolves the destination (active point, revalidated; `starter` is the
   * explicit emergency fallback) and commits the pose with the alive state.
   */
  | { type: "ship.respawn"; opId: string; mode: "active" | "starter" }
  /** Consume one kit, create one point and make it this player's active point. */
  | { type: "replication.place"; opId: string; frameId: string; positionKm: Vec3Tuple; quaternion: QuatTuple; name: string }
  /** Make an existing point this player's active point; the ship must be near it. */
  | { type: "replication.activate"; opId: string; pointId: string }
  /** Back to the starter point; the deactivated point stays in the world. */
  | { type: "replication.deactivate"; opId: string }
  | { type: "replication.rename"; opId: string; pointId: string; name: string }
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
  | { type: "asteroid.mine"; granted: Record<string, number>; overflow: Record<string, number>; newFamilies: string[]; depletedSource: string | null }
  | { type: "item.craft"; itemId: string; spent: Record<string, number>; autoEquipped: boolean; hotbarIndex: number | null; newTrial: boolean }
  | { type: "survey.inspect"; sourceId: string; newFamilies: string[]; upgraded: string[]; evicted: string | null }
  | { type: "research.unlock"; nodeId: string; unlockedItems: string[]; spent: Record<string, number> }
  | { type: "trial.record"; trialId: string }
  | { type: "site.inspect"; siteId: string }
  | { type: "site.recover"; siteId: string; reward: Record<string, number> }
  | { type: "bookmark.set"; sourceId: string; name: string | null }
  | { type: "module.equip"; slot: string; itemId: string | null }
  | { type: "research.devSet"; count: number }
  | { type: "ship.destroy"; wreckId: string | null; dropped: Transfer; cause: "impact" | "abandon" }
  | { type: "ship.respawn"; health: number; destination: RecoveryDestination; protectedKg: number }
  | { type: "replication.place"; point: ReplicationPoint }
  | { type: "replication.activate"; pointId: string }
  | { type: "replication.deactivate"; pointId: string }
  | { type: "replication.rename"; pointId: string; name: string }
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
  | "evidence"
  | "too_far"
  | "not_active"
  | "no_capacity"
  | "tank_full"
  | "tank_overflow"
  | "cargo_overflow"
  | "full_hull"
  | "no_kit"
  | "near_body"
  | "near_rock"
  | "emergence_blocked"
  | "not_inspected"
  /** Co-op host: the reported activity (beam time) cannot have produced this result. */
  | "no_activity"
  /** Co-op host: a local-only operation (dev tools, clock) sent by a guest. */
  | "not_allowed";

/**
 * A remote authority (M4) answers `pending` and settles later through an `op.settled` event:
 * grants and UI follow the settled outcome, never the act of submitting.
 */
export type OperationOutcome =
  | { status: "accepted"; opId: string; by: PlayerId; result: OperationResult }
  /** `missing`: material units short; `evidence`: requirement keys still missing (research.unlock). */
  | { status: "rejected"; opId: string; by: PlayerId; reason: RejectReason; missing?: Record<string, number>; evidence?: string[] }
  | { status: "duplicate"; opId: string; by: PlayerId }
  | { status: "pending"; opId: string; by: PlayerId };

export type ShipContact = { frameId: string; positionKm: Vec3Tuple; direction: Vec3Tuple; dvMps: number };

export type WorldEvent =
  | ({ type: "ship.contact"; by: PlayerId } & ShipContact)
  | { type: "ship.destroyed"; by: PlayerId; frameId: string; positionKm: Vec3Tuple; cause: "impact" | "abandon" }
  | { type: "ship.respawned"; by: PlayerId }
  | { type: "asteroid.destroyed"; by: PlayerId; fieldId: string; chunkKey: string; instanceId: number; cause: AsteroidDestroyCause }
  | { type: "wreck.created"; by: PlayerId; wreck: WreckRecord }
  | { type: "wreck.changed"; by: PlayerId; wreck: WreckRecord }
  | { type: "wreck.removed"; by: PlayerId; wreckId: string }
  | { type: "research.changed"; by: PlayerId; completedNodes: readonly string[] }
  | { type: "discoveries.changed"; by: PlayerId }
  | { type: "replication.changed"; by: PlayerId }
  /** The listed slices of `playerId` were replaced by a committed operation. */
  | { type: "player.changed"; by: PlayerId; playerId: PlayerId; keys: readonly (keyof PlayerState)[] }
  /** Carries only the fields the command set: the live clock is ahead of the stored epoch. */
  | { type: "time.changed"; by: PlayerId; epochMs?: number; rate?: number }
  /** Last event of every submit, after the state events it caused. */
  | { type: "op.settled"; outcome: OperationOutcome };
