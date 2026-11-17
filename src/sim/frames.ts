/**
 * Reference frames (ROADMAP M0.2). A frame is a body's sphere of influence: things
 * stored relative to it ride along with the body, with no gravity simulation.
 * Only body-inertial frames exist so far (origin follows the body, axes fixed).
 */
import type { Vector3 } from "three";
import { allBodyDefs, solvedEphemerisJD } from "@/sim/celestialConstants";
import { relativePositionKm } from "@/sim/ephemeris";
import type { CelestialBodyDef } from "@/sim/systemTypes";

/** A celestial body id from the active system, or `SYSTEM_FRAME_ID`. */
export type FrameId = string;
/** The system frame: system coordinates themselves (origin fixed, unbounded). */
export const SYSTEM_FRAME_ID: FrameId = "system";

/** Only "inertial" is implemented. "orbit" (M6 rings/stations) and "fixed" (M7 landing) are reserved. */
export type FrameKind = "inertial" | "orbit" | "fixed";

/** Enter a body's frame at 1.0 × its SOI radius, leave only beyond 1.1 ×. */
export const SOI_ENTER_FACTOR = 1.0;
export const SOI_LEAVE_FACTOR = 1.1;

type Vec3Like = { x: number; y: number; z: number };

interface FrameEntry {
  id: FrameId;
  kind: FrameKind;
  body: CelestialBodyDef;
  depth: number;
  soiKm: number;
}

let _frames: FrameEntry[] | null = null;
let _byId: Map<FrameId, FrameEntry> | null = null;

/** Laplace SOI radius a·(m/M)^(2/5); 0 when orbit or masses are missing. */
function laplaceSoiKm(body: CelestialBodyDef, parent: CelestialBodyDef | undefined): number {
  const a = body.orbit?.aKm;
  if (!a || !body.massKg || !parent?.massKg) return 0;
  return a * Math.pow(body.massKg / parent.massKg, 0.4);
}

function table(): FrameEntry[] {
  if (_frames) return _frames;
  const bodies = allBodyDefs();
  const byBodyId = new Map(bodies.map((b) => [b.id, b]));
  const star = bodies.find((b) => b.type === "star");
  const parentOf = (b: CelestialBodyDef) => (b.parent ? byBodyId.get(b.parent) : star);
  const depthOf = (b: CelestialBodyDef): number => {
    let d = 0;
    for (let p: CelestialBodyDef | undefined = b; p && p !== star && d < 8; p = parentOf(p)) d++;
    return d;
  };
  const list: FrameEntry[] = [];
  for (const b of bodies) {
    if (b === star || !b.positionKm) continue;
    const soiKm = laplaceSoiKm(b, parentOf(b));
    if (soiKm <= 0) continue;
    list.push({ id: b.id, kind: "inertial", body: b, depth: depthOf(b), soiKm });
  }
  _frames = list;
  _byId = new Map(list.map((f) => [f.id, f]));
  return list;
}

function entry(id: FrameId): FrameEntry | undefined {
  table();
  return _byId?.get(id);
}

/** True for `SYSTEM_FRAME_ID` and every body that has a sphere of influence. */
export function isFrameId(id: unknown): id is FrameId {
  return typeof id === "string" && (id === SYSTEM_FRAME_ID || entry(id) !== undefined);
}

/** SOI radius in km (Infinity for the system frame, 0 for an unknown id). */
export function frameSoiKm(id: FrameId): number {
  if (id === SYSTEM_FRAME_ID) return Infinity;
  return entry(id)?.soiKm ?? 0;
}

/** Every body frame, for tools and tests. */
export function listFrames(): readonly { id: FrameId; kind: FrameKind; depth: number; soiKm: number }[] {
  return table();
}

/** Frame origin in system km, from the body's LIVE ephemeris position. */
export function frameOriginKm(id: FrameId, out: Vector3): Vector3 {
  const p = id === SYSTEM_FRAME_ID ? null : entry(id)?.body.positionKm;
  return p ? out.set(p[0], p[1], p[2]) : out.set(0, 0, 0);
}

/** `frameOriginKm` into a plain object (modules on the title path must not load three). */
export function frameOriginXyzKm(id: FrameId, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const p = id === SYSTEM_FRAME_ID ? null : entry(id)?.body.positionKm;
  out.x = p ? p[0] : 0;
  out.y = p ? p[1] : 0;
  out.z = p ? p[2] : 0;
  return out;
}

const VEL_HALF_STEP_S = 30;
let _ax = 0, _ay = 0, _az = 0;

/** Body position at `jd` into _ax/_ay/_az, summing the parent chain (static bodies add their authored position). */
function bodyPosAt(body: CelestialBodyDef, jd: number): void {
  _ax = 0; _ay = 0; _az = 0;
  const bodies = allBodyDefs();
  let b: CelestialBodyDef | undefined = body;
  for (let guard = 0; b && guard < 8; guard++) {
    const rel = relativePositionKm(b.orbit, jd, b.id);
    if (!rel) {
      const p = b.positionKm ?? [0, 0, 0];
      _ax += p[0]; _ay += p[1]; _az += p[2];
      return;
    }
    _ax += rel[0]; _ay += rel[1]; _az += rel[2];
    const parentId: string | undefined = b.parent;
    b = parentId ? bodies.find((x) => x.id === parentId) : undefined;
  }
}

/**
 * Frame-origin velocity in the system frame, km per SIM second (central difference
 * on the ephemeris). Only for frame switches: the ephemeris API allocates small arrays.
 */
export function frameVelocityKmps(id: FrameId, out: Vector3): Vector3 {
  const e = id === SYSTEM_FRAME_ID ? undefined : entry(id);
  if (!e) return out.set(0, 0, 0);
  const jd = solvedEphemerisJD();
  const h = VEL_HALF_STEP_S / 86400;
  bodyPosAt(e.body, jd + h);
  const x1 = _ax, y1 = _ay, z1 = _az;
  bodyPosAt(e.body, jd - h);
  const k = 1 / (2 * VEL_HALF_STEP_S);
  return out.set((x1 - _ax) * k, (y1 - _ay) * k, (z1 - _az) * k);
}

/**
 * The frame a system-frame position belongs in: the DEEPEST body whose SOI contains
 * it (a moon beats its planet), keeping `currentId` while inside its 1.1 × band.
 */
export function selectFrame(absKm: Vec3Like, currentId: FrameId): FrameId {
  const frames = table();
  let best: FrameEntry | null = null;
  let current: FrameEntry | null = null;
  let currentD2 = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const p = f.body.positionKm;
    const dx = absKm.x - p[0], dy = absKm.y - p[1], dz = absKm.z - p[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (f.id === currentId) {
      current = f;
      currentD2 = d2;
    }
    const enter = f.soiKm * SOI_ENTER_FACTOR;
    if (d2 <= enter * enter && (!best || f.depth > best.depth || (f.depth === best.depth && f.soiKm < best.soiKm))) {
      best = f;
    }
  }
  if (current) {
    const leave = current.soiKm * SOI_LEAVE_FACTOR;
    if (currentD2 <= leave * leave && (!best || best.depth <= current.depth)) return current.id;
  }
  return best ? best.id : SYSTEM_FRAME_ID;
}

/** System km of a position stored relative to `frameId` (undefined = already system km). */
export function resolveFramePositionKm(p: readonly number[], frameId: FrameId | undefined, out: Vector3): Vector3 {
  if (frameId === undefined) return out.set(p[0], p[1], p[2]);
  frameOriginKm(frameId, out);
  return out.set(out.x + p[0], out.y + p[1], out.z + p[2]);
}
