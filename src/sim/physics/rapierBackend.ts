/** The only file that touches Rapier. The package is imported lazily so no caller pulls it into a chunk. */
import type { PhysicsWorld, PhysicsWorldFactory } from "./PhysicsWorld";
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

type Rapier = typeof import("@dimforge/rapier3d-simd-compat");
type RWorld = InstanceType<Rapier["World"]>;
type RCollider = ReturnType<RWorld["createCollider"]>;
type RRigidBody = ReturnType<RWorld["createRigidBody"]>;
type RBody = ReturnType<RWorld["createRigidBody"]>;
type RColliderDesc = InstanceType<Rapier["ColliderDesc"]>;
type RManifold = Parameters<Parameters<RWorld["contactPair"]>[2]>[0];

const MAX_CONTACTS = 32;
/** Read-back shortfall that counts as a CCD clamp: f32 at 8 km resolves ~1 mm. */
const CLAMP_TOL_M = 1e-3;
const CLAMP_TOL_FRAC = 0.005;
/** A speculative manifold that changed the ship's velocity by more than this along its normal was a touch. */
const SPECULATIVE_DV_MPS = 0.05;
/** Penetration left after a CCD clamp that the solver did not answer; beyond the 1 cm allowed error. */
const CCD_UNRESOLVED_PEN_M = 0.05;
const ZERO_VEL = { x: 0, y: 0, z: 0 };
/**
 * ⚠ Rapier silently caps body speed at 400 × lengthUnit m/s (MEASURED: 500 and 2000 m/s both
 * read back 400; 4000 with lengthUnit 10). 10 lifts it past the 0.9 km/s speed gate; tolerances
 * scale with it: prediction 0.2 m, and allowed error 5 cm by default, which is why it is set below.
 */
const LENGTH_UNIT = 10;
/** Allowed linear error × LENGTH_UNIT = 1 cm. Rapier's 0.005 (5 cm) let a hull 3–5 cm clear register a hit (MEASURED). */
const ALLOWED_LINEAR_ERROR = 0.001;
/** Below this closing speed along the last contact normal, no bounce: thrust adds 1–2 m/s per step, and e > 0 turned resting contact into ±0.3 m/s chatter (MEASURED). */
const RESTITUTION_MIN_SPEED = 2.5;
// Debris bounces off fixed geometry but transfers no local-only impulse to a pilot or another fragment.
const SHIP_GROUP = 0x00010002;
const FIXED_GROUP = 0x00020005;
const DEBRIS_GROUP = 0x00040002;

let _loading: Promise<PhysicsWorldFactory> | null = null;

/** Load + init the engine once; resolves to a world factory. */
export function loadRapierFactory(): Promise<PhysicsWorldFactory> {
  _loading ??= import("@dimforge/rapier3d-simd-compat").then(async (mod) => {
    const R: Rapier = mod;
    await R.init();
    return (config: PhysicsWorldConfig) => new RapierWorld(R, config);
  });
  return _loading;
}

type V = { x: number; y: number; z: number };

/** out = q · v (q unit). */
function rotate(q: { x: number; y: number; z: number; w: number }, v: V, out: V): void {
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  out.x = v.x + q.w * tx + (q.y * tz - q.z * ty);
  out.y = v.y + q.w * ty + (q.z * tx - q.x * tz);
  out.z = v.z + q.w * tz + (q.x * ty - q.y * tx);
}

function shapeDesc(R: Rapier, shape: ColliderShape): RColliderDesc {
  switch (shape.kind) {
    case "compoundHull":
      return compoundHullDesc(R, shape.pieces);
    case "ball":
      return R.ColliderDesc.ball(shape.radiusM);
    case "box":
      return R.ColliderDesc.cuboid(shape.halfX, shape.halfY, shape.halfZ);
    case "hull": {
      const d = (shape.indices ? R.ColliderDesc.convexMesh(shape.points, shape.indices) : null) ?? R.ColliderDesc.convexHull(shape.points);
      if (d) return d;
      // Degenerate point set: bounding ball, so the collider is never silently missing.
      let r2 = 0;
      const p = shape.points;
      for (let i = 0; i < p.length; i += 3) r2 = Math.max(r2, p[i] * p[i] + p[i + 1] * p[i + 1] + p[i + 2] * p[i + 2]);
      return R.ColliderDesc.ball(Math.max(0.01, Math.sqrt(r2)));
    }
  }
}

