/**
 * Host contribution ledger for shared mining (FIRST_EXPEDITION_PLAN WP5 design §1): per rock,
 * each pilot's credited beam work as a fraction of the rock at their own mining speed.
 * In memory only: a host restart forgets partial work, as a reload forgets solo progress.
 */
import type { PlayerId } from "@/save/types";
import type { ResolvedMine } from "@/sim/asteroids/mineResolve";
import type { RockRef } from "./protocol";

/** Credit per pose interval is capped, so a pose gap never turns into a burst of work. */
export const CREDIT_DT_CAP_S = 0.2;
/** A rock nobody has beamed for this long forgets its contributions. */
export const LEDGER_IDLE_MS = 60_000;
/** A beam credited this recently counts as active in the feed (3 poses at 15 Hz, plus jitter). */
const ACTIVE_BEAM_MS = 500;

export interface LedgerRock {
  ref: RockRef;
  /** Resolved once (null: the id names no rock). Position and radius do not depend on the pilot. */
  rock: Pick<ResolvedMine, "frameId" | "positionKm" | "radiusM"> | null;
  /** Each pilot's required beam seconds, resolved on their first credit. */
  required: Map<PlayerId, number>;
  work: Map<PlayerId, number>;
  beamAt: Map<PlayerId, number>;
  touchedAt: number;
}

export const rockKey = (fieldId: string, chunkKey: string, instanceId: number): string => `${fieldId}|${chunkKey}|${instanceId}`;

export class MineLedger {
  private readonly rocks = new Map<string, LedgerRock>();

  get(key: string): LedgerRock | undefined {
    return this.rocks.get(key);
  }

  /** The rock's record, created on first use (`resolve` runs once per rock). */
  open(ref: RockRef, now: number, resolve: () => LedgerRock["rock"]): LedgerRock {
    const key = rockKey(ref[0], ref[1], ref[2]);
    let e = this.rocks.get(key);
    if (!e) {
      e = { ref, rock: resolve(), required: new Map(), work: new Map(), beamAt: new Map(), touchedAt: now };
      this.rocks.set(key, e);
    }
    return e;
  }

  credit(e: LedgerRock, pid: PlayerId, fraction: number, now: number): void {
    e.work.set(pid, (e.work.get(pid) ?? 0) + fraction);
    e.beamAt.set(pid, now);
    e.touchedAt = now;
  }

  own(key: string, pid: PlayerId): number {
    return this.rocks.get(key)?.work.get(pid) ?? 0;
  }

  /** Everyone else's work on the rock. */
  partners(key: string, pid: PlayerId): number {
    let sum = 0;
    this.rocks.get(key)?.work.forEach((w, id) => { if (id !== pid) sum += w; });
    return sum;
  }

  beams(e: LedgerRock, now: number): number {
    let n = 0;
    e.beamAt.forEach(at => { if (now - at <= ACTIVE_BEAM_MS) n++; });
    return n;
  }

  forget(fieldId: string, chunkKey: string, instanceId: number): void {
    this.rocks.delete(rockKey(fieldId, chunkKey, instanceId));
  }

  expire(now: number): void {
    this.rocks.forEach((e, key) => { if (now - e.touchedAt > LEDGER_IDLE_MS) this.rocks.delete(key); });
  }
}
