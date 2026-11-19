/**
 * Co-op session wire protocol (M4.0): plain serializable messages, decoded at ingress with runtime
 * bounds. Two channels: `cmd` (reliable, ordered) and `pose` (unordered, no retransmits).
 * Nothing here knows about WebRTC, workers or React.
 */
import { MAX_HEAT_FRACTION } from "@/sim/ship/shipResources";
import type { Difficulty, PlayerId, QuatTuple, SaveData, Vec3Tuple } from "@/save/types";
import type { OperationOutcome, ShipContact, WorldEvent, WorldOperation } from "@/sim/world/commands";

export const PROTOCOL_VERSION = 5;
/** Three missed worker heartbeats suspend prediction and new resource spends. */
export const HOST_SILENCE_MS = 3000;
export const MAX_PLAYERS = 4;
/** Snapshot JSON is sent in parts of this many characters. */
export const SNAPSHOT_PART_CHARS = 16_000;
const MAX_SNAPSHOT_PARTS = 2_000;
const MAX_OP_CHARS = 8_192;
const MAX_ID = 128;
export const MAX_NAME = 32;

export type Channel = "cmd" | "pose";
export type RefuseReason = "full" | "protocol" | "content" | "credential" | "replaced" | "kicked" | "closed";

export interface CrewMember { id: PlayerId; name: string; host: boolean; pingMs: number | null }

/** Pilot-owned values a client reports; the host bounds them and writes them without a revision. */
export interface Telemetry {
  pose?: { frameId: string; positionKm: Vec3Tuple; quaternion: QuatTuple };
  health?: number;
  /** Sender's inbound fuel counter and ordinary fuel reserved for braking. */
  receivedFuelKg?: number;
  reservedFuelKg?: number;
  propellant?: { ordinaryKg: number; protectedKg: number };
  power?: { capacitor01: number; heat01: number };
  processing?: { id: string; elapsedS: number; committedKg: number };
  prefs?: { commsPlayed?: string[]; starMarkers?: string[]; aiName?: string | null; trackedProject?: string | null };
}

export interface PoseMsg {
  t: "pose";
  id: PlayerId;
  seq: number;
  /** Last commit seen by the sender. Peers discard poses from before its latest respawn. */
  revision: number;
  gen: number;
  tick: number;
  f: string;
  p: Vec3Tuple;
  v: Vec3Tuple;
  q: QuatTuple;
  /** Bit 0 beam, bit 1 boost, bit 2 beam in a pulse's off phase (dim). */
  fl: number;
  /** Main-engine throttle 0..255 (the plume others draw). */
  th?: number;
  /** Beam endpoint on the rock, sender's frame km (with fl bit 0). */
  b?: Vec3Tuple;
}

/** A beam endpoint farther than this from the sender is dropped (wire sanity bound above base and upgraded mining ranges, including surface offsets). */
export const MAX_BEAM_KM = 50;

export type ImpactMsg = { t: "impact"; gen: number; by: PlayerId; contact: ShipContact };

export type ClientMsg =
  | { t: "hello"; protocol: number; content: string; name: string; playerId?: PlayerId; credential?: string }
  | { t: "cmd"; gen: number; seq: number; opId: string; op: WorldOperation; tel?: Telemetry }
  | { t: "pong"; gen: number; stamp: number }
  | { t: "tel"; gen: number; tel: Telemetry }
  | { t: "name"; gen: number; name: string }
  | ImpactMsg
  | PoseMsg;

export interface WelcomeMsg {
  t: "welcome";
  playerId: PlayerId;
  /** Only on first admission; the guest stores it to rejoin. */
  credential?: string;
  gen: number;
  worldId: string;
  worldName: string;
  difficulty: Difficulty;
  hostName: string;
  revision: number;
}

/** Changed slices that ride with a commit: world slices for everyone, player slices for the actor only. */
export interface CommitSlices {
  world?: { rendezvous?: SaveData["world"]["rendezvous"]; discoveries?: SaveData["world"]["discoveries"]; replication?: SaveData["world"]["replication"] };
  player?: Record<string, unknown>;
}

