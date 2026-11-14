import type { PlayerId, Vec3Tuple, WreckRecord } from "@/save/types";

export type AsteroidDestroyCause = "mined" | "collision";

export type WorldCommand =
  | { type: "asteroid.destroy"; fieldId: string; chunkKey: string; instanceId: number; cause: AsteroidDestroyCause }
  | { type: "wreck.create"; frameId: string; positionKm: Vec3Tuple; items: Record<string, number> }
  | { type: "wreck.take"; wreckId: string; items: Record<string, number> }
  | { type: "time.set"; epochMs?: number; rate?: number };

export type WorldEvent =
  | { type: "asteroid.destroyed"; by: PlayerId; fieldId: string; chunkKey: string; instanceId: number; cause: AsteroidDestroyCause }
  | { type: "wreck.created"; by: PlayerId; wreck: WreckRecord }
  | { type: "wreck.changed"; by: PlayerId; wreck: WreckRecord }
  | { type: "wreck.removed"; by: PlayerId; wreckId: string }
  /** Carries only the fields the command set: the live clock is ahead of the stored epoch. */
  | { type: "time.changed"; by: PlayerId; epochMs?: number; rate?: number };
