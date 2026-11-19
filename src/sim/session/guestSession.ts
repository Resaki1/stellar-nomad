/**
 * Client side of a co-op session (headless): handshake, snapshot mirror, ONE in-flight intent with
 * a durable pending record (a reload or reconnect retries the same seq/opId), commit application
 * and heartbeat. Used by guests and by the host's own main thread.
 */
import type { PlayerId, SaveData, SaveMeta } from "@/save/types";
import type { OperationOutcome, ShipContact, WorldEvent, WorldOperation } from "@/sim/world/commands";
import { PROTOCOL_VERSION, decodeHostMsg, type Channel, type HostMsg, type PoseMsg, type RefuseReason, type Telemetry, type WelcomeMsg } from "./protocol";
import type { ClientLink, Clock } from "./ports";

/** No host message for this long → "Waiting for host" (new commands queue). */
export const HOST_SILENCE_MS = 3_000;

export interface PendingIntent {
  seq: number;
  opId: string;
  op: WorldOperation;
}

/** What a guest keeps per host world (localStorage in the browser). */
export interface GuestRecord {
  playerId?: PlayerId;
  credential?: string;
  pending?: PendingIntent | null;
}

export interface GuestStore {
  load(): GuestRecord;
  save(rec: GuestRecord): void;
}

export type GuestState = "connecting" | "syncing" | "joined" | "refused" | "closed";

export interface GuestSessionOptions {
  clock: Clock;
  name: string;
  content: string;
  store: GuestStore;
  /** The host's own client: admitted by its device id without a credential. */
  local?: boolean;
  playerId?: PlayerId;
  telemetry?: () => Telemetry | undefined;
  onEvent?: (e: WorldEvent) => void;
  /** Records a destroyed rock in the mirror (default: append to its deltas). The browser keeps its index in step. */
  onAsteroid?: (fieldId: string, chunkKey: string, instanceId: number) => void;
  onSnapshot?: (rec: { meta: SaveMeta; data: SaveData }, welcome: WelcomeMsg) => void;
  onState?: (s: GuestState, detail?: RefuseReason) => void;
  onPose?: (p: PoseMsg) => void;
  onClock?: (c: Extract<HostMsg, { t: "clock" }>) => void;
}

export class GuestSession {
  private link: ClientLink | null = null;
  private state: GuestState = "closed";
  private gen = -1;
  private welcome: WelcomeMsg | null = null;
  private parts: string[] = [];
  private partsGot = 0;
  private lastHostMs = -Infinity;
  private streamSeq = 0;
  // Infinity hides a dead pilot. Respawn fences pre-death poses still in the unordered channel.
  private readonly poseFloor = new Map<PlayerId, number>();
  private snapshotRevision = 0;
  private readonly queue: WorldOperation[] = [];
  private rec: GuestRecord;
  /** Sent in hello; a rename updates it so a rejoin keeps it. */
  private name: string;
  mirror: { meta: SaveMeta; data: SaveData } | null = null;
  revision = 0;
  storageFailed = false;
  hostClosing = false;
  refusal: RefuseReason | null = null;

  constructor(private readonly o: GuestSessionOptions) {
    this.rec = o.store.load();
    this.name = o.name;
  }

  get playerId(): PlayerId | null {
    return this.welcome?.playerId ?? null;
  }
  get generation(): number {
    return this.gen;
  }
  get status(): GuestState {
    return this.state;
  }
  get pending(): PendingIntent | null {
    return this.rec.pending ?? null;
  }
  /** True while the host has been silent too long: the UI shows "Waiting for host". */
  waiting(): boolean {
    return this.state === "joined" && this.o.clock.monoMs() - this.lastHostMs > HOST_SILENCE_MS;
  }

  // ── transport events ─────────────────────────────────────────────────────

  attach(link: ClientLink): void {
    this.link = link;
    this.setState("connecting");
  }

  opened(): void {
    const id = this.o.local ? this.o.playerId : this.rec.playerId;
    this.link?.send("cmd", {
      t: "hello",
      protocol: PROTOCOL_VERSION,
      content: this.o.content,
      name: this.name,
      ...(id ? { playerId: id } : {}),
      ...(!this.o.local && this.rec.credential ? { credential: this.rec.credential } : {}),
    });
  }

  closed(): void {
    this.link = null;
    if (this.state !== "refused") this.setState("closed");
  }