export type HostMsg =
  | WelcomeMsg
  | { t: "refuse"; reason: RefuseReason }
  | { t: "snap"; gen: number; revision: number; part: number; of: number; json: string }
  | { t: "commit"; gen: number; revision: number; by: PlayerId; events: WorldEvent[]; slices: CommitSlices }
  | { t: "settled"; gen: number; seq: number; opId: string; outcome: OperationOutcome; replay?: boolean }
  | { t: "watermark"; gen: number; seq: number }
  | { t: "resend"; gen: number; from: number }
  | { t: "clock"; gen: number; epochMs: number; rate: number; hostMonoMs: number; roster: CrewMember[] }
  | { t: "status"; gen: number; state: "ok" | "storage_failed" | "closing" }
  | { t: "members"; gen: number; names: Record<PlayerId, string> }
  | ImpactMsg
  | PoseMsg;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => isNum(v) && Number.isInteger(v) && v >= 0 && v <= max;
const isStr = (v: unknown, max = MAX_ID): v is string => typeof v === "string" && v.length <= max;
const BIG_KM = 1e12;
const vec = (v: unknown, n: number, bound: number): boolean => Array.isArray(v) && v.length === n && v.every((x) => isNum(x) && Math.abs(x) <= bound);

function sizeOk(v: unknown, max: number): boolean {
  try {
    return JSON.stringify(v).length <= max;
  } catch {
    return false;
  }
}

function strList(v: unknown, maxN: number): string[] | undefined {
  if (!Array.isArray(v) || v.length > maxN || !v.every((x) => isStr(x, MAX_ID))) return undefined;
  return v as string[];
}

/** Bounded telemetry, or null if any present field is malformed. */
export function decodeTelemetry(v: unknown): Telemetry | null {
  if (!isObj(v)) return null;
  const out: Telemetry = {};
  if (v.pose !== undefined) {
    const p = v.pose;
    if (!isObj(p) || !isStr(p.frameId, 32) || !vec(p.positionKm, 3, BIG_KM) || !vec(p.quaternion, 4, 1.01)) return null;
    out.pose = { frameId: p.frameId, positionKm: [...(p.positionKm as Vec3Tuple)], quaternion: [...(p.quaternion as QuatTuple)] };
  }
  for (const key of ["receivedFuelKg", "reservedFuelKg"] as const) {
    const value = v[key];
    if (value !== undefined) {
      if (!isNum(value) || value < 0) return null;
      out[key] = value;
    }
  }
  if (v.health !== undefined) {
    if (!isNum(v.health) || v.health < 0 || v.health > 1e6) return null;
    out.health = v.health;
  }
  if (v.propellant !== undefined) {
    const p = v.propellant;
    if (!isObj(p) || !isNum(p.ordinaryKg) || !isNum(p.protectedKg) || p.ordinaryKg < 0 || p.protectedKg < 0 || p.ordinaryKg > 1e7 || p.protectedKg > 1e7) return null;
    out.propellant = { ordinaryKg: p.ordinaryKg, protectedKg: p.protectedKg };
  }
  if (v.power !== undefined) {
    const p = v.power;
    if (!isObj(p) || !isNum(p.capacitor01) || !isNum(p.heat01)) return null;
    out.power = { capacitor01: Math.min(1, Math.max(0, p.capacitor01)), heat01: Math.min(MAX_HEAT_FRACTION, Math.max(0, p.heat01)) };
  }
  if (v.processing !== undefined) {
    const p = v.processing;
    if (!isObj(p) || !isStr(p.id) || !isNum(p.elapsedS) || !isNum(p.committedKg) || p.elapsedS < 0 || p.committedKg < 0) return null;
    out.processing = { id: p.id, elapsedS: p.elapsedS, committedKg: p.committedKg };
  }
  if (v.prefs !== undefined) {
    const p = v.prefs;
    if (!isObj(p)) return null;
    const prefs: NonNullable<Telemetry["prefs"]> = {};
    if (p.commsPlayed !== undefined && !(prefs.commsPlayed = strList(p.commsPlayed, 512))) return null;
    if (p.starMarkers !== undefined && !(prefs.starMarkers = strList(p.starMarkers, 256))) return null;
    if (p.aiName !== undefined) {
      if (p.aiName !== null && !isStr(p.aiName, MAX_NAME)) return null;
      prefs.aiName = p.aiName as string | null;
    }
    if (p.trackedProject !== undefined) {
      if (p.trackedProject !== null && !isStr(p.trackedProject, 64)) return null;
      prefs.trackedProject = p.trackedProject as string | null;
    }
    out.prefs = prefs;
  }
  return out;
}

