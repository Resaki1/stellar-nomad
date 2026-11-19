import type {
  BodyPose,
  BodyVelocity,
  ColliderHandle,
  ColliderShape,
  ConvexHullData,
  PhysicsContact,
  PhysicsWorldConfig,
  PhysicsWorldStats,
  ShapeBounds,
  ShipBodyConfig,
} from "./types";

/** A near-field rigid-body world. One ship body plus fixed colliders; no engine types leak. */
export interface PhysicsWorld {
  readonly config: Readonly<PhysicsWorldConfig>;
  /** Advance by `config.dt`. */
  step(): void;

  addFixedCollider(shape: ColliderShape, pose: Readonly<BodyPose>): ColliderHandle;
  setFixedColliderPose(handle: ColliderHandle, pose: Readonly<BodyPose>): void;
  removeFixedCollider(handle: ColliderHandle): void;
  addDebris(radiusM: number, pose: Readonly<BodyPose>, velocity: Readonly<BodyVelocity>): ColliderHandle;
  readDebris(handle: ColliderHandle, out: BodyPose): boolean;
  removeDebris(handle: ColliderHandle): void;
  translateDebris(dx: number, dy: number, dz: number): void;
  /** Where the engine has the collider (harness cross-check). */
  readFixedColliderPose(handle: ColliderHandle, out: BodyPose): boolean;
  fixedColliderCount(): number;
  /** The engine's local hull vertices of a fixed collider (harness; allocates), null for other shapes. */
  readFixedColliderHull(handle: ColliderHandle): Float32Array | null;
  /** Convex hull of a point set as the engine builds it, or null when degenerate. */
  convexHull(points: Float32Array): ConvexHullData | null;
  /** Every collider's outline as line segments, physics m (dev view; allocates). */
  debugLines(): Float32Array;
  /** Restitution/friction for every collider, existing and future. */
  setMaterial(restitution: number, friction: number): void;

  /** Create (or replace the shape of) the single ship body. */
  setShipBody(config: ShipBodyConfig): void;
  hasShipBody(): boolean;
  setShipState(pose: Readonly<BodyPose>, vel: Readonly<BodyVelocity>): void;
  readShipState(pose: BodyPose, vel: BodyVelocity): void;
  /** The ship collider's local AABB, or null without a body. */
  shipBounds(): ShapeBounds | null;

  /** Contacts of the last step with an impulse or a penetration; pooled, valid until the next step. */
  contactCount(): number;
  contact(i: number): Readonly<PhysicsContact>;
  /** True when the last step's contacts changed the ship's motion (impulse or CCD clamp). */
  lastStepTouched(): boolean;

  /** Translate everything by −(dx,dy,dz) m: the origin moved by +d. */
  rebase(dx: number, dy: number, dz: number): void;
  stats(): PhysicsWorldStats;
  /** Wall ms of the last `step()` (allocation-free, for the per-step path). */
  lastStepMs(): number;
  dispose(): void;
}

export type PhysicsWorldFactory = (config: PhysicsWorldConfig) => PhysicsWorld;