  receive(channel: Channel, raw: unknown): void {
    if (!this.link) return; // A queued transport message may arrive after leave.
    const msg = decodeHostMsg(raw);
    if (!msg) return;
    this.lastHostMs = this.o.clock.monoMs();
    if (msg.t === "welcome") return this.onWelcome(msg);
    if (msg.t === "refuse") {
      this.refusal = msg.reason;
      this.setState("refused", msg.reason);
      this.link?.close();
      return;
    }
    if (msg.gen !== this.gen) return;
    switch (msg.t) {
      case "snap":
        return this.onSnap(msg);
      case "commit":
        return this.onCommit(msg);
      case "settled":
        return this.onSettled(msg);
      case "watermark":
        return this.onWatermark(msg.seq);
      case "resend":
        if (this.rec.pending && this.rec.pending.seq >= msg.from) this.sendPending();
        return;
      case "clock":
        this.o.onClock?.(msg);
        return;
      case "status":
        this.hostClosing = msg.state === "closing";
        this.storageFailed = msg.state === "storage_failed";
        return;
      case "members":
        return this.onMembers(msg.names);
      case "impact":
        if (this.state === "joined" && channel === "cmd" && msg.by !== this.playerId) {
          this.o.onEvent?.({ type: "ship.contact", by: msg.by, ...msg.contact });
        }
        return;
      case "pose": {
        if (this.state !== "joined" || channel !== "pose" || msg.id === this.playerId) return;
        const minRevision = this.poseFloor.get(msg.id) ?? this.snapshotRevision;
        if (msg.revision >= minRevision) this.o.onPose?.(msg);
        return;
      }
    }
  }

  // ── commands ─────────────────────────────────────────────────────────────

  /** Queue an intent; it settles later through an `op.settled` event. */
  submit(op: WorldOperation): OperationOutcome {
    if (this.state === "refused") return { status: "rejected", opId: op.opId, by: this.playerId ?? "", reason: "not_allowed" };
    this.queue.push(op);
    this.pump();
    return { status: "pending", opId: op.opId, by: this.playerId ?? "" };
  }

  sendTelemetry(): void {
    // A later sample must observe this pilot’s pending spend or repair before it can overwrite the result.
    if (this.rec.pending || this.state !== "joined") return;
    const tel = this.o.telemetry?.();
    if (tel) this.link?.send("cmd", { t: "tel", gen: this.gen, tel });
  }

  /** The pilot renamed: tell the host now (members reach everyone), and use it on rejoin. */
  rename(name: string): void {
    if (name === this.name) return;
    this.name = name;
    if (this.state === "joined") this.link?.send("cmd", { t: "name", gen: this.gen, name });
  }

  sendImpact(contact: ShipContact): void {
    if (this.playerId && this.state === "joined") this.link?.send("cmd", { t: "impact", by: this.playerId, gen: this.gen, contact });
  }

  sendPose(p: Omit<PoseMsg, "t" | "id" | "gen" | "revision">): void {
    const id = this.playerId;
    if (id && this.state === "joined") this.link?.send("pose", { t: "pose", id, gen: this.gen, revision: this.revision, ...p });
  }

  close(): void {
    this.link?.close();
  }

  private pump(): void {
    if (this.rec.pending || this.state !== "joined") return;
    const op = this.queue.shift();
    if (!op) return;
    this.rec.pending = { seq: this.streamSeq + 1, opId: op.opId, op };
    this.o.store.save(this.rec);
    this.sendPending();
  }

  private sendPending(): void {
    const p = this.rec.pending;
    if (!p || !this.link || this.state !== "joined") return;
    const tel = this.o.telemetry?.();
    this.link.send("cmd", { t: "cmd", gen: this.gen, seq: p.seq, opId: p.opId, op: p.op, ...(tel ? { tel } : {}) });
  }

  // ── host messages ────────────────────────────────────────────────────────

  private onWelcome(w: WelcomeMsg): void {
    this.hostClosing = false;
    this.welcome = w;
    this.gen = w.gen;
    this.parts = [];
    this.partsGot = 0;
    if (!this.o.local) {
      this.rec.playerId = w.playerId;
      if (w.credential) this.rec.credential = w.credential;
      this.o.store.save(this.rec);
    }
    this.setState("syncing");
  }

