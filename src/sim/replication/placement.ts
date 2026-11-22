/**
 * Placement validation and recovery-destination resolution (M3.6). One code path for the
 * preview, the authority's placement check and the recovery transaction.
 */
import type { QuatTuple, ReplicationPoint, Vec3Tuple } from "@/save/types";
import { frameOriginXyzKm, isFrameId, selectFrame } from "@/sim/frames";
import { EMERGENCE_CANDIDATES, REPLICATION_TUNING as T, STARTER_POINT_ID, emergencePose, starterPoint } from "./points";

export type PlacementRefusal = "near_depot" | "invalid" | "no_kit" | "too_far" | "near_body" | "near_rock" | "emergence_blocked";

export interface DestroyedLookup {
  has(fieldId: string, chunkKey: string, id: number): boolean;
}

export interface Obstruction {
  /** Nearest body altitude, km, and its id. */
  bodyAltKm: number;
  bodyId: string | null;
  /** Nearest intact rock surface, m (Infinity when none within the search). */
  rockClearM: number;
}

export type ClearanceProbe = (frameId: string, posKm: readonly number[], searchM: number, destroyed: DestroyedLookup | null, out: Obstruction) => Obstruction;

// Injected by clearance.ts on import: it pulls the asteroid generator (and three), which the
// reducers, and with them the title screen, must not load.
let probeClearance: ClearanceProbe | null = null;
export function registerClearanceProbe(fn: ClearanceProbe): void {
  probeClearance = fn;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const _a = { x: 0, y: 0, z: 0 };
const _b = { x: 0, y: 0, z: 0 };
const _probe: Obstruction = { bodyAltKm: 0, bodyId: null, rockClearM: 0 };

function absXyz(frameId: string, p: readonly number[], out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  frameOriginXyzKm(frameId, out);
  out.x += p[0];
  out.y += p[1];
  out.z += p[2];
  return out;
}

export function validPose(frameId: unknown, pos: unknown, quat: unknown): boolean {
  if (!isFrameId(frameId) || !Array.isArray(pos) || pos.length !== 3 || !pos.every(isNum)) return false;
  if (!Array.isArray(quat) || quat.length !== 4 || !quat.every(isNum)) return false;
  const len = Math.hypot(quat[0], quat[1], quat[2], quat[3]);
  return Math.abs(len - 1) < 1e-3;
}

/** Distance between two frame-relative positions, km. */
export function poseDistanceKm(fa: string, pa: readonly number[], fb: string, pb: readonly number[]): number {
  absXyz(fa, pa, _a);
  absXyz(fb, pb, _b);
  return Math.hypot(_a.x - _b.x, _a.y - _b.y, _a.z - _b.z);
}

type OccupiedPoseCheck = (pose: { frameId: string; positionKm: Vec3Tuple }) => "near_depot" | "near_rock" | null;

export interface PlacementCheck {
  refusal: PlacementRefusal | null;
  /** Point altitude over the nearest body / rock clearance, for the preview readout. */
  bodyAltKm: number;
  bodyId: string | null;
  rockClearM: number;
}

/**
 * Everything the authority checks for `replication.place` except receipts and the point bound.
 * `ship` is the placing ship's frame-relative position; `kits` its kit count.
 */
export function checkPlacement(
  pose: { frameId: unknown; positionKm: unknown; quaternion: unknown },
  ship: { frameId: string; positionKm: readonly number[] } | null,
  kits: number,
  destroyed: DestroyedLookup | null,
  out: PlacementCheck,
  occupied?: OccupiedPoseCheck,
): PlacementCheck {
  out.refusal = null;
  out.bodyAltKm = Infinity;
  out.bodyId = null;
  out.rockClearM = Infinity;
  if (!validPose(pose.frameId, pose.positionKm, pose.quaternion)) return ((out.refusal = "invalid"), out);
  const frameId = pose.frameId as string;
  const p = pose.positionKm as number[];
  // The point must belong in the frame it claims (a body's SOI, or the system frame outside them).
  absXyz(frameId, p, _a);
  if (selectFrame(_a, frameId) !== frameId) return ((out.refusal = "invalid"), out);
  if (kits < 1) return ((out.refusal = "no_kit"), out);
  if (!ship || !(poseDistanceKm(ship.frameId, ship.positionKm, frameId, p) <= T.placeRangeKm)) return ((out.refusal = "too_far"), out);
  if (!probeClearance) return ((out.refusal = "invalid"), out);
  probeClearance(frameId, p, T.pointRockClearanceM, destroyed, _probe);
  out.bodyAltKm = _probe.bodyAltKm;
  out.bodyId = _probe.bodyId;
  out.rockClearM = _probe.rockClearM;
  if (_probe.bodyAltKm < T.minBodyAltitudeKm) return ((out.refusal = "near_body"), out);
  if (_probe.rockClearM < T.pointRockClearanceM) return ((out.refusal = "near_rock"), out);
  const obstruction = occupied?.({ frameId, positionKm: p as Vec3Tuple });
  if (obstruction) return ((out.refusal = obstruction), out);
  const e = emergencePose({ positionKm: p as Vec3Tuple, quaternion: pose.quaternion as QuatTuple }, 0);
  if (occupied?.({ frameId, positionKm: e.positionKm })) return ((out.refusal = "emergence_blocked"), out);
  if (!emergenceClear(frameId, e.positionKm, destroyed)) out.refusal = "emergence_blocked";
  return out;
}

function emergenceClear(frameId: string, pos: readonly number[], destroyed: DestroyedLookup | null): boolean {
  if (!probeClearance) return true;
  probeClearance(frameId, pos, T.emergenceRockClearanceM, destroyed, _probe);
  return _probe.bodyAltKm >= T.minBodyAltitudeKm && _probe.rockClearM >= T.emergenceRockClearanceM;
}

/** Why recovery did not happen at the selected point: chosen by the player, or found unusable. */
export type RecoveryFallback = "chosen" | "missing" | "invalid" | "obstructed";

export interface RecoveryDestination {
  pointId: string;
  pointName: string;
  frameId: string;
  positionKm: Vec3Tuple;
  quaternion: QuatTuple;
  /** Emergence candidate used (0 = the default offset). */
  candidate: number;
  fallback: RecoveryFallback | null;
}

// A 55 m sphere covers the station's farthest projection and the ship's hull radius.
const OTHER_STATION_CLEARANCE_KM = 0.055;

function emergeAt(point: ReplicationPoint, points: readonly ReplicationPoint[], destroyed: DestroyedLookup | null, occupied?: OccupiedPoseCheck): RecoveryDestination | null {
  if (!validPose(point.frameId, point.positionKm, point.quaternion)) return null;
  if (probeClearance && probeClearance(point.frameId, point.positionKm, 0, null, _probe).bodyAltKm < 0) return null;
  for (let i = 0; i < EMERGENCE_CANDIDATES; i++) {
    const e = emergencePose(point, i);
    if (occupied?.({ frameId: point.frameId, positionKm: e.positionKm }) ||
        points.some(other => other.id !== point.id && !other.starter && isFrameId(other.frameId) &&
          poseDistanceKm(point.frameId, e.positionKm, other.frameId, other.positionKm) < OTHER_STATION_CLEARANCE_KM) ||
        !emergenceClear(point.frameId, e.positionKm, destroyed)) continue;
    return { pointId: point.id, pointName: point.name, frameId: point.frameId, positionKm: e.positionKm, quaternion: e.quaternion, candidate: i, fallback: null };
  }
  return null;
}

/**
 * Recovery destination: the active point, revalidated (a safe nearby offset when the default
 * emergence is obstructed), else the protected starter point with the reason.
 */
export function resolveRecovery(
  points: readonly ReplicationPoint[], activeId: string, mode: "active" | "starter", destroyed: DestroyedLookup | null,
  occupied?: OccupiedPoseCheck,
): RecoveryDestination {
  const starter = points.find((p) => p.id === STARTER_POINT_ID) ?? starterPoint();
  let fallback: RecoveryFallback | null = null;
  if (mode === "starter") fallback = activeId === STARTER_POINT_ID ? null : "chosen";
  else if (activeId !== STARTER_POINT_ID) {
    const active = points.find((p) => p.id === activeId);
    if (!active) fallback = "missing";
    else if (!validPose(active.frameId, active.positionKm, active.quaternion)) fallback = "invalid";
    else {
      const d = emergeAt(active, points, destroyed, occupied);
      if (d) return d;
      fallback = "obstructed";
    }
  }
  const d = emergeAt(starter, points, destroyed, occupied);
  if (d) return { ...d, fallback };
  // The starter is protected: emerge at its default offset even if something drifted into it.
  const e = emergencePose(starter, 0);
  return { pointId: starter.id, pointName: starter.name, frameId: starter.frameId, positionKm: e.positionKm, quaternion: e.quaternion, candidate: 0, fallback };
}