function compoundHullDesc(R: Rapier, pieces: readonly Float32Array[]): RColliderDesc {
  const hulls = pieces.map((points, index) => {
    const hull = R.ColliderDesc.convexHull(points);
    if (!hull) throw new Error(`Invalid collision hull piece ${index + 1}`);
    return hull.shape;
  });
  const origin = { x: 0, y: 0, z: 0 };
  const rotation = { x: 0, y: 0, z: 0, w: 1 };
  return R.ColliderDesc.compound(
    hulls, hulls.map(() => origin), hulls.map(() => rotation), R.CompoundFlags.FIX_INTERNAL_EDGES,
  );
}

function bounds(shape: ColliderShape): ShapeBounds {
  if (shape.kind === "ball") {
    const r = shape.radiusM;
    return { min: [-r, -r, -r], max: [r, r, r] };
  }
  if (shape.kind === "box") return { min: [-shape.halfX, -shape.halfY, -shape.halfZ], max: [shape.halfX, shape.halfY, shape.halfZ] };
  const b: ShapeBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const pieces = shape.kind === "compoundHull" ? shape.pieces : [shape.points];
  for (const p of pieces) {
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        b.min[k] = Math.min(b.min[k], p[i + k]);
        b.max[k] = Math.max(b.max[k], p[i + k]);
      }
    }
  }
  return b;
}

class RapierWorld implements PhysicsWorld {
  readonly config: PhysicsWorldConfig;
  private readonly R: Rapier;
  private readonly world: RWorld;
  private readonly fixed = new Map<number, RCollider>();
  private readonly debris = new Map<ColliderHandle, RBody>();
  private body: RBody | null = null;
  private shipCollider: RCollider | null = null;
  private shipMassKg = 0;
  /** First collider paired with the ship this step (also when its manifold is empty). */
  private pairSeen: RCollider | null = null;
  /** The ship body's rotation as set before the step (the CCD sweep's start). */
  private readonly preRot = { x: 0, y: 0, z: 0, w: 1 };
  /** The collider's attitude in the body frame (hull bank/lean). */
  private readonly shipAttitude = { x: 0, y: 0, z: 0, w: 1 };
  private shipExtents: ShapeBounds | null = null;

