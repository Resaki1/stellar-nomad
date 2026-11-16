/** Engine-agnostic physics types (docs/PHYSICS_PLAN.md §7). Units: metres, m/s, rad/s, kg. */

/** Opaque collider handle; only the world that issued it understands it. */
export type ColliderHandle = number & { readonly __brand: "ColliderHandle" };

export type ColliderShape =
  | { kind: "ball"; radiusM: number }
  /** Local-space points, xyz interleaved; with `indices` (triangles) they are taken as an already convex mesh. */
  | { kind: "hull"; points: Float32Array; indices?: Uint32Array }
  | { kind: "box"; halfX: number; halfY: number; halfZ: number };

/** Position (m, physics-local) + orientation. Mutable scratch-friendly struct. */
export interface BodyPose {
  x: number; y: number; z: number;
  qx: number; qy: number; qz: number; qw: number;
}

/** Linear (m/s) and angular (rad/s) velocity, both in WORLD axes. */
export interface BodyVelocity {
  vx: number; vy: number; vz: number;
  wx: number; wy: number; wz: number;
}

/** One ship-vs-collider contact of the last step. */
export interface PhysicsContact {
  collider: ColliderHandle;
  /** Unit normal pointing from the collider toward the ship. */
  nx: number; ny: number; nz: number;
  /** Deepest penetration of the pair, m (≥ 0). */
  penetrationM: number;
  /** The ship's velocity change along the normal over the step, m/s (> 0 = pushed away). */
  dvNormalMps: number;
  /** Summed normal impulse, N·s (0 for a resting overlap being pushed out). */
  impulseNs: number;
  /** Mean solver contact point, physics m (valid when `hasPoint`). */
  hasPoint: boolean;
  px: number; py: number; pz: number;
}

/** A point set the engine accepted as a convex hull, local m (the engine re-hulls it per collider). */
export interface ConvexHullData {
  points: Float32Array;
}

export interface ShipBodyConfig {
  shape: ColliderShape;
  massKg: number;
  /** Isotropic inertia = mass · k². */
  gyrationRadiusM: number;
  /** Centre of mass in body axes, m. */
  comM: readonly [number, number, number];
}

/** Local AABB, m. */
export interface ShapeBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface PhysicsWorldConfig {
  /** Engine timestep = the sim's fixed step. */
  dt: number;
  restitution: number;
  friction: number;
}

export interface PhysicsWorldStats {
  colliders: number;
  /** Contacts produced by the last step. */
  contacts: number;
  /** Wall time of the last step, ms. */
  lastStepMs: number;
}

export function createPose(): BodyPose {
  return { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
}

export function createVelocity(): BodyVelocity {
  return { vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 };
}
