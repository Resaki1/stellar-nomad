import type { PlayerId, WorldState, WreckRecord } from "@/save/types";
import { isFrameId } from "@/sim/frames";
import { AsteroidDeltaIndex } from "./asteroidDeltas";
import type { WorldCommand, WorldEvent } from "./commands";

export type WorldListener = (event: WorldEvent) => void;

/**
 * The only writer of shared world state. M4 adds a remote authority whose acceptance arrives
 * asynchronously: views must update from EVENTS, and `submit`'s boolean is only local gating.
 */
export interface Authority {
  submit(cmd: WorldCommand, by: PlayerId): boolean;
  subscribe(listener: WorldListener): () => void;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function cleanItems(items: Record<string, number>): Record<string, number> | null {
  const out: Record<string, number> = {};
  let any = false;
  for (const k of Object.keys(items)) {
    const v = items[k];
    if (!isNum(v) || v < 0 || !Number.isInteger(v)) return null;
    if (v > 0) {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : null;
}

let wreckSeq = 1;

export class LocalAuthority implements Authority {
  readonly asteroids = new AsteroidDeltaIndex();
  private readonly listeners = new Set<WorldListener>();

  constructor(private readonly deps: { getWorld: () => WorldState; markDirty: () => void }) {}

  /** Read-only lookup for chunk generation (O(1) per id); always reads the current world. */
  readonly destroyedAsteroids = {
    chunk: (fieldId: string, chunkKey: string): ReadonlySet<number> => {
      this.world();
      return this.asteroids.chunk(fieldId, chunkKey);
    },
    unchunked: (fieldId: string): ReadonlySet<number> => {
      this.world();
      return this.asteroids.unchunked(fieldId);
    },
  };

  /** Current world, with the asteroid index synced to it. */
  world(): WorldState {
    const w = this.deps.getWorld();
    this.asteroids.sync(w.asteroidDeltas);
    return w;
  }

  subscribe(listener: WorldListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: WorldEvent): void {
    this.listeners.forEach((l) => l(e));
  }

  submit(cmd: WorldCommand, by: PlayerId): boolean {
    const w = this.world();
    switch (cmd.type) {
      case "asteroid.destroy": {
        const id = cmd.instanceId;
        if (!cmd.fieldId || !cmd.chunkKey || !isNum(id) || id < 0 || id > 0xffffffff || !Number.isInteger(id)) return false;
        if (this.asteroids.has(cmd.fieldId, cmd.chunkKey, id)) return false;
        this.asteroids.add(cmd.fieldId, cmd.chunkKey, id);
        this.deps.markDirty();
        this.emit({ type: "asteroid.destroyed", by, fieldId: cmd.fieldId, chunkKey: cmd.chunkKey, instanceId: id, cause: cmd.cause });
        return true;
      }
      case "wreck.create": {
        const items = cleanItems(cmd.items);
        const p = cmd.positionKm;
        if (!items || !isFrameId(cmd.frameId) || p.length !== 3 || !p.every(isNum)) return false;
        const now = Date.now();
        const wreck: WreckRecord = {
          id: `wreck-${now}-${wreckSeq++}`,
          frameId: cmd.frameId,
          positionKm: [p[0], p[1], p[2]],
          items,
          createdAt: now,
        };
        w.wrecks = [...w.wrecks, wreck];
        this.deps.markDirty();
        this.emit({ type: "wreck.created", by, wreck });
        return true;
      }
      case "wreck.take": {
        const idx = w.wrecks.findIndex((x) => x.id === cmd.wreckId);
        const take = cleanItems(cmd.items);
        if (idx < 0 || !take) return false;
        const wreck = w.wrecks[idx];
        const left: Record<string, number> = { ...wreck.items };
        for (const k of Object.keys(take)) {
          if ((left[k] ?? 0) < take[k]) return false;
          left[k] -= take[k];
          if (left[k] === 0) delete left[k];
        }
        if (Object.keys(left).length === 0) {
          w.wrecks = w.wrecks.filter((_, i) => i !== idx);
          this.deps.markDirty();
          this.emit({ type: "wreck.removed", by, wreckId: wreck.id });
        } else {
          const next = { ...wreck, items: left };
          w.wrecks = w.wrecks.map((x, i) => (i === idx ? next : x));
          this.deps.markDirty();
          this.emit({ type: "wreck.changed", by, wreck: next });
        }
        return true;
      }
      case "time.set": {
        if (cmd.epochMs === undefined && cmd.rate === undefined) return false;
        if (cmd.epochMs !== undefined && !isNum(cmd.epochMs)) return false;
        if (cmd.rate !== undefined && !isNum(cmd.rate)) return false;
        if (cmd.epochMs !== undefined) w.simEpochMs = cmd.epochMs;
        if (cmd.rate !== undefined) w.simRate = cmd.rate;
        this.deps.markDirty();
        this.emit({ type: "time.changed", by, epochMs: cmd.epochMs, rate: cmd.rate });
        return true;
      }
    }
  }
}