  private readonly _v: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private readonly _q: { x: number; y: number; z: number; w: number } = { x: 0, y: 0, z: 0, w: 1 };
  private readonly _t;
  private readonly _r;
  private readonly _n;
  private readonly _p;
  /** What setShipState wrote, as f32: origin pose + velocity (clamp test), COM velocity c* (Δv). */
  private readonly set = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, cx: 0, cy: 0, cz: 0 };
  private readonly com = { x: 0, y: 0, z: 0 };
  private readonly _c = { x: 0, y: 0, z: 0 };
  private readonly after = { vx: 0, vy: 0, vz: 0 };
  private readonly pool: PhysicsContact[] = [];
  private nContacts = 0;
  private touched = false;
  private stepMs = 0;
  private pairOther: RCollider | null = null;
  private readonly lastN = { x: 0, y: 0, z: 0 };
  private hasLastNormal = false;
  private shipRestitution = -1;
  private pairIndex = -1;

  constructor(R: Rapier, config: PhysicsWorldConfig) {
    this.R = R;
    this.config = { ...config };
    this.world = new R.World({ x: 0, y: 0, z: 0 });
    this.world.timestep = config.dt;
    this.world.lengthUnit = LENGTH_UNIT;
    this.world.integrationParameters.normalizedAllowedLinearError = ALLOWED_LINEAR_ERROR;
    // MEASURED: with 1 substep the step after a CCD clamp missed a hull rock at 603 m/s.
    this.world.maxCcdSubsteps = 4;
    this._t = new R.Vector3(0, 0, 0);
    this._r = new R.Quaternion(0, 0, 0, 1);
    this._n = new R.Vector3(0, 0, 0);
    this._p = new R.Vector3(0, 0, 0);
    this.warmUp();
    for (let i = 0; i < MAX_CONTACTS; i++) {
      this.pool.push({ collider: 0 as ColliderHandle, nx: 0, ny: 0, nz: 0, penetrationM: 0, dvNormalMps: 0, impulseNs: 0, hasPoint: false, px: 0, py: 0, pz: 0 });
    }
  }

  /** The first hull collider costs ~10 ms (MEASURED, cold WASM paths); pay it at load, not in flight. */
  private warmUp(): void {
    const n = 300, pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), th = i * 2.399963;
      pts[i * 3] = Math.cos(th) * r * 50; pts[i * 3 + 1] = y * 50; pts[i * 3 + 2] = Math.sin(th) * r * 50;
    }
    const d = this.R.ColliderDesc.convexHull(pts);
    if (d) this.world.removeCollider(this.world.createCollider(d.setTranslation(1e6, 1e6, 1e6)), false);
  }

  private material(d: RColliderDesc): RColliderDesc {
    return d
      .setRestitution(this.config.restitution)
      .setFriction(this.config.friction)
      .setRestitutionCombineRule(this.R.CoefficientCombineRule.Min)
      .setFrictionCombineRule(this.R.CoefficientCombineRule.Average);
  }

  addFixedCollider(shape: ColliderShape, pose: Readonly<BodyPose>): ColliderHandle {
    const d = this.material(shapeDesc(this.R, shape)).setCollisionGroups(FIXED_GROUP);
    this._q.x = pose.qx; this._q.y = pose.qy; this._q.z = pose.qz; this._q.w = pose.qw;
    d.setTranslation(pose.x, pose.y, pose.z).setRotation(this._q);
    const c = this.world.createCollider(d);
    this.fixed.set(c.handle, c);
    return c.handle as ColliderHandle;
  }

  addDebris(radiusM: number, pose: Readonly<BodyPose>, velocity: Readonly<BodyVelocity>): ColliderHandle {
    this._q.x = pose.qx; this._q.y = pose.qy; this._q.z = pose.qz; this._q.w = pose.qw;
    this._v.x = velocity.wx; this._v.y = velocity.wy; this._v.z = velocity.wz;
    const body = this.world.createRigidBody(this.R.RigidBodyDesc.dynamic()
      .setTranslation(pose.x, pose.y, pose.z).setRotation(this._q)
      .setLinvel(velocity.vx, velocity.vy, velocity.vz).setAngvel(this._v)
      .setLinearDamping(0.7).setCcdEnabled(true));
    const collider = this.world.createCollider(this.R.ColliderDesc.ball(radiusM)
      .setRestitution(0.45).setFriction(0.2).setCollisionGroups(DEBRIS_GROUP), body);
    const handle = collider.handle as ColliderHandle;
    this.debris.set(handle, body);
    return handle;
  }

  readDebris(handle: ColliderHandle, out: BodyPose): boolean {
    const body = this.debris.get(handle);
    if (!body) return false;
    const t = body.translation(this._t);
    out.x = t.x; out.y = t.y; out.z = t.z;
    const q = body.rotation(this._r);
    out.qx = q.x; out.qy = q.y; out.qz = q.z; out.qw = q.w;
    return true;
  }

  removeDebris(handle: ColliderHandle): void {
    const body = this.debris.get(handle);
    if (!body) return;
    this.debris.delete(handle);
    this.world.removeRigidBody(body);
  }

  translateDebris(dx: number, dy: number, dz: number): void {
    this.debris.forEach(body => {
      const t = body.translation(this._t);
      this._v.x = t.x + dx; this._v.y = t.y + dy; this._v.z = t.z + dz;
      body.setTranslation(this._v, false);
    });
  }

  setFixedColliderPose(handle: ColliderHandle, pose: Readonly<BodyPose>): void {
    const c = this.fixed.get(handle);
    if (!c) return;
    this._v.x = pose.x; this._v.y = pose.y; this._v.z = pose.z;
    this._q.x = pose.qx; this._q.y = pose.qy; this._q.z = pose.qz; this._q.w = pose.qw;
    c.setTranslation(this._v);
    c.setRotation(this._q);
  }

  readFixedColliderPose(handle: ColliderHandle, out: BodyPose): boolean {
    const c = this.fixed.get(handle);
    if (!c) return false;
    const t = c.translation();
    const r = c.rotation();
    out.x = t.x; out.y = t.y; out.z = t.z;
    out.qx = r.x; out.qy = r.y; out.qz = r.z; out.qw = r.w;
    return true;
  }

  removeFixedCollider(handle: ColliderHandle): void {
    const c = this.fixed.get(handle);
    if (!c) return;
    this.fixed.delete(handle);
    this.world.removeCollider(c, false);
  }

  fixedColliderCount(): number {
    return this.fixed.size;
  }

  readFixedColliderHull(handle: ColliderHandle): Float32Array | null {
    const c = this.fixed.get(handle);
    const sh = c?.shape;
    return sh && sh instanceof this.R.ConvexPolyhedron ? Float32Array.from(sh.vertices) : null;
  }

  convexHull(points: Float32Array): ConvexHullData | null {
    // ⚠ A collider's shape reads back the INPUT points, not the hull (MEASURED), so this only validates.
    return this.R.ColliderDesc.convexHull(points) ? { points: Float32Array.from(points) } : null;
  }

  debugLines(): Float32Array {
    return Float32Array.from(this.world.debugRender().vertices);
  }

  setMaterial(restitution: number, friction: number): void {
    this.config.restitution = restitution;
    this.config.friction = friction;
    this.fixed.forEach((c) => {
      c.setRestitution(restitution);
      c.setFriction(friction);
    });
    // The ship's restitution is re-chosen every step (RESTITUTION_MIN_SPEED).
    this.shipCollider?.setFriction(friction);
    this.shipRestitution = -1;
  }

  setShipBody(config: ShipBodyConfig): void {
    const d = this.material(shapeDesc(this.R, config.shape)).setCollisionGroups(SHIP_GROUP);
    if (!this.body) {
      const bd = this.R.RigidBodyDesc.dynamic()
        .setCcdEnabled(true)
        .setCanSleep(false)
        .setGravityScale(0)
        .setLinearDamping(0)
        .setAngularDamping(0);
      this.body = this.world.createRigidBody(bd);
    }
    // Isotropic inertia: a free spin has no gyroscopic drift, matching stepShip's rate model.
    const I = config.massKg * config.gyrationRadiusM * config.gyrationRadiusM;
    this._v.x = I; this._v.y = I; this._v.z = I;
    this._q.x = 0; this._q.y = 0; this._q.z = 0; this._q.w = 1;
    const [cx, cy, cz] = config.comM;
    this.com.x = cx; this.com.y = cy; this.com.z = cz;
    // Mass lives on the body, not the collider: the collider turns with the hull's bank (WP2)
    // and must not carry the centre of mass with it.
    d.setDensity(0);
    this.shipMassKg = config.massKg;
    this.body.setAdditionalMassProperties(config.massKg, { x: cx, y: cy, z: cz }, this._v, this._q, true);
    if (this.shipCollider) this.world.removeCollider(this.shipCollider, false);
    this.shipCollider = this.world.createCollider(d, this.body);
    this.shipAttitude.x = this.shipAttitude.y = this.shipAttitude.z = 0;
    this.shipAttitude.w = 1;
    this.shipRestitution = this.config.restitution;
    this.shipExtents = bounds(config.shape);
  }

  hasShipBody(): boolean {
    return this.body !== null;
  }

  shipBounds(): ShapeBounds | null {
    return this.shipExtents;
  }

  setShipAttitude(qx: number, qy: number, qz: number, qw: number): void {
    const sc = this.shipCollider, a = this.shipAttitude;
    if (!sc || (a.x === qx && a.y === qy && a.z === qz && a.w === qw)) return;
    a.x = qx; a.y = qy; a.z = qz; a.w = qw;
    sc.setRotationWrtParent(a);
  }

  readShipAttitude(): [number, number, number, number] | null {
    const r = this.shipCollider?.rotationWrtParent();
    return r ? [r.x, r.y, r.z, r.w] : null;
  }

  setShipState(pose: Readonly<BodyPose>, vel: Readonly<BodyVelocity>): void {
    const b = this.body;
    if (!b) return;
    const s = this.set;
    s.x = Math.fround(pose.x); s.y = Math.fround(pose.y); s.z = Math.fround(pose.z);
    s.vx = Math.fround(vel.vx); s.vy = Math.fround(vel.vy); s.vz = Math.fround(vel.vz);
    s.wx = Math.fround(vel.wx); s.wy = Math.fround(vel.wy); s.wz = Math.fround(vel.wz);
    // Re-placing the body where the solver left it would still count as a teleport.
    const t = b.translation(this._t);
    if (t.x !== s.x || t.y !== s.y || t.z !== s.z) {
      this._v.x = s.x; this._v.y = s.y; this._v.z = s.z;
      b.setTranslation(this._v, true);
    }
    this._q.x = pose.qx; this._q.y = pose.qy; this._q.z = pose.qz; this._q.w = pose.qw;
    this.preRot.x = pose.qx; this.preRot.y = pose.qy; this.preRot.z = pose.qz; this.preRot.w = pose.qw;
    const r = b.rotation(this._r);
    if (r.x !== Math.fround(pose.qx) || r.y !== Math.fround(pose.qy) || r.z !== Math.fround(pose.qz) || r.w !== Math.fround(pose.qw)) {
      b.setRotation(this._q, true);
    }
    // Rapier's linvel is the COM's: v_com = v_origin + ω × (q·com).
    rotate(this._q, this.com, this._c);
    const c = this._c;
    s.cx = Math.fround(vel.vx + s.wy * c.z - s.wz * c.y);
    s.cy = Math.fround(vel.vy + s.wz * c.x - s.wx * c.z);
    s.cz = Math.fround(vel.vz + s.wx * c.y - s.wy * c.x);
    this._v.x = s.cx; this._v.y = s.cy; this._v.z = s.cz;
    b.setLinvel(this._v, true);
    this._v.x = s.wx; this._v.y = s.wy; this._v.z = s.wz;
    b.setAngvel(this._v, true);
  }

  readShipState(pose: BodyPose, vel: BodyVelocity): void {
    const b = this.body;
    if (!b) return;
    const t = b.translation(this._t);
    pose.x = t.x; pose.y = t.y; pose.z = t.z;
    const r = b.rotation(this._r);
    pose.qx = r.x; pose.qy = r.y; pose.qz = r.z; pose.qw = r.w;
    rotate(r, this.com, this._c);
    const w = b.angvel(this._t);
    vel.wx = w.x; vel.wy = w.y; vel.wz = w.z;
    const v = b.linvel(this._t);
    const c = this._c;
    vel.vx = v.x - (vel.wy * c.z - vel.wz * c.y);
    vel.vy = v.y - (vel.wz * c.x - vel.wx * c.z);
    vel.vz = v.z - (vel.wx * c.y - vel.wy * c.x);
  }

  step(): void {
    const sc0 = this.shipCollider;
    if (sc0) {
      const s0 = this.set;
      const closing = this.hasLastNormal ? -(s0.cx * this.lastN.x + s0.cy * this.lastN.y + s0.cz * this.lastN.z) : Infinity;
      const e = closing < RESTITUTION_MIN_SPEED ? 0 : this.config.restitution;
      if (e !== this.shipRestitution) {
        sc0.setRestitution(e);
        this.shipRestitution = e;
      }
    }
    this.hasLastNormal = false;
    const t0 = performance.now();
    this.world.step();
    this.stepMs = performance.now() - t0;
    this.nContacts = 0;
    this.touched = false;
    const b = this.body;
    const sc = this.shipCollider;
    if (!b || !sc) return;
    const v = b.linvel(this._t);
    const a = this.after;
    a.vx = v.x; a.vy = v.y; a.vz = v.z;
    const s = this.set;
    const p = b.translation(this._n);
    const dt = this.config.dt;
    // A CCD clamp shows only as a short step. The tolerance covers f32 and the origin's
    // second-order offset from rotating about the COM, not the clamp it is looking for.
    const ex = p.x - (s.x + s.vx * dt), ey = p.y - (s.y + s.vy * dt), ez = p.z - (s.z + s.vz * dt);
    const tol = CLAMP_TOL_M + CLAMP_TOL_FRAC * Math.hypot(s.vx, s.vy, s.vz) * dt;
    if (ex * ex + ey * ey + ez * ez > tol * tol) {
      this.touched = true;
    }
    this.pairSeen = null;
    this.world.contactPairsWith(sc, this.onPair);
    // A hit resolved inside CCD leaves the pair's manifold empty: the velocity changed but nothing was
    // reported, so no damage (MEASURED: 603 → 333 m/s on a wing, 0 contacts). Report it from the Δv.
    if (this.nContacts === 0 && this.touched && this.pairSeen && !this.resolveCcdPenetration(sc, b, this.pairSeen)) this.reportCcdHit(this.pairSeen);
  }

  /**
   * A CCD clamp can stop the hull INSIDE a thin piece with no solver response, and the next step carries it
   * through (MEASURED: a 0.26 m wing 1.72 m deep at 891 m/s, then out the far side). Apply the collision
   * response the solver skipped: the normal velocity reverses with the material restitution. True when applied.
   */
  private resolveCcdPenetration(sc: RCollider, b: RRigidBody, other: RCollider): boolean {
    const deep = sc.contactCollider(other, 0);
    if (!deep || !(deep.distance < -CCD_UNRESOLVED_PEN_M)) return false;
    // Deep in a thin piece the exit direction runs across it, not against the motion. The response
    // belongs to the first touch: sweep the hull from its pre-step pose for the time-of-impact normal.
    const s = this.set, q = this.preRot, a = this.shipAttitude;
    const r = this._r;
    r.w = q.w * a.w - q.x * a.x - q.y * a.y - q.z * a.z;
    r.x = q.w * a.x + q.x * a.w + q.y * a.z - q.z * a.y;
    r.y = q.w * a.y - q.x * a.z + q.y * a.w + q.z * a.x;
    r.z = q.w * a.z + q.x * a.y - q.y * a.x + q.z * a.w;
    this._p.x = s.x; this._p.y = s.y; this._p.z = s.z;
    this._t.x = s.vx; this._t.y = s.vy; this._t.z = s.vz;
    const hit = other.castShape(ZERO_VEL, sc.shape, this._p, r, this._t, 0, this.config.dt, true);
    if (!hit) return false;
    // normal1 points out of the rock: the direction the rock pushes the ship.
    const nx = hit.normal1.x, ny = hit.normal1.y, nz = hit.normal1.z;
    const v = this.after;
    const closing = -(v.vx * nx + v.vy * ny + v.vz * nz);
    if (!(closing > SPECULATIVE_DV_MPS)) return false;
    const dv = (1 + this.shipRestitution) * closing;
    v.vx += nx * dv; v.vy += ny * dv; v.vz += nz * dv;
    this._v.x = v.vx; this._v.y = v.vy; this._v.z = v.vz;
    b.setLinvel(this._v, true);
    const c = this.pool[this.nContacts++];
    c.collider = other.handle as ColliderHandle;
    c.nx = nx; c.ny = ny; c.nz = nz;
    c.penetrationM = -deep.distance;
    c.dvNormalMps = dv;
    c.impulseNs = this.shipMassKg * dv;
    c.hasPoint = false;
    c.px = 0; c.py = 0; c.pz = 0;
    if (!this.hasLastNormal) {
      this.lastN.x = nx; this.lastN.y = ny; this.lastN.z = nz;
      this.hasLastNormal = true;
    }
    return true;
  }

  private reportCcdHit(other: RCollider): void {
    const a = this.after, s = this.set;
    const dx = a.vx - s.cx, dy = a.vy - s.cy, dz = a.vz - s.cz;
    const dv = Math.hypot(dx, dy, dz);
    if (!(dv > SPECULATIVE_DV_MPS)) return;
    const c = this.pool[this.nContacts++];
    c.collider = other.handle as ColliderHandle;
    // The surface pushed the ship along its velocity change: that is the contact normal.
    c.nx = dx / dv; c.ny = dy / dv; c.nz = dz / dv;
    c.penetrationM = 0;
    c.dvNormalMps = dv;
    c.impulseNs = this.shipMassKg * dv;
    c.hasPoint = false;
    c.px = 0; c.py = 0; c.pz = 0;
    if (!this.hasLastNormal) {
      this.lastN.x = c.nx; this.lastN.y = c.ny; this.lastN.z = c.nz;
      this.hasLastNormal = true;
    }
  }

  private readonly onPair = (other: RCollider): void => {
    this.pairSeen ??= other;
    if (!this.shipCollider || this.nContacts >= MAX_CONTACTS) return;
    this.pairOther = other;
    this.pairIndex = -1;
    this.world.contactPair(this.shipCollider, other, this.onManifold);
  };

  private readonly onManifold = (m: RManifold, flipped: boolean): void => {
    const n = m.numContacts();
    if (n === 0 || !this.pairOther) return;
    let impulse = 0;
    let minDist = Infinity;
    for (let i = 0; i < n; i++) {
      impulse += m.contactImpulse(i);
      const d = m.contactDist(i);
      if (d < minDist) minDist = d;
    }
    // The manifold normal points from its collider1 outward; collider1 is the ship unless flipped.
    const nv = m.normal(this._n);
    const sign = flipped ? 1 : -1;
    const nx = nv.x * sign, ny = nv.y * sign, nz = nv.z * sign;
    const a = this.after, s = this.set;
    const dv = (a.vx - s.cx) * nx + (a.vy - s.cy) * ny + (a.vz - s.cz) * nz;
    // Speculative contacts carry no impulse and a positive distance; but a head-on 60 m/s hit
    // was solved with exactly that manifold (measured: Δv 71.5 m/s, impulse 0), so keep a real Δv.
    if (impulse <= 0 && minDist > 0 && !(dv > SPECULATIVE_DV_MPS)) return;
    let c: PhysicsContact;
    if (this.pairIndex >= 0) {
      c = this.pool[this.pairIndex];
      c.penetrationM = Math.max(c.penetrationM, Math.max(0, -minDist));
      c.impulseNs += impulse;
      if (impulse > 0 || dv > SPECULATIVE_DV_MPS) this.touched = true;
      return;
    }
    if (this.nContacts >= MAX_CONTACTS) return;
    this.pairIndex = this.nContacts;
    c = this.pool[this.nContacts++];
    c.collider = this.pairOther.handle as ColliderHandle;
    c.nx = nx; c.ny = ny; c.nz = nz;
    c.penetrationM = Math.max(0, -minDist);
    c.dvNormalMps = dv;
    c.impulseNs = impulse;
    const ns = m.numSolverContacts();
    c.hasPoint = ns > 0;
    c.px = 0; c.py = 0; c.pz = 0;
    for (let i = 0; i < ns; i++) {
      const p = m.solverContactPoint(i, this._p);
      if (!p) continue;
      c.px += p.x / ns; c.py += p.y / ns; c.pz += p.z / ns;
    }
    if (impulse > 0 || dv > SPECULATIVE_DV_MPS) {
      this.touched = true;
      if (!this.hasLastNormal) {
        this.lastN.x = nx; this.lastN.y = ny; this.lastN.z = nz;
        this.hasLastNormal = true;
      }
    }
  };

  contactCount(): number {
    return this.nContacts;
  }

  contact(i: number): Readonly<PhysicsContact> {
    return this.pool[i];
  }

  lastStepTouched(): boolean {
    return this.touched;
  }

  rebase(dx: number, dy: number, dz: number): void {
    this.fixed.forEach((c) => {
      const t = c.translation();
      this._v.x = t.x - dx; this._v.y = t.y - dy; this._v.z = t.z - dz;
      c.setTranslation(this._v);
    });
  }

  stats(): PhysicsWorldStats {
    return { colliders: this.fixed.size, contacts: this.nContacts, lastStepMs: this.stepMs };
  }

  lastStepMs(): number {
    return this.stepMs;
  }

  dispose(): void {
    this.fixed.clear();
    this.debris.clear();
    this.body = null;
    this.shipCollider = null;
    this.world.free();
  }
}
