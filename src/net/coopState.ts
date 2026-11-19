/**
 * Co-op runtime state shared by the controllers, the HUD pill and RemoteShips: role, room code,
 * connection status and a short pose buffer per remote pilot. Module state (like appState):
 * the session outlives any one component.
 */
import type { PlayerId } from "@/save/types";
import type { PoseMsg } from "@/sim/session/protocol";

export type CoopRole = "solo" | "host" | "guest";
export type CoopStatus = "idle" | "starting" | "connecting" | "joined" | "waiting" | "refused" | "error" | "closed";

export interface CoopSnapshot {
  role: CoopRole;
  status: CoopStatus;
  code: string | null;
  detail: string | null;
  players: number;
}

export interface PoseSample {
  /** Sender's frame time mapped to local performance.now, ms. */
  at: number;
  seq: number;
  gen: number;
  f: string;
  p: [number, number, number];
  v: [number, number, number];
  q: [number, number, number, number];
  fl: number;
  /** Throttle 0..1. */
  th: number;
  /** Beam endpoint, sender frame km (null when no beam). */
  b: [number, number, number] | null;
}

const POSE_BUFFER = 8;
/** Poses (15 Hz) never arrive this far out of order: ~4 s. */
const SEQ_RESTART_GAP = 60;
/** No pose for this long, then a lower seq: the sender restarted (poses arrive at 15 Hz). */
const SILENCE_RESTART_MS = 1000;
/** A pilot with no pose for this long is hidden (left, or link down). */
export const REMOTE_STALE_MS = 5000;

let snap: CoopSnapshot = { role: "solo", status: "idle", code: null, detail: null, players: 1 };
const listeners = new Set<() => void>();

export const coopSnapshot = (): CoopSnapshot => snap;
export function subscribeCoop(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function setCoop(patch: Partial<CoopSnapshot>): void {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
}

/** Remote pilots' recent poses, newest last. */
export const remotePoses = new Map<PlayerId, PoseSample[]>();

/** Per pilot: recent (arrival − sender tick), ms. Its minimum is the least-delayed path. */
const clockOffsets = new Map<PlayerId, number[]>();
const OFFSET_WINDOW = 45;

/**
 * Sender time → local time. Arrival stamps carried the network's jitter into the interpolation
 * (MEASURED: 0.9 m p50 / 3 m p95 twitch at 324 m/s); the sender's frame time does not.
 */
function localTimeOf(id: PlayerId, tick: number, reset: boolean): number {
  const now = performance.now();
  let w = clockOffsets.get(id);
  if (!w || reset) clockOffsets.set(id, (w = []));
  w.push(now - tick);
  if (w.length > OFFSET_WINDOW) w.shift();
  return tick + Math.min(...w);
}

export function pushRemotePose(m: PoseMsg): void {
  let buf = remotePoses.get(m.id);
  if (!buf) remotePoses.set(m.id, (buf = []));
  const last = buf[buf.length - 1];
  // A seq far behind the last one is the sender restarting its counter (page reload), not reordering.
  // So is any lower seq after a silence: a reload rejoins long before its new counter catches up.
  const restarted = last !== undefined && m.seq <= last.seq && (last.seq - m.seq > SEQ_RESTART_GAP || performance.now() - last.at > SILENCE_RESTART_MS);
  if (last && last.gen === m.gen && m.seq <= last.seq && !restarted) return;
  const reset = !last || last.gen !== m.gen || restarted;
  if (last && reset) buf.length = 0;
  const at = localTimeOf(m.id, m.tick, reset);
  // Same frame sent twice (the sender's frames stalled): nothing new to interpolate toward.
  if (!reset && last && at <= last.at) return;
  buf.push({ at, seq: m.seq, gen: m.gen, f: m.f, p: m.p, v: m.v, q: m.q, fl: m.fl, th: (m.th ?? 0) / 255, b: m.fl & 1 && m.b ? m.b : null });
  if (buf.length > POSE_BUFFER) buf.shift();
}

/** Clock samples from the host, consumed by the in-Canvas clock follower. */
export const hostClock = { epochMs: 0, rate: 1, at: -1 };

/** Last connection steps (tests and bug reports). */
export const coopLog: string[] = [];
export function logCoop(msg: string): void {
  coopLog.push(`${Math.round(performance.now())} ${msg}`);
  if (coopLog.length > 40) coopLog.shift();
}
