import { depleteDroneDiscoveries, DroneMiningSearch } from "@/sim/industry/mining";
import { advanceIndustry, hasIndustryDelta, type IndustryAdvance } from "@/sim/industry/simulation";
import { MAX_RECEIPTS } from "@/save/defaults";
import type { MineResolver } from "@/sim/asteroids/mineResolve";
import type { AsteroidDeltas, Difficulty, PlayerId, PlayerState, WorldState } from "@/save/types";
import { AsteroidDeltaIndex } from "./asteroidDeltas";
import type { OperationOutcome, OperationType, WorldEvent, WorldOperation } from "./commands";
import { reduce, type MineSharesFn } from "./reducers";
import type { PilotMotion } from "@/sim/replication/placement";

export type WorldListener = (event: WorldEvent) => void;

/**
 * The only writer of shared world state, and of player state touched by a world operation.
 * Local acceptance is synchronous; M4's remote one answers "pending" and settles via events.
 */
export interface Authority {
  submit(op: WorldOperation, by: PlayerId): OperationOutcome;
  subscribe(listener: WorldListener): () => void;
}

/**
 * Retryable transfers. time.set / collision destroys are idempotent by state, so not logged.
 * ship.repair is not: two per second of repair would evict the bounded log within minutes.
 */
export const RECEIPTED: ReadonlySet<OperationType> = new Set<OperationType>([
  "expedition.give",
  "depot.place",
  "depot.rename",
  "replication.rename",
  "depot.transfer",
  "depot.fabricate",
  "replication.tank.install",
  "replication.tank.transfer",
  "drone.configure",
  "asteroid.mine",
  "item.craft",
  "item.consume",
  "cargo.jettison",
  "survey.inspect",
  "research.unlock",
  "trial.record",
  "site.inspect",
  "site.recover",
  "ship.destroy",
  "ship.respawn",
  "wreck.collect",
  "processing.start",
  "processing.cancel",
  "replication.place",
]);

export class LocalAuthority implements Authority {
  readonly asteroids = new AsteroidDeltaIndex();
  private readonly droneSearch = new DroneMiningSearch();
  private industryAsteroids: AsteroidDeltas | null = null;
  private readonly listeners = new Set<WorldListener>();
  private receiptSource: WorldState["receipts"] | null = null;
  private readonly receiptIds = new Set<string>();

  constructor(
    private readonly deps: {
      getWorld: () => WorldState;
      getPlayer: (id: PlayerId) => PlayerState | null;
      getPlayers: () => readonly PlayerState[];
      /** `urgent` for operations a reload must not lose. */
      markDirty: (urgent: boolean) => void;
      resolveMine?: MineResolver;
      getDifficulty?: () => Difficulty;
      nearbyPilot?: (id: PlayerId) => PlayerState | null;
      reservedFuel?: (id: PlayerId) => number;
      pilotMotion?: (player: Readonly<PlayerState>) => PilotMotion | null;
      /** Co-op host only (WP5): solo provides none, so a solo mine is unchanged. */
      mineShares?: MineSharesFn;
    },
  ) {}

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

  /** Current world, with the asteroid and receipt indices synced to it. */
  world(): WorldState {
    const w = this.deps.getWorld();
    this.asteroids.sync(w.asteroidDeltas);
    if (w.receipts !== this.receiptSource) {
      this.receiptSource = w.receipts;
      this.receiptIds.clear();
      for (const r of w.receipts) this.receiptIds.add(r.opId);
    }
    return w;
  }

  subscribe(listener: WorldListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: WorldEvent): void {
    // A throwing listener must not stop the mirrors from seeing a committed result.
    this.listeners.forEach((l) => {
      try {
        l(e);
      } catch (err) {
        console.error("[authority] listener failed", e.type, err);
      }
    });
  }

  planIndustry(elapsedS: number): IndustryAdvance | null {
    const world = this.world();
    if (world.asteroidDeltas !== this.industryAsteroids) {
      this.industryAsteroids = world.asteroidDeltas;
      this.droneSearch.clear();
    }
    return advanceIndustry(world.industry, elapsedS, world.replication.points, {
      search: this.droneSearch, asteroids: this.asteroids, difficulty: this.deps.getDifficulty?.(),
    });
  }

  applyIndustry(stepped: IndustryAdvance): boolean {
    const world = this.world();
    const mined = stepped.delta.mined ?? [];
    world.industry = stepped.state;
    for (const rock of mined) this.asteroids.add(rock.fieldId, rock.chunkKey, rock.instanceId);
    const discoveries = depleteDroneDiscoveries(world.discoveries, mined);
    if (discoveries === world.discoveries) return false;
    world.discoveries = discoveries;
    return true;
  }

  tickIndustry(elapsedS: number): void {
    const stepped = this.planIndustry(elapsedS);
    if (!stepped) return;
    const discoveriesChanged = this.applyIndustry(stepped);
    if (!hasIndustryDelta(stepped.delta)) return;
    for (const rock of stepped.delta.mined ?? []) this.emit({ type: "asteroid.destroyed", by: "", cause: "mined", ...rock });
    if (discoveriesChanged) this.emit({ type: "discoveries.changed", by: "" });
    this.emit({ type: "industry.changed", by: "", delta: stepped.delta });
    // Durably schedule resource-changing transitions. Countdown and recharge-only updates
    // are sampled by the normal live-world checkpoint.
    if (stepped.economic) this.deps.markDirty(true);
  }

  /** Validate → commit (one synchronous task, so no save flush can land in between) → publish. */
  submit(op: WorldOperation, by: PlayerId): OperationOutcome {
    const w = this.world();
    let outcome: OperationOutcome;
    if (typeof op.opId !== "string" || op.opId === "") {
      outcome = { status: "rejected", opId: String(op.opId), by, reason: "invalid" };
    } else if (this.receiptIds.has(op.opId)) {
      outcome = { status: "duplicate", opId: op.opId, by };
    } else {
      const now = Date.now();
      const getPlayers = this.deps.getPlayers;
      const bookmarked = (): Set<string> => new Set(getPlayers().flatMap((p) => p.bookmarks.map((b) => b.sourceId)));
      const r = reduce(op, { world: w, player: this.deps.getPlayer(by), by, asteroids: this.asteroids, now, bookmarked, players: getPlayers, nearbyPilot: this.deps.nearbyPilot, reservedFuel: this.deps.reservedFuel, pilotMotion: this.deps.pilotMotion, resolveMine: this.deps.resolveMine,
        getPlayer: this.deps.getPlayer, mineShares: this.deps.mineShares });
      if ("reason" in r) {
        outcome = { status: "rejected", opId: op.opId, by, reason: r.reason, missing: r.missing, evidence: r.evidence };
      } else {
        r.apply();
        if (RECEIPTED.has(op.type)) this.addReceipt(w, { opId: op.opId, type: op.type, by, at: now });
        this.deps.markDirty(RECEIPTED.has(op.type));
        outcome = { status: "accepted", opId: op.opId, by, result: r.result };
        r.events.forEach((e) => this.emit(e));
        if (r.playerKeys.length > 0) this.emit({ type: "player.changed", by, playerId: by, keys: r.playerKeys });
      }
    }
    this.emit({ type: "op.settled", outcome });
    return outcome;
  }

  private addReceipt(w: WorldState, r: WorldState["receipts"][number]): void {
    w.receipts.push(r);
    this.receiptIds.add(r.opId);
    while (w.receipts.length > MAX_RECEIPTS) {
      const old = w.receipts.shift();
      if (old) this.receiptIds.delete(old.opId);
    }
  }
}
