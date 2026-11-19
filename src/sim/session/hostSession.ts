/**
 * The co-op host authority (M4.0), headless: admission, per-player command streams, the commit
 * pipeline (one durable write per command, stream + effect together), commit fan-out, telemetry,
 * clock samples and pose relay. Runs in a worker in the browser and under Node in the transcript.
 */
import { INSPECT_RANGE_M, WRECK_SALVAGE_KM } from "@/data/content";
import { buildInspectOperation } from "@/sim/asteroids/inspectOperation";
import { resolveHeadlessRock } from "@/sim/asteroids/headlessChunks";
import "@/sim/replication/clearance";
import { persistentShipConfig } from "@/sim/ship/loadout";
import { isFrameId } from "@/sim/frames";
import { defaultPlayerState } from "@/save/defaults";
import type { PlayerId, PlayerState, ShipPose, SaveData, SaveMeta, WorldState } from "@/save/types";
import { parseSaveData } from "@/save/validate";
import { makeMineResolver, type MineResolver } from "@/sim/asteroids/mineResolve";
import { updateEphemerisPositions } from "@/sim/celestialConstants";
import { jdFromUnixMs } from "@/sim/ephemeris";
import { emergencePose, starterPoint } from "@/sim/replication/points";
import { poseDistanceKm } from "@/sim/replication/placement";
import type { SystemConfig } from "@/sim/systemTypes";
import { getEffectiveTuning } from "@/sim/ship/resourceTuning";
import { LocalAuthority } from "@/sim/world/authority";
import { tankCapacityKg } from "@/sim/world/reducers";
import type { OperationOutcome, WorldEvent, WorldOperation } from "@/sim/world/commands";
import {
  MAX_NAME,
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  SNAPSHOT_PART_CHARS,
  cleanName,
  decodeClientMsg,
  type Channel,
  type ClientMsg,
  type CommitSlices,
  type HostMsg,
  type PoseMsg,
  type RefuseReason,
  type Telemetry,
} from "./protocol";
import type { Clock, ConnId, HostTransport, WorldRepository } from "./ports";

/** Beam time a mine claim must show, as a share of the rock's required duration. */
const MIN_BEAM_SHARE = 0.8;
/** Targeting range (MiningSystem's MAX_TARGETING_DISTANCE_M) plus slack for pose age. */
const MINE_RANGE_KM = 10;
const MINE_SLACK_KM = 5;
const CHECKPOINT_MS = 10_000;
/** A pilot's renames closer together than this are coalesced (the last one lands on the 1 Hz tick). */
const RENAME_MIN_MS = 1_000;
/** Guests may not send these: dev tools and the host-owned clock. */
const HOST_ONLY: ReadonlySet<WorldOperation["type"]> = new Set<WorldOperation["type"]>(["time.set", "research.devSet"]);

export type HostState = "starting" | "open" | "storage_failed" | "closed";

export interface HostSessionOptions {
  repo: WorldRepository;
  transport: HostTransport;
  clock: Clock;
  hostPlayerId: PlayerId;
  hostName: string;
  system: () => SystemConfig;
  content: string;
  onPlayerCount?: (count: number) => void;
  onState?: (state: HostState, detail?: string) => void;
}

interface Member {
  conn: ConnId;
  local: boolean;
  playerId: PlayerId | null;
  /** Superseded by a newer connection of the same player: its messages are ignored. */
  fenced: boolean;
  closeAfter?: number;
  lastPose?: PoseMsg;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return b64url(new Uint8Array(d));
}

function newId(): string {
  return crypto.randomUUID();
}

export class HostSession {
  private meta!: SaveMeta;
  private data!: SaveData;
  private state: HostState = "starting";
  private gen = 0;
  private readonly conns = new Map<ConnId, Member>();
  private readonly bound = new Map<PlayerId, ConnId>();
  private chain: Promise<void> = Promise.resolve();
  private authority!: LocalAuthority;
  private resolver!: MineResolver;
  private clockPaused = false;
  private epoch0 = 0;
  private mono0 = 0;
  private lastCheckpoint = 0;
  private readonly captured: WorldEvent[] = [];
  private readonly renamedAt = new Map<PlayerId, number>();
  private readonly pendingNames = new Map<PlayerId, string>();

  constructor(private readonly o: HostSessionOptions) {}