  private onSnap(s: Extract<HostMsg, { t: "snap" }>): void {
    if (s.part === 0) {
      this.parts = new Array<string>(s.of);
      this.partsGot = 0;
    }
    if (this.parts.length !== s.of || this.parts[s.part] !== undefined) return;
    this.parts[s.part] = s.json;
    if (++this.partsGot < s.of) return;
    const rec = JSON.parse(this.parts.join("")) as { meta: SaveMeta; data: SaveData; deadPilots: PlayerId[] };
    this.parts = [];
    const pid = this.playerId;
    const me = pid ? rec.data.players[pid] : undefined;
    if (!me || !this.welcome) return;
    this.mirror = rec;
    this.revision = this.snapshotRevision = s.revision;
    this.poseFloor.clear();
    for (const id of rec.deadPilots) this.poseFloor.set(id, Infinity);
    this.streamSeq = me.stream.seq;
    const p = this.rec.pending;
    // An intent older than the stream (and not its last entry) can never execute: drop it.
    if (p && p.seq < this.streamSeq) this.dropPending();
    this.setState("joined");
    this.o.onSnapshot?.(rec, this.welcome);
    if (this.rec.pending) this.sendPending();
    else this.pump();
  }

  private onCommit(c: Extract<HostMsg, { t: "commit" }>): void {
    const m = this.mirror;
    if (!m || c.revision <= this.revision) return;
    this.revision = c.revision;
    const w = m.data.world;
    w.revision = c.revision;
    for (const e of c.events) {
      switch (e.type) {
        case "asteroid.destroyed":
          if (this.o.onAsteroid) this.o.onAsteroid(e.fieldId, e.chunkKey, e.instanceId);
          else ((w.asteroidDeltas[e.fieldId] ??= {})[e.chunkKey] ??= []).push(e.instanceId);
          break;
        case "ship.destroyed":
          this.poseFloor.set(e.by, Infinity);
          break;
        case "ship.respawned":
          this.poseFloor.set(e.by, c.revision);
          break;
        case "wreck.created":
          w.wrecks = [...w.wrecks, e.wreck];
          break;
        case "wreck.changed":
          w.wrecks = w.wrecks.map((x) => (x.id === e.wreck.id ? e.wreck : x));
          break;
        case "wreck.removed":
          w.wrecks = w.wrecks.filter((x) => x.id !== e.wreckId);
          break;
        case "research.changed":
          w.research = { ...w.research, completedNodes: [...e.completedNodes] };
          break;
        case "time.changed":
          if (e.epochMs !== undefined) w.simEpochMs = e.epochMs;
          if (e.rate !== undefined) w.simRate = e.rate;
          break;
      }
    }
    if (c.slices.world?.discoveries) w.discoveries = c.slices.world.discoveries;
    if (c.slices.world?.replication) w.replication = c.slices.world.replication;
    const pid = this.playerId;
    const me = pid ? m.data.players[pid] : undefined;
    if (me && c.slices.player) Object.assign(me, c.slices.player);
    c.events.forEach((e) => this.o.onEvent?.(e));
  }

  /** Names of pilots admitted after our snapshot (labels). Credentials stay with the host. */
  private onMembers(names: Record<PlayerId, string>): void {
    const members = this.mirror?.data.world.members;
    if (!members) return;
    for (const [id, name] of Object.entries(names)) {
      if (members[id]) members[id].name = name;
      else members[id] = { name, verifier: null, joinedAt: 0 };
    }
  }

  private onSettled(s: Extract<HostMsg, { t: "settled" }>): void {
    const p = this.rec.pending;
    if (!p || s.seq !== p.seq || s.opId !== p.opId) return;
    this.streamSeq = s.seq;
    const me = this.playerId && this.mirror?.data.players[this.playerId];
    if (me) me.stream = { seq: s.seq, opId: s.opId, outcome: s.outcome };
    this.rec.pending = null;
    this.o.store.save(this.rec);
    this.o.onEvent?.({ type: "op.settled", outcome: s.outcome });
    this.pump();
  }

  private onWatermark(seq: number): void {
    this.streamSeq = seq;
    const p = this.rec.pending;
    if (p && p.seq <= seq) this.dropPending();
  }

  private dropPending(): void {
    const p = this.rec.pending;
    if (!p) return;
    this.rec.pending = null;
    this.o.store.save(this.rec);
    this.o.onEvent?.({ type: "op.settled", outcome: { status: "rejected", opId: p.opId, by: this.playerId ?? "", reason: "invalid" } });
  }

  private setState(s: GuestState, detail?: RefuseReason): void {
    this.state = s;
    this.o.onState?.(s, detail);
  }
}
