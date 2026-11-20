import type { Vec3Tuple } from "@/save/types";
import { POSE_NO_CONTACT, type PoseMsg } from "./protocol";

/** Conservative hull proxy: wings span 7.8 m. Both pilots must be in normal flight in one frame. */
export const PILOT_CONTACT_DISTANCE_KM = 0.008;
export const PILOT_CONTACT_MAX_KMPS = 0.9;
const REARM_DISTANCE_KM = 0.014;
const MAX_INTERVAL_MS = 220;
const MIN_INTERVAL_MS = 10;
const MAX_SYNC_ERROR_MS = 25;
const MIN_REPEAT_MS = 180;
const LOW_SPEED_MPS = 2.5;

export interface ContactSample {
  pose: PoseMsg;
  /** On the host monotonic timeline. */
  at: number;
}

export interface PilotTrack {
  previous: ContactSample | undefined;
  latest: ContactSample;
}

interface PairState {
  sentAt: number;
  aSeq: number;
  bSeq: number;
}

export interface PilotCollision {
  /** Contact normal out from `b` towards `a`. */
  normal: Vec3Tuple;
  dvMps: number;
  positionKm: Vec3Tuple;
  /** A small symmetric positional correction for resting contacts. */
  correctionM: number;
  damage: boolean;
}

function eligible(track: PilotTrack): track is PilotTrack & { previous: ContactSample } {
  const { previous, latest } = track;
  if (!previous) return false;
  const a = previous.pose, b = latest.pose;
  if (a.motion === undefined || a.motion !== b.motion || a.f !== b.f || a.fl & POSE_NO_CONTACT || b.fl & POSE_NO_CONTACT) return false;
  const dt = (latest.at - previous.at) / 1000;
  if (dt < MIN_INTERVAL_MS / 1000 || dt > MAX_INTERVAL_MS / 1000) return false;
  const travel = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]);
  const speedA = Math.hypot(...a.v), speedB = Math.hypot(...b.v);
  // A discontinuity must never sweep contact space. Allow acceleration and a fixed hull-scale tolerance.
  return speedA <= PILOT_CONTACT_MAX_KMPS && speedB <= PILOT_CONTACT_MAX_KMPS && travel <= (Math.max(speedA, speedB) + 0.06) * dt + 0.001;
}

function pointAt(a: ContactSample, b: ContactSample, time: number): Vec3Tuple {
  const x = (time - a.at) / (b.at - a.at);
  return [a.pose.p[0] + (b.pose.p[0] - a.pose.p[0]) * x, a.pose.p[1] + (b.pose.p[1] - a.pose.p[1]) * x, a.pose.p[2] + (b.pose.p[2] - a.pose.p[2]) * x];
}

/** One host-side latch per pair. Only intersecting intervals of measured poses produce a hit. */
export class PilotContacts {
  private readonly pairs = new Map<string, PairState>();

  forget(pilot: string): void {
    this.pairs.forEach((_, id) => {
      if ((JSON.parse(id) as string[]).includes(pilot)) this.pairs.delete(id);
    });
  }

  observe(id: string, a: PilotTrack, b: PilotTrack, now: number, uncertaintyMs = MAX_SYNC_ERROR_MS): PilotCollision | null {
    if (!eligible(a) || !eligible(b) || a.latest.pose.f !== b.latest.pose.f) return null;
    const start = Math.max(a.previous.at, b.previous.at);
    const end = Math.min(a.latest.at, b.latest.at);
    if (start >= end || now - end > MAX_INTERVAL_MS) return null;
    const lastA = pointAt(a.previous, a.latest, end);
    const lastB = pointAt(b.previous, b.latest, end);
    const ex = lastA[0] - lastB[0], ey = lastA[1] - lastB[1], ez = lastA[2] - lastB[2];
    const endDistance = Math.hypot(ex, ey, ez);
    const seqA = a.latest.pose.seq, seqB = b.latest.pose.seq;
    const latch = this.pairs.get(id);
    if (latch && (seqA <= latch.aSeq || seqB <= latch.bSeq)) return null;
    const firstA = pointAt(a.previous, a.latest, start);
    const firstB = pointAt(b.previous, b.latest, start);
    const x = firstA[0] - firstB[0], y = firstA[1] - firstB[1], z = firstA[2] - firstB[2];
    const dx = ex - x, dy = ey - y, dz = ez - z;
    const radius = PILOT_CONTACT_DISTANCE_KM;
    const r2 = radius * radius;
    const c = x * x + y * y + z * z - r2;
    const approach = x * dx + y * dy + z * dz;
    const a2 = dx * dx + dy * dy + dz * dz;
    if (c <= 0 && !latch) return null; // A newly placed or rejoined hull already inside cannot open a collision.
    let u = 0;
    if (c > 0) {
      const disc = approach * approach - a2 * c;
      if (approach >= 0 || disc < 0 || a2 <= 0) {
        if (latch && endDistance > REARM_DISTANCE_KM) this.pairs.delete(id);
        return null;
      }
      u = (-approach - Math.sqrt(disc)) / a2;
      if (u > 1) {
        if (latch && endDistance > REARM_DISTANCE_KM) this.pairs.delete(id);
        return null;
      }
    }
    const nx = x + dx * u, ny = y + dy * u, nz = z + dz * u;
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-6) return null;
    const normal: Vec3Tuple = [nx / length, ny / length, nz / length];
    const va = a.latest.pose.v, vb = b.latest.pose.v;
    const closingMps = -1000 * ((va[0] - vb[0]) * normal[0] + (va[1] - vb[1]) * normal[1] + (va[2] - vb[2]) * normal[2]);
    // Measurement gaps near a grazing contact can place two fast, passing hulls a few metres apart in time.
    // Require both timestamped trajectories plus a matching velocity direction, and cap the timing error
    // budget in the usable contact radius. Very fast transit/boost crossings remain pass-through.
    const stepClosingMps = -(dx * normal[0] + dy * normal[1] + dz * normal[2]) * 1e6 / (end - start);
    if (closingMps > radius * 1e6 / Math.max(uncertaintyMs, MAX_SYNC_ERROR_MS) || closingMps <= 0 || stepClosingMps <= 0) return null;
    const damage = !latch;
    if (latch && now - latch.sentAt < MIN_REPEAT_MS) return null;
    if (!latch) {
      this.pairs.set(id, { sentAt: now, aSeq: seqA, bSeq: seqB });
    } else {
      Object.assign(latch, { sentAt: now, aSeq: seqA, bSeq: seqB });
    }
    // Equal masses, one response applied to each pilot; switch off restitution for close maneuvering.
    const restitution = closingMps < LOW_SPEED_MPS ? 0 : 0.15;
    const dvMps = Math.min(closingMps, stepClosingMps) * (1 + restitution) * 0.5;
    const positionKm: Vec3Tuple = [
      (firstA[0] + firstB[0] + (lastA[0] + lastB[0] - firstA[0] - firstB[0]) * u) * 0.5,
      (firstA[1] + firstB[1] + (lastA[1] + lastB[1] - firstA[1] - firstB[1]) * u) * 0.5,
      (firstA[2] + firstB[2] + (lastA[2] + lastB[2] - firstA[2] - firstB[2]) * u) * 0.5,
    ];
    return { normal, dvMps, positionKm, correctionM: Math.min(1, Math.max(0, (radius - endDistance) * 500)), damage };
  }
}
