/**
 * Replication points (M3.6): tuning, the protected starter point and emergence geometry.
 * Pure data + maths; clearance against bodies and rocks lives in `clearance.ts`.
 */
import type { QuatTuple, ReplicationPoint, Vec3Tuple } from "@/save/types";
import { activeSystem } from "@/sim/systemRegistry";
import { SYSTEM_FRAME_ID } from "@/sim/frames";

/** Tuning defaults (docs/M3_GAMEPLAY_PLAN.md §13.6). */
export const REPLICATION_TUNING = {
  /** Preview sits this far along the nose. */
  placeDistanceKm: 0.8,
  /** Accepted placements are at most this far from the ship. */
  placeRangeKm: 2,
  /** The ship emerges this far from the point, on the point's −Z side, facing it. */
  emergenceKm: 0.5,
  /** Rock surface clearance around the point / the emergence position, m. */
  pointRockClearanceM: 200,
  emergenceRockClearanceM: 120,
  /** Minimum altitude over any body for the point and for emergence, km. */
  minBodyAltitudeKm: 150,
  /** "Make active" needs the ship this close to the point. */
  activateRangeKm: 2,
};

export const MAX_POINTS = 64;
export const MAX_POINT_NAME = 32;
export const STARTER_POINT_ID = "starter";
export const REPLICATION_KIT_ID = "consumable_replication_kit";

// Plain maths, no three.js: the save layer imports this module and the title screen must not load three.
const _v: Vec3Tuple = [0, 0, 0];

/** `v` rotated by unit quaternion `q`, into `out`. */
function rotate(q: readonly number[], x: number, y: number, z: number, out: Vec3Tuple): Vec3Tuple {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** The protected starter point: its emergence pose is the system's starting pose (deterministic). */
export function starterPoint(): ReplicationPoint {
  const sys = activeSystem();
  const q = sys.startingRotationQuat;
  const frameId = sys.startingBody && sys.startingOffsetKm ? sys.startingBody : SYSTEM_FRAME_ID;
  const s = frameId === SYSTEM_FRAME_ID ? sys.startingPositionKm : (sys.startingOffsetKm as number[]);
  rotate(q, 0, 0, REPLICATION_TUNING.emergenceKm, _v);
  return {
    id: STARTER_POINT_ID,
    name: "Origin point",
    frameId,
    positionKm: [s[0] + _v[0], s[1] + _v[1], s[2] + _v[2]],
    quaternion: [q[0], q[1], q[2], q[3]],
    by: "",
    createdAt: 0,
    starter: true,
  };
}

/**
 * Emergence candidates around a point, in the point's frame: the default (index 0) on the
 * −Z side, then the other five axes, then the same at 2× and 3× the distance.
 */
const CANDIDATE_AXES: readonly Vec3Tuple[] = [[0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1]];
export const EMERGENCE_CANDIDATES = CANDIDATE_AXES.length * 3;

/** Emergence position (frame-relative km) and facing (towards the point) for candidate `i`. */
export function emergencePose(point: Pick<ReplicationPoint, "positionKm" | "quaternion">, i: number): { positionKm: Vec3Tuple; quaternion: QuatTuple } {
  const axis = CANDIDATE_AXES[i % CANDIDATE_AXES.length];
  const k = REPLICATION_TUNING.emergenceKm * (1 + Math.floor(i / CANDIDATE_AXES.length));
  const pq = point.quaternion;
  rotate(pq, axis[0], axis[1], axis[2], _v);
  const p = point.positionKm;
  const positionKm: Vec3Tuple = [p[0] + _v[0] * k, p[1] + _v[1] * k, p[2] + _v[2] * k];
  if (i === 0) return { positionKm, quaternion: [pq[0], pq[1], pq[2], pq[3]] };
  // Face the point: the rotation taking +Z to −axis (unit, so the half-way formula applies).
  const dx = -_v[0], dy = -_v[1], dz = -_v[2];
  const w = 1 + dz;
  if (w < 1e-9) return { positionKm, quaternion: [0, 1, 0, 0] };
  const qx = -dy, qy = dx, l = Math.hypot(qx, qy, w);
  return { positionKm, quaternion: [qx / l, qy / l, 0, w / l] };
}

export function cleanPointName(name: unknown, fallback: string): string {
  const s = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, MAX_POINT_NAME) : "";
  return s || fallback;
}
