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
  /** Offset step for alternate emergence positions and the protected origin. */
  emergenceKm: 0.5,
  /** Transit still needs a wide approach to placed stations from any direction. */
  transitStandOffKm: 0.5,
  /** Rock surface clearance around the point / the emergence position, m. */
  pointRockClearanceM: 200,
  emergenceRockClearanceM: 120,
  /** Minimum altitude over any body for the point and for emergence, km. */
  minBodyAltitudeKm: 150,
  /** "Make active" needs the ship this close to the point. */
  activateRangeKm: 2,
};

/** Match the centre of the closed door at socket_launch in the station GLB. */
export const REPLICATION_BERTH = {
  yM: -16.55,
  faceZM: -18.3,
  spawnClearanceM: 20,
} as const;

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

/** Outer fallbacks preserve the legacy half-kilometre steps for obstacle avoidance. */
const CANDIDATE_AXES: readonly Vec3Tuple[] = [[0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1]];
export const EMERGENCE_CANDIDATES = CANDIDATE_AXES.length * 3;

type EmergencePoint = Pick<ReplicationPoint, "positionKm" | "quaternion"> & Partial<Pick<ReplicationPoint, "starter">>;

/** Emergence position and attitude in the point's frame. Deployed points face the ship outward. */
export function emergencePose(point: EmergencePoint, i: number): { positionKm: Vec3Tuple; quaternion: QuatTuple } {
  const q = point.quaternion;
  const p = point.positionKm;
  if (i === 0 && !point.starter) {
    const { yM, faceZM, spawnClearanceM } = REPLICATION_BERTH;
    rotate(q, 0, yM / 1000, (faceZM - spawnClearanceM) / 1000, _v);
    return {
      positionKm: [p[0] + _v[0], p[1] + _v[1], p[2] + _v[2]],
      // Postmultiply by a half-turn around the station's up axis.
      quaternion: [-q[2], q[3], q[0], -q[1]],
    };
  }

  const axis = CANDIDATE_AXES[i % CANDIDATE_AXES.length];
  const k = REPLICATION_TUNING.emergenceKm * (1 + Math.floor(i / CANDIDATE_AXES.length));
  rotate(q, axis[0], axis[1], axis[2], _v);
  const positionKm: Vec3Tuple = [p[0] + _v[0] * k, p[1] + _v[1] * k, p[2] + _v[2] * k];
  if (i === 0) return { positionKm, quaternion: [q[0], q[1], q[2], q[3]] };
  const [x, y, z] = _v;
  const sign = point.starter ? -1 : 1;
  // Shortest rotation from the ship's +Z nose to the chosen world direction.
  const w = 1 + sign * z;
  if (w < 1e-9) return { positionKm, quaternion: [0, 1, 0, 0] };
  const qx = -sign * y, qy = sign * x, length = Math.hypot(qx, qy, w);
  return { positionKm, quaternion: [qx / length, qy / length, 0, w / length] };
}

export function cleanPointName(name: unknown, fallback: string): string {
  const s = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, MAX_POINT_NAME) : "";
  return s || fallback;
}