  get generation(): number {
    return this.gen;
  }
  get status(): HostState {
    return this.state;
  }
  /** Read-only view for tests and the host UI. */
  get world(): Readonly<WorldState> {
    return this.data.world;
  }
  player(id: PlayerId): Readonly<PlayerState> | null {
    return this.data.players[id] ?? null;
  }
  get record(): { meta: SaveMeta; data: SaveData } {
    return { meta: this.meta, data: this.data };
  }

  /** Load, bump the session generation, register the host as a member, persist. Throws when it cannot host. */
  async start(): Promise<void> {
    const stored = await this.o.repo.load();
    if (!stored) throw new Error("no world to host");
    this.meta = stored.meta;
    this.data = parseSaveData(stored.data);
    const w = this.data.world;
    w.session = { generation: w.session.generation + 1 };
    this.gen = w.session.generation;
    const hid = this.o.hostPlayerId;
    w.members[hid] = { name: "", verifier: null, joinedAt: w.members[hid]?.joinedAt || this.o.clock.nowMs() };
    w.members[hid].name = this.uniqueName(hid, cleanName(this.o.hostName) || "Host");
    this.data.players[hid] ??= defaultPlayerState(this.meta.difficulty);
    this.resolver = makeMineResolver(this.o.system, () => this.meta.difficulty);
    this.authority = new LocalAuthority({
      getWorld: () => this.data.world,
      getPlayer: (id) => this.data.players[id] ?? null,
      getPlayers: () => Object.values(this.data.players),
      markDirty: () => {},
      resolveMine: this.resolver,
    });
    this.authority.subscribe((e) => this.captured.push(e));
    this.epoch0 = w.simEpochMs;
    this.mono0 = this.o.clock.monoMs();
    await this.o.repo.commit(this.meta, this.data);
    this.lastCheckpoint = this.o.clock.monoMs();
    this.setState("open");
  }

  /** Live astronomical epoch: the host owns it while the session is open. */
  epochMs(): number {
    if (this.clockPaused) return this.epoch0;
    return this.epoch0 + this.data.world.simRate * (this.o.clock.monoMs() - this.mono0);
  }

  setClockPaused(paused: boolean): void {
    if (paused === this.clockPaused) return;
    this.epoch0 = this.epochMs();
    this.mono0 = this.o.clock.monoMs();
    this.clockPaused = paused;
    this.tick();
  }

  /** 1 Hz from the adapter: clock samples to everyone, plus the periodic telemetry checkpoint. */
  tick(): void {
    if (this.state !== "open" && this.state !== "storage_failed") return;
    this.conns.forEach(m => {
      if (m.closeAfter !== undefined && this.o.clock.monoMs() >= m.closeAfter) this.o.transport.close(m.conn);
    });
    if (this.pendingNames.size > 0) this.flushRenames();
    const msg: HostMsg = { t: "clock", gen: this.gen, epochMs: this.epochMs(), rate: this.clockPaused ? 0 : this.data.world.simRate, hostMonoMs: this.o.clock.monoMs() };
    this.broadcast("cmd", msg);
    if (this.state === "open" && this.o.clock.monoMs() - this.lastCheckpoint >= CHECKPOINT_MS) this.enqueue(() => this.checkpoint());
  }

  /** Stop admissions, drain the queue, save, close every connection. */
  async close(): Promise<void> {
    if (this.state === "closed") return;
    const wasOpen = this.state === "open";
    this.setState("closed");
    this.broadcast("cmd", { t: "status", gen: this.gen, state: "closing" } satisfies HostMsg);
    await this.chain;
    if (wasOpen) await this.checkpoint();
    this.conns.forEach((_, c) => this.o.transport.close(c));
    this.conns.clear();
    this.bound.clear();
  }

  // ── transport events ─────────────────────────────────────────────────────

  connect(conn: ConnId, info: { local: boolean }): void {
    this.conns.set(conn, { conn, local: info.local, playerId: null, fenced: false });
  }

  disconnect(conn: ConnId): void {
    const m = this.conns.get(conn);
    this.conns.delete(conn);
    if (m?.playerId && this.bound.get(m.playerId) === conn) {
      this.bound.delete(m.playerId);
      this.o.onPlayerCount?.(this.bound.size);
      if (this.state === "open") this.enqueue(() => this.checkpoint());
    }
  }

