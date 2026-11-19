import { getPlayerState, getPlayerStates, getWorldState, markDirty } from "@/save/activeSave";
import { makeMineResolver } from "@/sim/asteroids/mineResolve";
import { getDifficulty } from "@/sim/difficulty";
import { activeSystem } from "@/sim/systemRegistry";
import type { PlayerId, WorldState } from "@/save/types";
import { LocalAuthority, type Authority, type WorldListener } from "./authority";
import type { OperationOutcome, WorldEvent, WorldOperation } from "./commands";

/** A connected session: submissions answer "pending" and settle through `deliver`. */
export interface RemoteAuthority {
  submit(op: WorldOperation): OperationOutcome;
}

/**
 * Facade over the current authority: the in-process one (solo) or a co-op session (host's own
 * client or guest). Reads always come from the local index over the active record, which in a
 * session is the mirror the session keeps up to date.
 */
class AuthorityFacade implements Authority {
  readonly local = new LocalAuthority({
    getWorld: getWorldState,
    getPlayer: getPlayerState,
    getPlayers: getPlayerStates,
    markDirty,
    resolveMine: makeMineResolver(activeSystem, getDifficulty),
  });
  private remote: RemoteAuthority | null = null;
  private readonly listeners = new Set<WorldListener>();

  constructor() {
    this.local.subscribe((e) => this.emit(e));
  }

  get asteroids(): LocalAuthority["asteroids"] {
    return this.local.asteroids;
  }
  get destroyedAsteroids(): LocalAuthority["destroyedAsteroids"] {
    return this.local.destroyedAsteroids;
  }
  get connected(): boolean {
    return this.remote !== null;
  }
  world(): WorldState {
    return this.local.world();
  }

  setRemote(r: RemoteAuthority | null): void {
    this.remote = r;
  }

  submit(op: WorldOperation, by: PlayerId): OperationOutcome {
    return this.remote ? this.remote.submit(op) : this.local.submit(op, by);
  }

  subscribe(listener: WorldListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A committed session event, already applied to the mirror: publish it like a local one. */
  deliver(e: WorldEvent): void {
    this.emit(e);
  }

  private emit(e: WorldEvent): void {
    this.listeners.forEach((l) => {
      try {
        l(e);
      } catch (err) {
        console.error("[authority] listener failed", e.type, err);
      }
    });
  }
}

export const worldAuthority = new AuthorityFacade();

let opSeq = 0;
/** Fresh id for a new intent; reuse it to retry the same intent. */
export function newOpId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `op-${Date.now()}-${++opSeq}`;
}