function decodeImpact(raw: Obj): ImpactMsg | null {
  const c = raw.contact;
  if (!isInt(raw.gen) || !isStr(raw.by) || !isObj(c) || !isStr(c.frameId, 32)
    || !vec(c.positionKm, 3, BIG_KM) || !vec(c.direction, 3, 1.01)
    || !isNum(c.dvMps) || c.dvMps < 0 || c.dvMps > 1e6) return null;
  return { t: "impact", gen: raw.gen, by: raw.by, contact: { frameId: c.frameId, positionKm: c.positionKm as Vec3Tuple, direction: c.direction as Vec3Tuple, dvMps: c.dvMps } };
}

export function decodePose(v: Obj): PoseMsg | null {
  if (!isStr(v.id) || !isInt(v.seq) || !isInt(v.revision) || !isInt(v.gen) || !isNum(v.tick) || !isStr(v.f, 32)) return null;
  if (!vec(v.p, 3, BIG_KM) || !vec(v.v, 3, 1e6) || !vec(v.q, 4, 1.01) || !isInt(v.fl, 255)) return null;
  const out: PoseMsg = { t: "pose", id: v.id, seq: v.seq, revision: v.revision, gen: v.gen, tick: v.tick, f: v.f, p: v.p as Vec3Tuple, v: v.v as Vec3Tuple, q: v.q as QuatTuple, fl: v.fl };
  // Optional activity: a malformed field is dropped, the pose kept.
  if (isInt(v.th, 255)) out.th = v.th;
  if (vec(v.b, 3, BIG_KM)) {
    const b = v.b as Vec3Tuple;
    if (Math.hypot(b[0] - out.p[0], b[1] - out.p[1], b[2] - out.p[2]) <= MAX_BEAM_KM) out.b = [b[0], b[1], b[2]];
  }
  return out;
}

/** Control and format characters (zero-width, bidi overrides) never reach a label. */
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]|\udb40[\udc00-\udc7f]/g;