  receive(conn: ConnId, channel: Channel, raw: unknown): void {
    const m = this.conns.get(conn);
    if (!m || m.fenced) return;
    const msg = decodeClientMsg(raw);
    if (!msg) return;
    if (msg.t === "hello") {
      if (m.playerId === null) this.enqueue(() => this.admit(m, msg));
      return;
    }
    const pid = m.playerId;
    if (pid === null || msg.gen !== this.gen) return;
    if (msg.t === "pose") {
      if (channel !== "pose") return;
      this.relayPose(m, pid, msg);
    } else if (msg.t === "impact") {
      if (channel === "cmd" && msg.by === pid && !this.data.players[pid]?.isDead) this.broadcast("cmd", msg);
    } else if (msg.t === "tel") {
      this.applyTelemetry(pid, msg.tel);
    } else if (msg.t === "name") {
      this.rename(pid, msg.name);
    } else if (msg.t === "cmd") {
      this.enqueue(() => this.execute(m, pid, msg));
    }
  }

  // ── admission ────────────────────────────────────────────────────────────

  private async admit(m: Member, hello: Extract<ClientMsg, { t: "hello" }>): Promise<void> {
    // A repeated hello queued before the first admission finished: already admitted.
    if (m.playerId !== null || m.fenced || !this.conns.has(m.conn)) return;
    const refuse = (reason: RefuseReason): void => this.refuse(m, reason);
    if (this.state !== "open") return refuse("closed");
    if (hello.protocol !== PROTOCOL_VERSION) return refuse("protocol");
    if (hello.content !== this.o.content) return refuse("content");
    const w = this.data.world;
    let pid: PlayerId;
    let credential: string | undefined;
    if (hello.playerId !== undefined && hello.playerId === this.o.hostPlayerId) {
      if (!m.local) return refuse("credential");
      pid = hello.playerId;
    } else if (hello.playerId !== undefined) {
      const member = w.members[hello.playerId];
      if (!member?.verifier || !hello.credential || (await sha256(hello.credential)) !== member.verifier) return refuse("credential");
      pid = hello.playerId;
    } else {
      pid = "";
    }
    const rebinding = pid !== "" && this.bound.has(pid);
    if (!rebinding && this.bound.size >= MAX_PLAYERS) return refuse("full");
    if (pid === "") {
      pid = newId();
      credential = b64url(crypto.getRandomValues(new Uint8Array(32)));
      const backup = structuredClone(this.data);
      w.members[pid] = { name: "", verifier: await sha256(credential), joinedAt: this.o.clock.nowMs() };
      w.members[pid].name = this.uniqueName(pid, hello.name || "Replicant");
      const player = defaultPlayerState(this.meta.difficulty);
      player.ship = this.newGuestSpawn();
      this.data.players[pid] = player;
      if (!(await this.persist(backup))) return refuse("closed");
    } else if (w.members[pid] && hello.name) {
      w.members[pid].name = this.uniqueName(pid, hello.name);
    }
    // Fence the previous connection of this player: its late messages are ignored.
    const old = this.bound.get(pid);
    if (old !== undefined && old !== m.conn) {
      const om = this.conns.get(old);
      if (om) this.refuse(om, "replaced");
    }
    m.playerId = pid;
    this.bound.set(pid, m.conn);
    this.o.onPlayerCount?.(this.bound.size);
    this.send(m.conn, {
      t: "welcome",
      playerId: pid,
      ...(credential ? { credential } : {}),
      gen: this.gen,
      worldId: this.meta.id,
      worldName: this.meta.name,
      difficulty: this.meta.difficulty,
      hostName: w.members[this.o.hostPlayerId]?.name ?? "",
      revision: w.revision,
    });
    this.sendSnapshot(m.conn);
    this.broadcastMembers();
  }

  /** Admission is serialized. Check live pilots, including a new arrival awaiting its first pose. */
  private newGuestSpawn(): ShipPose {
    const point = starterPoint();
    const start = { frameId: point.frameId, ...emergencePose(point, 0) };
    updateEphemerisPositions(jdFromUnixMs(this.epochMs()));
    const occupied = Array.from(this.bound, ([pid, conn]) => {
      const pose = this.conns.get(conn)?.lastPose;
      return pose ? { frameId: pose.f, positionKm: pose.p } : this.data.players[pid].ship ?? start;
    });
    // Try the authored start, then nearby berths 80 m apart. Each pilot can block at most one.
    for (let berth = 0; ; berth++) {
      const [x, y, z] = start.positionKm;
      const positionKm: ShipPose["positionKm"] = [x + berth * 0.08, y, z];
      if (occupied.every(p => poseDistanceKm(p.frameId, p.positionKm, start.frameId, positionKm) >= 0.035)) {
        return { ...start, positionKm };
      }
    }
  }

