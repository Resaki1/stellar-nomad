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
import { hasIndustryDelta } from "@/sim/industry/simulation";
import { LocalAuthority } from "@/sim/world/authority";
import { tankCapacityKg } from "@/sim/world/reducers";
import type { OperationOutcome, WorldEvent, WorldOperation } from "@/sim/world/commands";
import {
  HOST_SILENCE_MS,
  MAX_NAME,
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  SNAPSHOT_PART_CHARS,
  cleanName,
  decodeClientMsg,
  frameReliableUpdate,
  jsonParts,
  type Channel,
  type ClientMsg,
  type CommitSlices,
  type HostMsg,
  type PoseMsg,
  type RefuseReason,
  type Telemetry,
} from "./protocol";
import type { Clock, ConnId, HostTransport, WorldRepository } from "./ports";
import { PilotContacts, type PilotTrack } from "./pilotContact";

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

const SPATIAL_OPS: ReadonlySet<WorldOperation["type"]> = new Set<WorldOperation["type"]>([
  "asteroid.mine", "survey.inspect", "expedition.give", "wreck.collect", "site.inspect", "site.recover",
  "replication.place", "replication.activate", "ship.respawn",
  "replication.tank.install", "replication.tank.transfer",
  "depot.place", "depot.transfer", "depot.fabricate", "drone.configure",
]);

export type HostState = "starting" | "open" | "storage_failed" | "closed";