/** A pilot's display name: invisible characters stripped, whitespace collapsed, bounded; "" when nothing is left. */
export function cleanName(v: string): string {
  return v.replace(INVISIBLE_RE, "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
}

/** A pilot's display name: cleaned, bounded, never empty. */
export function decodeName(v: unknown): string | null {
  if (!isStr(v, 64)) return null;
  const n = cleanName(v);
  return n ? n : null;
}

/** Untrusted guest input → a typed message, or null (dropped). Op contents are the reducer's to validate. */
export function decodeClientMsg(raw: unknown): ClientMsg | null {
  if (!isObj(raw) || typeof raw.t !== "string") return null;
  switch (raw.t) {
    case "hello": {
      if (!isInt(raw.protocol, 1e6) || !isStr(raw.content, 64) || !isStr(raw.name, 64)) return null;
      if (raw.playerId !== undefined && !isStr(raw.playerId)) return null;
      if (raw.credential !== undefined && !isStr(raw.credential)) return null;
      return {
        t: "hello",
        protocol: raw.protocol,
        content: raw.content,
        name: cleanName(raw.name),
        ...(raw.playerId !== undefined ? { playerId: raw.playerId as string } : {}),
        ...(raw.credential !== undefined ? { credential: raw.credential as string } : {}),
      };
    }
    case "cmd": {
      if (!isInt(raw.gen) || !isInt(raw.seq) || raw.seq < 1 || !isStr(raw.opId) || raw.opId === "") return null;
      const op = raw.op;
      if (!isObj(op) || typeof op.type !== "string" || op.opId !== raw.opId || !sizeOk(op, MAX_OP_CHARS)) return null;
      let tel: Telemetry | undefined;
      if (raw.tel !== undefined) {
        const t = decodeTelemetry(raw.tel);
        if (!t) return null;
        tel = t;
      }
      return { t: "cmd", gen: raw.gen, seq: raw.seq, opId: raw.opId, op: op as unknown as WorldOperation, ...(tel ? { tel } : {}) };
    }
    case "pong":
      return isInt(raw.gen) && isNum(raw.stamp) ? { t: "pong", gen: raw.gen, stamp: raw.stamp } : null;
    case "tel": {
      const tel = isInt(raw.gen) ? decodeTelemetry(raw.tel) : null;
      return tel ? { t: "tel", gen: raw.gen as number, tel } : null;
    }
    case "name": {
      const name = isInt(raw.gen) ? decodeName(raw.name) : null;
      return name ? { t: "name", gen: raw.gen as number, name } : null;
    }
    case "impact": return decodeImpact(raw);
    case "pose":
      return decodePose(raw);
    default:
      return null;
  }
}

/**
 * Host input. The host is trusted for content but not for shape: a malformed message is dropped
 * rather than crashing the client's mirror.
 */
export function decodeHostMsg(raw: unknown): HostMsg | null {
  if (!isObj(raw) || typeof raw.t !== "string") return null;
  switch (raw.t) {
    case "welcome":
      if (!isStr(raw.playerId) || !isInt(raw.gen) || !isStr(raw.worldId) || !isStr(raw.worldName, 256) || !isInt(raw.revision)) return null;
      if (raw.credential !== undefined && !isStr(raw.credential)) return null;
      if (raw.difficulty !== "explorer" && raw.difficulty !== "standard" && raw.difficulty !== "hard") return null;
      return raw as unknown as HostMsg;
    case "refuse":
      return ["full", "protocol", "content", "credential", "replaced", "kicked", "closed"].includes(raw.reason as string) ? (raw as unknown as HostMsg) : null;
    case "snap":
      if (!isInt(raw.gen) || !isInt(raw.revision) || !isInt(raw.of, MAX_SNAPSHOT_PARTS) || !isInt(raw.part) || raw.part >= raw.of) return null;
      return typeof raw.json === "string" && raw.json.length <= SNAPSHOT_PART_CHARS ? (raw as unknown as HostMsg) : null;
    case "commit":
      return isInt(raw.gen) && isInt(raw.revision) && isStr(raw.by) && Array.isArray(raw.events) && isObj(raw.slices) ? (raw as unknown as HostMsg) : null;
    case "settled":
      return isInt(raw.gen) && isInt(raw.seq) && isStr(raw.opId) && isObj(raw.outcome) && typeof raw.outcome.status === "string" ? (raw as unknown as HostMsg) : null;
    case "watermark":
      return isInt(raw.gen) && isInt(raw.seq) ? (raw as unknown as HostMsg) : null;
    case "resend":
      return isInt(raw.gen) && isInt(raw.from) ? (raw as unknown as HostMsg) : null;
    case "clock":
      if (!Array.isArray(raw.roster) || raw.roster.length > MAX_PLAYERS ||
          !raw.roster.every(p => isObj(p) && isStr(p.id) && isStr(p.name, MAX_NAME) && typeof p.host === "boolean" &&
            (p.pingMs === null || isInt(p.pingMs)))) return null;
      return isInt(raw.gen) && isNum(raw.epochMs) && isNum(raw.rate) && isNum(raw.hostMonoMs) ? (raw as unknown as HostMsg) : null;
    case "status":
      return isInt(raw.gen) && ["ok", "storage_failed", "closing"].includes(raw.state as string) ? (raw as unknown as HostMsg) : null;
    case "members": {
      if (!isInt(raw.gen) || !isObj(raw.names)) return null;
      const entries = Object.entries(raw.names);
      if (entries.length > MAX_PLAYERS * 4 || !entries.every(([k, n]) => isStr(k) && isStr(n, MAX_NAME))) return null;
      return raw as unknown as HostMsg;
    }
    case "impact": return decodeImpact(raw);
    case "pose":
      return decodePose(raw);
    default:
      return null;
  }
}