  /** A pilot renamed mid-session: a label, no revision; the next checkpoint persists it. Rate-limited per pilot. */
  private rename(pid: PlayerId, name: string): void {
    if (!this.data.world.members[pid]) return;
    if (this.o.clock.monoMs() - (this.renamedAt.get(pid) ?? -Infinity) < RENAME_MIN_MS) {
      this.pendingNames.set(pid, name);
      return;
    }
    this.pendingNames.delete(pid);
    if (this.applyName(pid, name)) this.broadcastMembers();
  }

  /** Coalesced renames whose cooldown has passed (from the 1 Hz tick). */
  private flushRenames(): void {
    let changed = false;
    const now = this.o.clock.monoMs();
    for (const [pid, name] of Array.from(this.pendingNames)) {
      if (now - (this.renamedAt.get(pid) ?? -Infinity) < RENAME_MIN_MS) continue;
      this.pendingNames.delete(pid);
      changed = this.applyName(pid, name) || changed;
    }
    if (changed) this.broadcastMembers();
  }

  private applyName(pid: PlayerId, requested: string): boolean {
    const mem = this.data.world.members[pid];
    const name = mem ? this.uniqueName(pid, requested) : "";
    if (!mem || mem.name === name) return false;
    mem.name = name;
    this.renamedAt.set(pid, this.o.clock.monoMs());
    return true;
  }