export interface HostSessionOptions {
  repo: WorldRepository;
  transport: HostTransport;
  clock: Clock;
  hostPlayerId: PlayerId;
  hostName: string;
  system: () => SystemConfig;
  content: string;
  onTiming?: (kind: "tickLateMs" | "writeMs", ms: number) => void;
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
  previousPose?: PoseMsg;
  /** Recent monotonic clock offsets. The shortest RTT is least affected by queuing. */
  motionClocks?: { offset: number; rtt: number; at: number }[];
  poseFloor?: number;
  telemetryAt?: number;
  poseAt?: number;
  pingMs?: number;
  pingAt?: number;
  reservedFuelKg?: number;
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
  private readonly kicked = new Set<PlayerId>();
  private readonly clockStamps: number[] = [];
  private readonly bound = new Map<PlayerId, ConnId>();
  private chain: Promise<void> = Promise.resolve();
  private authority!: LocalAuthority;
  private resolver!: MineResolver;
  private clockPaused = false;
  private lastIndustryTick = 0;
  private epoch0 = 0;
  private mono0 = 0;
  private lastHeartbeat = 0;
  private lastCheckpoint = 0;
  private readonly captured: WorldEvent[] = [];
  private readonly renamedAt = new Map<PlayerId, number>();
  private readonly pendingNames = new Map<PlayerId, string>();
  private readonly pilotContacts = new PilotContacts();
  private pilotContactId = 0;

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
      getDifficulty: () => this.meta.difficulty,
      resolveMine: this.resolver,
      nearbyPilot: id => {
        const member = this.conns.get(this.bound.get(id) ?? "");
        if (!member || member.fenced || this.o.clock.monoMs() - (member.telemetryAt ?? -Infinity) > 5000) return null;
        const peer = this.data.players[id];
        if (peer && member.lastPose && (member.poseAt ?? 0) > (member.telemetryAt ?? 0)) {
          const pose = member.lastPose;
          peer.ship = { frameId: pose.f, positionKm: pose.p, quaternion: pose.q };
        }
        return peer ?? null;
      },
      reservedFuel: id => this.conns.get(this.bound.get(id) ?? "")?.reservedFuelKg ?? 0,
      // Placement stopping paths: each pilot's latest pose (cleared on death/recovery) while fresh.
      pilotMotion: player => {
        for (const [pid, state] of Object.entries(this.data.players)) {
          if (state !== player) continue;
          const m = this.conns.get(this.bound.get(pid) ?? "");
          const pose = m?.lastPose;
          if (!pose || this.o.clock.monoMs() - (m.poseAt ?? -Infinity) > 2000) return null;
          return { frameId: pose.f, positionKm: pose.p, velocityKmS: pose.v };
        }
        return null;
      },
    });
    this.authority.subscribe((e) => this.captured.push(e));
    this.epoch0 = w.simEpochMs;
    this.lastHeartbeat = this.mono0 = this.o.clock.monoMs();
    await this.o.repo.commit(this.meta, this.data);
    this.lastCheckpoint = this.lastIndustryTick = this.o.clock.monoMs();
    this.setState("open");
  }

  /** Live astronomical epoch: the host owns it while the session is open. */
  epochMs(): number {
    if (this.clockPaused) return this.epoch0;
    const liveUntil = Math.min(this.o.clock.monoMs(), this.lastHeartbeat + HOST_SILENCE_MS);
    return this.epoch0 + this.data.world.simRate * Math.max(0, liveUntil - this.mono0);
  }

  setClockPaused(paused: boolean): void {
    if (paused === this.clockPaused) return;
    this.epoch0 = this.epochMs();
    this.mono0 = this.o.clock.monoMs();
    this.clockPaused = paused;
    this.lastIndustryTick = this.mono0;
    this.tick();
  }

  /** 1 Hz from the adapter: clock samples to everyone, plus the periodic telemetry checkpoint. */
  tick(): void {
    if (this.state !== "open" && this.state !== "storage_failed") return;
    this.o.onTiming?.("tickLateMs", Math.max(0, this.o.clock.monoMs() - this.lastHeartbeat - 1000));
    this.epoch0 = this.epochMs();
    this.lastHeartbeat = this.mono0 = this.o.clock.monoMs();
    this.conns.forEach(m => {
      if (m.closeAfter !== undefined && this.o.clock.monoMs() >= m.closeAfter) this.o.transport.close(m.conn);
    });
    if (this.pendingNames.size > 0) this.flushRenames();
    const now = this.o.clock.monoMs();
    const elapsedS = (now - this.lastIndustryTick) / 1000;
    this.lastIndustryTick = now;
    if (elapsedS > 0 && this.state === "open" && !this.clockPaused && this.world.industry.depots.length) {
      // Serialize with player commands, admissions and checkpoints. Publish only changed records
      // and persist with the normal checkpoint instead of making a disk transaction per tick.
      this.enqueue(async () => {
        if (this.state !== "open" || this.clockPaused) return;
        if (this.world.industry.drones.length) updateEphemerisPositions(jdFromUnixMs(this.epochMs()));
        const stepped = this.authority.planIndustry(elapsedS);
        if (!stepped) return;
        const backup = stepped.economic ? structuredClone(this.data) : null;
        this.authority.applyIndustry(stepped);
        if (backup && !(await this.persist(backup))) return;
        if (hasIndustryDelta(stepped.delta)) this.broadcast("cmd", { t: "industry", gen: this.gen, delta: stepped.delta });
      });
    }
    this.clockStamps.push(now);
    if (this.clockStamps.length > 5) this.clockStamps.shift();
    const roster = Array.from(this.bound, ([id, conn]) => {
      const peer = this.conns.get(conn);
      const fresh = peer?.pingAt !== undefined && now - peer.pingAt < 5000;
      return { id, name: this.data.world.members[id]?.name ?? "Replicant", host: id === this.o.hostPlayerId,
        pingMs: fresh ? peer.pingMs ?? null : null };
    });
    const msg: HostMsg = { roster, t: "clock", gen: this.gen, epochMs: this.epochMs(), rate: this.clockPaused ? 0 : this.data.world.simRate, hostMonoMs: now };
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

  /** Host adapter only. The admission credential and the ship remain valid next session. */
  kick(id: PlayerId): void {
    this.enqueue(() => {
      const conn = this.bound.get(id);
      const member = conn === undefined ? undefined : this.conns.get(conn);
      if (this.state !== "open" || !member || member.local || id === this.o.hostPlayerId) return;
      this.kicked.add(id);
      this.refuse(member, "kicked");
      this.bound.delete(id);
      this.o.onPlayerCount?.(this.bound.size);
      this.enqueue(() => this.checkpoint());
    });
  }

  disconnect(conn: ConnId): void {
    const m = this.conns.get(conn);
    this.conns.delete(conn);
    if (m?.playerId && this.bound.get(m.playerId) === conn) {
      this.pilotContacts.forget(m.playerId);
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
    if (msg.t === "pong") {
      if (channel === "cmd" && this.clockStamps.includes(msg.stamp)) {
        const at = this.o.clock.monoMs();
        const rtt = at - msg.stamp;
        if (!m.local) {
          m.pingAt = at;
          m.pingMs = Math.max(0, Math.round(rtt));
        }
        if (msg.localMonoMs !== undefined && rtt >= 0 && rtt <= 200) {
          const samples = m.motionClocks ??= [];
          samples.push({ offset: msg.stamp + rtt * 0.5 - msg.localMonoMs, rtt, at });
          if (samples.length > 5) samples.shift();
        }
      }
    } else if (msg.t === "pose") {
      if (channel !== "pose") return;
      this.relayPose(m, pid, msg);
    } else if (msg.t === "impact") {
      if (channel === "cmd" && msg.by === pid && !this.data.players[pid]?.isDead) this.broadcast("cmd", msg);
    } else if (msg.t === "tel") {
      this.enqueue(() => {
        if (this.state === "open" && !m.fenced && this.bound.get(pid) === conn) this.applyTelemetry(pid, msg.tel);
      });
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
      if (this.kicked.has(hello.playerId)) return refuse("kicked");
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
    const parts = jsonParts(json, SNAPSHOT_PART_CHARS);
    for (let part = 0; part < parts.length; part++) {
      this.send(conn, { t: "snap", gen: this.gen, revision: this.data.world.revision, part, of: parts.length, json: parts[part] });
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
    const op = msg.op.type === "survey.inspect" ? this.resolveInspection(msg.op) : msg.op;
    let outcome: OperationOutcome;
    const refusal = !op ? "not_found" : pid !== this.o.hostPlayerId && HOST_ONLY.has(op.type) ? "not_allowed" : this.checkActivity(op, player);
    if (!op || refusal) {
      outcome = { status: "rejected", opId: msg.opId, by: pid, reason: refusal ?? "not_found" };
    } else {
      outcome = this.authority.submit(op, pid);
      if (op.type === "time.set" && outcome.status === "accepted") {
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
      if (shared.some(e => e.type === "ship.destroyed" || e.type === "ship.respawned")) {
        m.previousPose = m.lastPose = undefined;
        m.poseFloor = this.data.world.revision;
        this.pilotContacts.forget(pid);
      }
      const worldSlices: CommitSlices["world"] = {};
      if (shared.some((e) => e.type === "discoveries.changed")) worldSlices.discoveries = this.data.world.discoveries;
      if (shared.some((e) => e.type === "replication.changed")) worldSlices.replication = this.data.world.replication;
      if (shared.some(e => e.type === "expedition.marked")) worldSlices.rendezvous = this.data.world.rendezvous;
      this.conns.forEach((other, conn) => {
        const owner = other.playerId;
        if (!owner || other.fenced) return;
        const mine = events.filter((e): e is Extract<WorldEvent, { type: "player.changed" }> =>
          e.type === "player.changed" && e.playerId === owner);
        const playerSlices: Record<string, unknown> = {};
        for (const change of mine) for (const key of change.keys) playerSlices[key] = this.data.players[owner][key];
        this.send(conn, {
          t: "commit",
          gen: this.gen,
          revision: this.data.world.revision,
          by: pid,
          events: [...shared, ...mine],
          slices: mine.length ? { world: worldSlices, player: playerSlices } : { world: worldSlices },
        });
      });
    }
    this.send(m.conn, { t: "settled", gen: this.gen, seq: msg.seq, opId: msg.opId, outcome });
  }

  private resolveInspection(op: Extract<WorldOperation, { type: "survey.inspect" }>): typeof op | null {
    if (typeof op.fieldId !== "string" || typeof op.chunkKey !== "string" || !Number.isInteger(op.instanceId) ||
        op.instanceId < 0 || op.instanceId > 0xffffffff) return null;
    const rock = resolveHeadlessRock(op.fieldId, op.chunkKey, op.instanceId);
    return rock && buildInspectOperation(this.o.system(), {
      ...op, radiusM: rock.radiusM, chunkOriginKm: rock.localKm, localM: [0, 0, 0],
    }, op.opId);
  }

  /** Activity bounds for a mine claim (friends-only: bounds, not anti-cheat). */
  private checkActivity(op: WorldOperation, player: PlayerState): "no_activity" | "too_far" | "not_found" | "dead" | null {
    if (SPATIAL_OPS.has(op.type)) updateEphemerisPositions(jdFromUnixMs(this.epochMs()));
    if (player.isDead && op.type === "asteroid.mine") return "dead";
    if (op.type === "wreck.collect" || op.type === "survey.inspect") {
      const pose = player.ship;
      const target = op.type === "wreck.collect" ? this.world.wrecks.find(w => w.id === op.wreckId)
        : op;
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
    const d = poseDistanceKm(pose.frameId, pose.positionKm, rock.frameId, rock.positionKm);
    const range = MINE_RANGE_KM * player.shipConfig.scannerRangeMult + MINE_SLACK_KM + rock.radiusM / 1000;
    return d <= range ? null : "too_far";
  }

  /** One durable write. On failure: restore the pre-command state, stop mutations, publish nothing. */
  private async persist(backup: SaveData): Promise<boolean> {
    this.data.world.simEpochMs = this.epochMs();
    const start = this.o.onTiming ? this.o.clock.monoMs() : 0;
    try {
      await this.o.repo.commit(this.meta, this.data);
      this.lastCheckpoint = this.o.clock.monoMs();
      this.o.onTiming?.("writeMs", this.lastCheckpoint - start);
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
    if (t.prefs) {
      if (t.prefs.commsPlayed) p.commsPlayed = t.prefs.commsPlayed;
      if (t.prefs.starMarkers) p.starMarkers = t.prefs.starMarkers;
      if (t.prefs.aiName !== undefined) p.aiName = t.prefs.aiName;
      if (t.prefs.trackedProject !== undefined) p.trackedProject = t.prefs.trackedProject;
      if (t.prefs.trackedMarkers) p.trackedMarkers = t.prefs.trackedMarkers;
    }
    const member = this.conns.get(this.bound.get(pid) ?? "");
    // An in-flight sample from the destroyed hull must not replace the committed recovery pose or fuel.
    if ((t.revision ?? 0) < (member?.poseFloor ?? 0)) return;
    if (member && t.pose && t.propellant && !p.isDead) member.telemetryAt = this.o.clock.monoMs();
    if (member && t.reservedFuelKg !== undefined) member.reservedFuelKg = t.reservedFuelKg;
    if (t.pose && !p.isDead) p.ship = { frameId: t.pose.frameId, positionKm: t.pose.positionKm, quaternion: t.pose.quaternion };
    if (t.health !== undefined && !p.isDead) p.health = Math.min(t.health, p.shipConfig.maxHealth);
    // Bounds, not anti-cheat: never above the tank, and the protected reserve only drains.
    if (t.propellant && !p.isDead) {
      const awaitingCredit = Math.max(0, p.receivedFuelKg - (t.receivedFuelKg ?? 0));
      const awaitingDebit = Math.max(0, p.depositedFuelKg - (t.depositedFuelKg ?? 0));
      p.propellant = {
        ordinaryKg: Math.max(0, Math.min(t.propellant.ordinaryKg + awaitingCredit - awaitingDebit, tankCapacityKg(p, this.data.world))),
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
  }

  private relayPose(m: Member, pid: PlayerId, pose: PoseMsg): void {
    if (this.data.players[pid]?.isDead || pose.id !== pid || pose.revision < (m.poseFloor ?? 0) || pose.seq <= (m.lastPose?.seq ?? -1)) return;
    m.previousPose = m.lastPose;
    m.lastPose = pose;
    m.poseAt = this.o.clock.monoMs();
    this.conns.forEach((other, conn) => {
      if (conn !== m.conn && other.playerId && !other.fenced) {
        this.o.transport.send(conn, "pose", pose);
        this.resolvePilotContact(m, pid, other, other.playerId, m.poseAt!);
      }
    });
  }

  private resolvePilotContact(one: Member, oneId: PlayerId, two: Member, twoId: PlayerId, now: number): void {
    const onePose = one.lastPose!, twoPose = two.lastPose;
    if (this.state !== "open" || this.clockPaused || this.data.players[twoId]?.isDead || !twoPose || onePose.f !== twoPose.f) return;
    // Two normal-flight hulls stay within 400 m over the allowed sample window. No track work for distant pilots.
    if (Math.hypot(onePose.p[0] - twoPose.p[0], onePose.p[1] - twoPose.p[1], onePose.p[2] - twoPose.p[2]) > 0.4) return;
    const [a, aId, b, bId] = oneId < twoId ? [one, oneId, two, twoId] as const : [two, twoId, one, oneId] as const;
    const track = (m: Member): { track: PilotTrack; rtt: number } | null => {
      const pose = m.lastPose, previous = m.previousPose;
      if (!pose || !previous || !isFrameId(pose.f) || pose.motion === undefined) return null;
      const samples = m.motionClocks;
      if (!samples) return null;
      const timing = samples.reduce<(typeof samples)[number] | null>((best, s) =>
        now - s.at <= 4000 && (!best || s.rtt < best.rtt) ? s : best, null);
      if (!timing) return null;
      const at = timing.offset + pose.tick;
      if (at > now + 25 || now - at > 220) return null;
      return { track: { latest: { pose, at }, previous: { pose: previous, at: timing.offset + previous.tick } }, rtt: timing.rtt };
    };
    const ta = track(a), tb = track(b);
    if (!ta || !tb) return;
    const hit = this.pilotContacts.observe(JSON.stringify([aId, bId]), ta.track, tb.track, now, (ta.rtt + tb.rtt) * 0.5);
    if (!hit) return;
    const id = ++this.pilotContactId;
    const send = (m: Member, other: PlayerId, direction: typeof hit.normal): void => {
      const p = m.lastPose!;
      this.send(m.conn, { t: "pilotContact", gen: this.gen, id, other, motion: p.motion!, tick: p.tick,
        correctionM: hit.correctionM, damage: hit.damage, contact: { frameId: p.f, positionKm: hit.positionKm, direction, dvMps: hit.dvMps } });
    };
    send(a, bId, hit.normal);
    send(b, aId, [-hit.normal[0], -hit.normal[1], -hit.normal[2]]);
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
    const parts = msg.t === "commit" ? frameReliableUpdate(msg) : [msg];
    for (const part of parts) this.o.transport.send(conn, "cmd", part);
  }

  private broadcast(channel: Channel, msg: HostMsg): void {
    const parts = msg.t === "industry" ? frameReliableUpdate(msg) : [msg];
    this.conns.forEach((m, conn) => {
      if (m.playerId && !m.fenced) {
        for (const part of parts) this.o.transport.send(conn, channel, part);
      }
    });
  }

  private setState(s: HostState, detail?: string): void {
    this.state = s;
    this.o.onState?.(s, detail);
  }
}