  /** Labels stay distinguishable: a name another member holds gets " 2", " 3"... */
  private uniqueName(pid: PlayerId, name: string): string {
    const taken = new Set<string>();
    for (const [id, mem] of Object.entries(this.data.world.members)) if (id !== pid) taken.add(mem.name.toLowerCase());
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) {
      const sfx = ` ${i}`;
      const n = name.slice(0, MAX_NAME - sfx.length).trimEnd() + sfx;
      if (!taken.has(n.toLowerCase())) return n;
    }
  }

  /** Member names for everyone's mirror (labels): admission writes no commit. */
  private broadcastMembers(): void {
    const names: Record<PlayerId, string> = {};
    for (const [id, mem] of Object.entries(this.data.world.members)) names[id] = mem.name;
    this.broadcast("cmd", { t: "members", gen: this.gen, names });
  }

  /** Each peer gets public world state and its own private pilot record. */
  private sendSnapshot(conn: ConnId): void {
    const pid = this.conns.get(conn)?.playerId;
    if (!pid) return;
    const members = Object.fromEntries(Object.entries(this.data.world.members).map(([id, member]) =>
      [id, { ...member, verifier: null }]));
    const data = { ...this.data, players: { [pid]: this.data.players[pid] },
      world: { ...this.data.world, members, receipts: [], simEpochMs: this.epochMs() } };
    const deadPilots = Object.keys(this.data.players).filter(id => this.data.players[id].isDead);
    const json = JSON.stringify({ meta: this.meta, data, deadPilots });
    const of = Math.max(1, Math.ceil(json.length / SNAPSHOT_PART_CHARS));
    for (let part = 0; part < of; part++) {
      this.send(conn, { t: "snap", gen: this.gen, revision: this.data.world.revision, part, of, json: json.slice(part * SNAPSHOT_PART_CHARS, (part + 1) * SNAPSHOT_PART_CHARS) });
    }
  }

  // ── commands ─────────────────────────────────────────────────────────────

  private async execute(m: Member, pid: PlayerId, msg: Extract<ClientMsg, { t: "cmd" }>): Promise<void> {
    if (m.fenced || this.bound.get(pid) !== m.conn) return;
    if (this.state !== "open") {
      if (this.state === "storage_failed") this.send(m.conn, { t: "status", gen: this.gen, state: "storage_failed" });
      return;
    }
    const player = this.data.players[pid];
    if (!player) return;
    const s = player.stream;
    if (msg.seq === s.seq && msg.opId === s.opId && s.outcome) {
      this.send(m.conn, { t: "settled", gen: this.gen, seq: s.seq, opId: msg.opId, outcome: s.outcome as OperationOutcome, replay: true });
      return;
    }
    if (msg.seq <= s.seq) {
      this.send(m.conn, { t: "watermark", gen: this.gen, seq: s.seq });
      this.sendSnapshot(m.conn);
      return;
    }
    if (msg.seq > s.seq + 1) {
      this.send(m.conn, { t: "resend", gen: this.gen, from: s.seq + 1 });
      return;
    }

    const backup = structuredClone(this.data);
    // A replay may carry hull/heat sampled before an already committed consumable.
    if (msg.tel) this.applyTelemetry(pid, msg.tel);
    const revision = this.data.world.revision;
    this.captured.length = 0;
    let op = msg.op;
    if (op.type === "survey.inspect") {
      const rock = resolveHeadlessRock(op.fieldId, op.chunkKey, op.instanceId);
      const scan = rock && buildInspectOperation(this.o.system(), { ...op, radiusM: rock.radiusM,
        chunkOriginKm: rock.localKm, localM: [0, 0, 0] }, op.opId);
      if (scan) op = scan;
    }
    updateEphemerisPositions(jdFromUnixMs(this.epochMs()));
    let outcome: OperationOutcome;
    const refusal = pid !== this.o.hostPlayerId && HOST_ONLY.has(op.type) ? "not_allowed" : this.checkActivity(op, player);
    if (refusal) {
      outcome = { status: "rejected", opId: msg.opId, by: pid, reason: refusal };
    } else {
      outcome = this.authority.submit(op, pid);
      if (op.type === "time.set" && outcome.status === "accepted") {
        // The live clock restarts from the committed epoch/rate.
        this.epoch0 = this.data.world.simEpochMs;
        this.mono0 = this.o.clock.monoMs();
      }
    }
    if (outcome.status === "accepted") this.data.world.revision = revision + 1;
    this.data.players[pid].stream = { seq: msg.seq, opId: msg.opId, outcome };
    const events = this.captured.splice(0);
    if (!(await this.persist(backup))) return;

    if (outcome.status === "accepted") {
      const shared = events.filter((e) => e.type !== "op.settled" && e.type !== "player.changed");
      const worldSlices: CommitSlices["world"] = {};
      if (shared.some((e) => e.type === "discoveries.changed")) worldSlices.discoveries = this.data.world.discoveries;
      if (shared.some((e) => e.type === "replication.changed")) worldSlices.replication = this.data.world.replication;
      const mine = events.filter((e): e is Extract<WorldEvent, { type: "player.changed" }> => e.type === "player.changed" && e.playerId === pid);
      const keys = Array.from(new Set(mine.flatMap((e) => e.keys)));
      const playerSlices: Record<string, unknown> = {};
      for (const k of keys) playerSlices[k] = this.data.players[pid][k];
      this.conns.forEach((other, conn) => {
        if (!other.playerId || other.fenced) return;
        const actor = other.playerId === pid;
        this.send(conn, {
          t: "commit",
          gen: this.gen,
          revision: this.data.world.revision,
          by: pid,
          events: actor ? [...shared, ...mine] : shared,
          slices: actor ? { world: worldSlices, player: playerSlices } : { world: worldSlices },
        });
      });
    }
    this.send(m.conn, { t: "settled", gen: this.gen, seq: msg.seq, opId: msg.opId, outcome });
  }

  /** Activity bounds for a mine claim (friends-only: bounds, not anti-cheat). */
  private checkActivity(op: WorldOperation, player: PlayerState): "no_activity" | "too_far" | "not_found" | "dead" | null {
    if (player.isDead && op.type === "asteroid.mine") return "dead";
    if (op.type === "wreck.collect" || op.type === "survey.inspect") {
      const pose = player.ship;
      const target = op.type === "wreck.collect" ? this.world.wrecks.find(w => w.id === op.wreckId)
        : this.resolver(op.fieldId, op.chunkKey, op.instanceId, player);
      if (!target) return "not_found";
      if (!pose || !isFrameId(pose.frameId)) return "too_far";
      const range = "radiusM" in target
        ? (target.radiusM + INSPECT_RANGE_M * persistentShipConfig(player).scannerInspectRangeMult) / 1000
        : WRECK_SALVAGE_KM;
      return poseDistanceKm(pose.frameId, pose.positionKm, target.frameId, target.positionKm) <= range ? null : "too_far";
    }
    if (op.type !== "asteroid.mine") return null;
    const rock = this.resolver(op.fieldId, op.chunkKey, op.instanceId, player);
    if (!rock) return null; // the reducer answers not_found
    if (!(typeof op.beamS === "number" && op.beamS >= MIN_BEAM_SHARE * rock.requiredBeamS)) return "no_activity";
    const pose = player.ship;
    if (!pose) return "too_far";
    if (pose.frameId !== rock.frameId) updateEphemerisPositions(jdFromUnixMs(this.epochMs()));
    const d = poseDistanceKm(pose.frameId, pose.positionKm, rock.frameId, rock.positionKm);
    const range = MINE_RANGE_KM * player.shipConfig.scannerRangeMult + MINE_SLACK_KM + rock.radiusM / 1000;
    return d <= range ? null : "too_far";
  }

  /** One durable write. On failure: restore the pre-command state, stop mutations, publish nothing. */
  private async persist(backup: SaveData): Promise<boolean> {
    this.data.world.simEpochMs = this.epochMs();
    try {
      await this.o.repo.commit(this.meta, this.data);
      this.lastCheckpoint = this.o.clock.monoMs();
      return true;
    } catch (err) {
      this.data = backup;
      this.setState("storage_failed", err instanceof Error ? err.message : String(err));
      this.broadcast("cmd", { t: "status", gen: this.gen, state: "storage_failed" } satisfies HostMsg);
      return false;
    }
  }

  private async checkpoint(): Promise<void> {
    if (this.state !== "open" && this.state !== "closed") return;
    await this.persist(structuredClone(this.data));
  }

  // ── telemetry and poses ──────────────────────────────────────────────────

  /** Pilot-owned values: bounded by the decoder, written without a revision bump. */
  private applyTelemetry(pid: PlayerId, t: Telemetry): void {
    const p = this.data.players[pid];
    if (!p) return;
    if (t.pose && !p.isDead) p.ship = { frameId: t.pose.frameId, positionKm: t.pose.positionKm, quaternion: t.pose.quaternion };
    if (t.health !== undefined && !p.isDead) p.health = Math.min(t.health, p.shipConfig.maxHealth);
    // Bounds, not anti-cheat: never above the tank, and the protected reserve only drains.
    if (t.propellant) {
      p.propellant = {
        ordinaryKg: Math.min(t.propellant.ordinaryKg, tankCapacityKg(p, this.data.world)),
        protectedKg: Math.min(t.propellant.protectedKg, p.propellant.protectedKg),
      };
    }
    if (t.power) p.power = { ...t.power };
    if (t.processing && p.processing && p.processing.id === t.processing.id) {
      // Conversion only advances, and never past the reserved feedstock: committedKg sets cancel's refund.
      const maxKg = Object.values(p.processing.reserved).reduce((a, u) => a + u, 0) * getEffectiveTuning().processingKgPerUnit;
      p.processing = t.processing.committedKg >= maxKg ? null : {
        ...p.processing,
        elapsedS: Math.max(p.processing.elapsedS, t.processing.elapsedS),
        committedKg: Math.min(maxKg, Math.max(p.processing.committedKg, t.processing.committedKg)),
      };
    }
    if (t.prefs) {
      if (t.prefs.commsPlayed) p.commsPlayed = t.prefs.commsPlayed;
      if (t.prefs.starMarkers) p.starMarkers = t.prefs.starMarkers;
      if (t.prefs.aiName !== undefined) p.aiName = t.prefs.aiName;
      if (t.prefs.trackedProject !== undefined) p.trackedProject = t.prefs.trackedProject;
    }
  }

  private relayPose(m: Member, pid: PlayerId, pose: PoseMsg): void {
    if (this.data.players[pid]?.isDead || pose.id !== pid || pose.seq <= (m.lastPose?.seq ?? -1)) return;
    m.lastPose = pose;
    this.conns.forEach((other, conn) => {
      if (conn !== m.conn && other.playerId && !other.fenced) this.o.transport.send(conn, "pose", pose);
    });
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  private enqueue(fn: () => Promise<void> | void): void {
    this.chain = this.chain.then(fn).catch((err) => console.error("[host] task failed", err));
  }

  /** Fence immediately. The client closes after reading the reason; a silent client times out. */
  private refuse(m: Member, reason: RefuseReason): void {
    m.fenced = true;
    m.closeAfter = this.o.clock.monoMs() + 5000;
    this.send(m.conn, { t: "refuse", reason });
  }

  private send(conn: ConnId, msg: HostMsg): void {
    this.o.transport.send(conn, "cmd", msg);
  }

  private broadcast(channel: Channel, msg: HostMsg): void {
    this.conns.forEach((m, conn) => {
      if (m.playerId && !m.fenced) this.o.transport.send(conn, channel, msg);
    });
  }

  private setState(s: HostState, detail?: string): void {
    this.state = s;
    this.o.onState?.(s, detail);
  }
}
