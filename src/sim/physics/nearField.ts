/**
 * The near-field physics layer (docs/PHYSICS_PLAN.md §7.1). Metres relative to a physics
 * origin anchored (f64 km) in the ship's current reference frame. `stepShip` integrates;
 * `resolve` only replaces its tentative pose when a collider is in play.
 */
import { Quaternion, Vector3 } from "three";
import { frameOriginKm, type FrameId } from "@/sim/frames";
import type { ShipState } from "@/sim/ship/shipState";
import { FIXED_DT } from "@/sim/ship/shipConstants";
import type { PhysicsWorld, PhysicsWorldFactory } from "./PhysicsWorld";
import { getPhysicsTuning } from "./physicsTuning";
import { createPose, createVelocity, type ColliderHandle, type ColliderShape, type ConvexHullData, type PhysicsContact, type ShapeBounds } from "./types";

/** Re-anchor once the ship is this far from the physics origin. */
export const PHYSICS_REBASE_KM = 2;
/**
 * Speed gate, km/s. CCD clamps motion at the first hit; a missed sweep must still leave an
 * overlap the next step's narrow phase catches, so one step may not carry the ship further
 * than smallest rock radius 8 m + hull half-thickness 0.98 m (measured) = 8.98 m per
 * 1/120 s = 1.08 km/s; ×0.85 margin → 0.9 km/s (1.5× the boosted limit). Gate 2 tests it.
 */
export const PHYSICS_MAX_SPEED_KMPS = 0.9;
/** Ship mass for the solver; rocks are fixed, so it only sets spin vs. bounce. */
export const SHIP_MASS_KG = 30_000;
/**
 * Radius of gyration, m (uniform 7.8 × 6.6 m hull about yaw: 2.95). At 2.5 the nose contact's
 * torque at full thrust beat the 250 °/s² rate assist and the ship pivoted off a wall (gate 6).
 */
export const SHIP_GYRATION_RADIUS_M = 3;
/**
 * COM on the main-engine thrust line (nozzles at y 0.36 m, body axes). At the body origin the
 * nose tip (y 0.34) had a 0.34 m lever: full thrust into a wall out-torqued the rate assist
 * and the ship pitched over and slid off (MEASURED, gate 6).
 */
export const SHIP_COM_M: readonly [number, number, number] = [0, 0.36, 0];
/** Fallback ship collider (the mesh hull's measured AABB, body axes) until the mesh registers. */
const SHIP_FALLBACK_MIN_M = [-3.9, -0.3, -3.13] as const;
const SHIP_FALLBACK_MAX_M = [3.88, 1.66, 3.44] as const;
/** Contacts kept for consumers between drains (M2b damage). */
const CONTACT_QUEUE = 64;
/** Engine load bound; past it the game runs on analytic collisions only. */
export const PHYSICS_LOAD_TIMEOUT_MS = 20_000;

export type SuspendReason = "not-ready" | "transit" | "dev-speed" | "over-speed" | "dead";
export type StepOwner = "physics" | "analytic";
/** Opaque registry id; stable across rebases, frame switches and suspensions. */
export type NearFieldColliderId = number & { readonly __brand: "NearFieldColliderId" };

export interface NearFieldContact {
  colliderId: NearFieldColliderId;
  nx: number; ny: number; nz: number;
  penetrationM: number;
  dvNormalMps: number;
  impulseNs: number;
  /** Ship speed before / after the step, m/s. */
  speedBeforeMps: number;
  speedAfterMps: number;
  serial: number;
  /** Contact point, km, in the physics origin's frame (`frameId`) when `hasPoint`. */
  hasPoint: boolean;
  pxKm: number; pyKm: number; pzKm: number;
  frameId: FrameId;
}

interface Entry {
  id: NearFieldColliderId;
  shape: ColliderShape;
  tag: string;
  frameId: FrameId;
  relKm: Vector3;
  quat: Quaternion;
  handle: ColliderHandle | null;
}

export interface NearFieldOptions {
  rebaseKm?: number;
  maxSpeedKmps?: number;
}

const _shipOrigin = new Vector3();
const _colOrigin = new Vector3();
const _w = new Vector3();
const _wSet = new Vector3();
const _dq = new Quaternion();
const _qInv = new Quaternion();
const _qRes = new Quaternion();
const _axis = new Vector3();
const _pose = createPose();
const _vel = createVelocity();
const _readPose = createPose();
const _readVel = createVelocity();
const DEV = process.env.NODE_ENV !== "production";

/** Shrink |d| by up to k. */
function damp(d: number, k: number): number {
  return d > k ? d - k : d < -k ? d + k : 0;
}

export class NearField {
  rebaseKm: number;
  readonly dt = FIXED_DT;
  maxSpeedKmps: number;
  private world: PhysicsWorld | null = null;
  private readonly entries = new Map<NearFieldColliderId, Entry>();
  private readonly byHandle = new Map<ColliderHandle, Entry>();
  private nextId = 1;
  /** Colliders registered in a frame other than the physics origin's; repositioned every step. */
  private foreign = 0;
  private shipShape: ColliderShape;
  private shipShapeSource: "fallback" | "mesh" = "fallback";

  /** Physics origin: frame + f64 km anchor in it. */
  private frameId: FrameId | null = null;
  private readonly anchorKm = new Vector3();
  private needsReseed = true;

  private gateTransit = false;
  private gateDevSpeed = false;
  private gateDead = false;
  suspended: SuspendReason | null = "not-ready";

  private lastSerial = -1;
  private readonly queue: NearFieldContact[] = [];
  private queueLen = 0;
  private readonly stepContacts: NearFieldContact[] = [];
  private stepContactLen = 0;
  private readonly reseedListeners = new Set<() => void>();

  readonly counters = {
    rebases: 0,
    reseeds: 0,
    stepsPhysics: 0,
    stepsAnalytic: 0,
    touchedSteps: 0,
    ownerViolations: 0,
    suspensions: 0,
    droppedContacts: 0,
    energyClamps: 0,
    maxEnergyClampMps: 0,
    maxReanchorMs: 0,
  };
  lastStepMs = 0;
  private frameStepMs = 0;
  private readonly recentFrameMs = new Float64Array(120);
  private recentN = 0;
  lastOwner: StepOwner = "analytic";
  /** Rate-assist authority, rad/s per step (angular accel × dt); set by the caller from the flight tuning. */
  angularAuthority = 0;

  constructor(opts: NearFieldOptions = {}) {
    this.rebaseKm = opts.rebaseKm ?? PHYSICS_REBASE_KM;
    this.maxSpeedKmps = opts.maxSpeedKmps ?? PHYSICS_MAX_SPEED_KMPS;
    const corners = new Float32Array(24);
    for (let i = 0; i < 8; i++) {
      corners[i * 3] = (i & 1 ? SHIP_FALLBACK_MAX_M : SHIP_FALLBACK_MIN_M)[0];
      corners[i * 3 + 1] = (i & 2 ? SHIP_FALLBACK_MAX_M : SHIP_FALLBACK_MIN_M)[1];
      corners[i * 3 + 2] = (i & 4 ? SHIP_FALLBACK_MAX_M : SHIP_FALLBACK_MIN_M)[2];
    }
    this.shipShape = { kind: "hull", points: corners };
    const mk = (): NearFieldContact => ({
      colliderId: 0 as NearFieldColliderId, nx: 0, ny: 0, nz: 0, penetrationM: 0, dvNormalMps: 0, impulseNs: 0,
      speedBeforeMps: 0, speedAfterMps: 0, serial: 0, hasPoint: false, pxKm: 0, pyKm: 0, pzKm: 0, frameId: "",
    });
    for (let i = 0; i < CONTACT_QUEUE; i++) {
      this.queue.push(mk());
      this.stepContacts.push(mk());
    }
  }

  get ready(): boolean {
    return this.world !== null;
  }

  /** Hand the near field its engine world; every registered collider is created in it. */
  attachWorld(world: PhysicsWorld): void {
    try {
      world.setShipBody({ shape: this.shipShape, massKg: SHIP_MASS_KG, gyrationRadiusM: SHIP_GYRATION_RADIUS_M, comM: SHIP_COM_M });
      this.entries.forEach((e) => this.createInWorld(world, e));
    } catch (err) {
      this.byHandle.clear();
      this.entries.forEach((e) => (e.handle = null));
      world.dispose();
      throw err;
    }
    this.world = world;
    this.suspended = null;
    this.needsReseed = true;
  }

  dispose(): void {
    this.world?.dispose();
    this.world = null;
    this.byHandle.clear();
    this.entries.forEach((e) => (e.handle = null));
  }

  setShipShape(shape: ColliderShape, source: "fallback" | "mesh"): void {
    this.shipShape = shape;
    this.shipShapeSource = source;
    this.world?.setShipBody({ shape, massKg: SHIP_MASS_KG, gyrationRadiusM: SHIP_GYRATION_RADIUS_M, comM: SHIP_COM_M });
  }

  shipInfo(): { source: string; boundsM: ShapeBounds | null; hullPoints: number } {
    return {
      source: this.shipShapeSource,
      boundsM: this.world?.shipBounds() ?? null,
      hullPoints: this.shipShape.kind === "hull" ? this.shipShape.points.length / 3 : 0,
    };
  }

  shipShapeDesc(): ColliderShape {
    return this.shipShape;
  }

  // ── Collider registry (M2b adds asteroids here) ─────────────────────────────

  addCollider(shape: ColliderShape, frameId: FrameId, relKm: { x: number; y: number; z: number }, quat?: Quaternion, tag = ""): NearFieldColliderId {
    const id = this.nextId++ as NearFieldColliderId;
    const e: Entry = {
      id, shape, tag, frameId,
      relKm: new Vector3(relKm.x, relKm.y, relKm.z),
      quat: quat ? quat.clone() : new Quaternion(),
      handle: null,
    };
    this.entries.set(id, e);
    if (this.frameId !== null && frameId !== this.frameId) this.foreign++;
    if (this.world) this.createInWorld(this.world, e);
    return id;
  }

  removeCollider(id: NearFieldColliderId): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    if (this.frameId !== null && e.frameId !== this.frameId) this.foreign--;
    if (e.handle !== null && this.world) {
      this.world.removeFixedCollider(e.handle);
      this.byHandle.delete(e.handle);
    }
  }

  /** Remove every collider with `tag` (all when omitted); returns the count removed. */
  clearColliders(tag?: string): number {
    let n = 0;
    for (const e of Array.from(this.entries.values())) {
      if (tag === undefined || e.tag === tag) {
        this.removeCollider(e.id);
        n++;
      }
    }
    return n;
  }

  colliderCount(): number {
    return this.entries.size;
  }

  /** Registered colliders per tag (harness). */
  colliderCountsByTag(): Record<string, number> {
    const out: Record<string, number> = {};
    this.entries.forEach((e) => (out[e.tag] = (out[e.tag] ?? 0) + 1));
    return out;
  }

  hasCollider(id: NearFieldColliderId): boolean {
    return this.entries.has(id);
  }

  /** Whether the collider exists in the engine (false while no world is attached). */
  colliderInEngine(id: NearFieldColliderId): boolean {
    return this.entries.get(id)?.handle != null;
  }

  forEachCollider(f: (id: NearFieldColliderId, shape: ColliderShape, frameId: FrameId, relKm: Vector3, tag: string, quat: Quaternion) => void): void {
    this.entries.forEach((e) => f(e.id, e.shape, e.frameId, e.relKm, e.tag, e.quat));
  }

  /** The engine's convex hull of `points`, or null without a world or for a degenerate set. */
  convexHull(points: Float32Array): ConvexHullData | null {
    return this.world?.convexHull(points) ?? null;
  }

  /** Engine-side local hull vertices of a collider (harness). */
  engineHull(id: NearFieldColliderId): Float32Array | null {
    const e = this.entries.get(id);
    return e && e.handle !== null && this.world ? this.world.readFixedColliderHull(e.handle) : null;
  }

  /** Engine-side pose of a collider: frame-relative km (the origin's frame) + quaternion (harness). */
  enginePose(id: NearFieldColliderId): { frameId: FrameId; relKm: [number, number, number]; quat: [number, number, number, number] } | null {
    const e = this.entries.get(id);
    if (!e || e.handle === null || !this.world || this.frameId === null) return null;
    if (!this.world.readFixedColliderPose(e.handle, _readPose)) return null;
    const a = this.anchorKm, p = _readPose;
    return {
      frameId: this.frameId,
      relKm: [a.x + p.x / 1000, a.y + p.y / 1000, a.z + p.z / 1000],
      quat: [p.qx, p.qy, p.qz, p.qw],
    };
  }

  /** Engine outlines (physics m) plus the origin they are relative to (dev view). */
  debugLines(): { frameId: FrameId; anchorKm: Vector3; lines: Float32Array } | null {
    if (!this.world || this.frameId === null) return null;
    return { frameId: this.frameId, anchorKm: this.anchorKm, lines: this.world.debugLines() };
  }

  setMaterial(restitution: number, friction: number): void {
    this.world?.setMaterial(restitution, friction);
  }

  /** Re-seed on the next step (teleport, respawn, external world change). */
  markReseed(): void {
    this.needsReseed = true;
  }

  onReseed(f: () => void): () => void {
    this.reseedListeners.add(f);
    return () => this.reseedListeners.delete(f);
  }

  /** Once per frame, before the substeps. */
  setGates(transit: boolean, devSpeed: boolean, dead: boolean): void {
    this.gateTransit = transit;
    this.gateDevSpeed = devSpeed;
    this.gateDead = dead;
  }

  // ── The resolve step ────────────────────────────────────────────────────────

  /**
   * Run after `stepShip` (which left the tentative pose in posKm/quat and prev* intact).
   * `serial` identifies the ship step; resolving one step twice is an owner violation.
   */
  resolve(ship: ShipState, serial: number): StepOwner {
    if (serial === this.lastSerial) {
      this.counters.ownerViolations++;
      if (DEV) console.error(`[physics] step ${serial} resolved twice (two owners)`);
      return this.lastOwner;
    }
    this.lastSerial = serial;
    this.stepContactLen = 0;

    const reason = this.reason(ship);
    if (reason !== null) {
      if (this.suspended !== reason) {
        if (this.suspended === null) this.counters.suspensions++;
        this.suspended = reason;
      }
      this.needsReseed = true;
      return this.own("analytic");
    }
    this.suspended = null;
    const world = this.world!;
    if (this.entries.size === 0) {
      this.needsReseed = true;
      return this.own("analytic");
    }
    if (this.needsReseed || this.frameId !== ship.frameId) this.reseed(ship.frameId, ship.prevPosKm);
    else if (ship.prevPosKm.distanceTo(this.anchorKm) > this.rebaseKm) {
      this.reanchor(ship.frameId, ship.prevPosKm);
      this.counters.rebases++;
    } else if (this.foreign > 0) this.entries.forEach(this.refreshForeign);

    // Body at the PREVIOUS pose with the NEW velocities.
    const a = this.anchorKm, p0 = ship.prevPosKm, q0 = ship.prevQuat;
    _pose.x = (p0.x - a.x) * 1000; _pose.y = (p0.y - a.y) * 1000; _pose.z = (p0.z - a.z) * 1000;
    _pose.qx = q0.x; _pose.qy = q0.y; _pose.qz = q0.z; _pose.qw = q0.w;
    _vel.vx = ship.velKmps.x * 1000; _vel.vy = ship.velKmps.y * 1000; _vel.vz = ship.velKmps.z * 1000;
    _w.copy(ship.angVel).applyQuaternion(q0);
    _vel.wx = _w.x; _vel.wy = _w.y; _vel.wz = _w.z;
    world.setShipState(_pose, _vel);
    world.step();
    const ms = world.lastStepMs();
    this.lastStepMs = ms;
    this.frameStepMs += ms;

    // Contact-free: keep stepShip's exact f64 pose (the engine's is f32 at up to km scale).
    if (!world.lastStepTouched()) return this.own("physics");

    this.counters.touchedSteps++;
    const speedBefore = ship.velKmps.length() * 1000;
    world.readShipState(_readPose, _readVel);
    // stepShip's rotation beyond the ω the engine was given (the autopilot's heading pull), world
    // frame: R = q_tentative · (q0 · exp(ω dt))⁻¹, re-applied to the engine's orientation.
    const wl = ship.angVel.length();
    if (wl > 0) _dq.setFromAxisAngle(_axis.copy(ship.angVel).divideScalar(wl), wl * this.dt);
    else _dq.identity();
    _qRes.copy(q0).multiply(_dq).invert().premultiply(ship.quat);
    // Position as an f32 DELTA from where the body was placed, added to the f64 pose.
    ship.posKm.set(
      p0.x + (_readPose.x - Math.fround(_pose.x)) / 1000,
      p0.y + (_readPose.y - Math.fround(_pose.y)) / 1000,
      p0.z + (_readPose.z - Math.fround(_pose.z)) / 1000,
    );
    ship.quat.set(_readPose.qx, _readPose.qy, _readPose.qz, _readPose.qw).normalize().premultiply(_qRes).normalize();
    ship.velKmps.set(_readVel.vx / 1000, _readVel.vy / 1000, _readVel.vz / 1000);
    // The solver's depenetration turns overlap into speed (MEASURED +10.6 m/s after a 3.4 m
    // wing overlap at 603 m/s); a fixed rock must never hand back energy.
    const raw = ship.velKmps.length() * 1000;
    if (raw > speedBefore && raw > 0) {
      ship.velKmps.multiplyScalar(speedBefore / raw);
      this.counters.energyClamps++;
      if (raw - speedBefore > this.counters.maxEnergyClampMps) this.counters.maxEnergyClampMps = raw - speedBefore;
    }
    _qInv.copy(ship.quat).invert();
    _wSet.copy(ship.angVel);
    ship.angVel.set(_readVel.wx, _readVel.wy, _readVel.wz).applyQuaternion(_qInv);
    // The rate assist fights contact spin within the step, not one step late: otherwise a
    // steady contact torque (nose pressed on a wall) becomes a steady yaw drift (MEASURED).
    const k = this.angularAuthority;
    if (k > 0) {
      const w = ship.angVel;
      _w.set(damp(w.x - _wSet.x, k), damp(w.y - _wSet.y, k), damp(w.z - _wSet.z, k)).add(_wSet).sub(w);
      const dl = _w.length();
      if (dl > 0) ship.quat.multiply(_dq.setFromAxisAngle(_w.divideScalar(dl), dl * this.dt)).normalize();
      w.set(damp(w.x - _wSet.x, k), damp(w.y - _wSet.y, k), damp(w.z - _wSet.z, k)).add(_wSet);
    }
    ship.forward.set(0, 0, 1).applyQuaternion(ship.quat);
    const speedAfter = ship.velKmps.length() * 1000;

    const n = world.contactCount();
    for (let i = 0; i < n; i++) {
      const c = world.contact(i);
      const e = this.byHandle.get(c.collider);
      if (!e) continue;
      if (this.stepContactLen < this.stepContacts.length) {
        this.fill(this.stepContacts[this.stepContactLen++], e.id, c, speedBefore, speedAfter, serial);
      }
      if (this.queueLen < this.queue.length) this.fill(this.queue[this.queueLen++], e.id, c, speedBefore, speedAfter, serial);
      else this.counters.droppedContacts++;
    }
    return this.own("physics");
  }

  /** Once per frame after the substeps, when `updateShipFrame` switched frames. */
  onFrameSwitch(): void {
    this.needsReseed = true;
  }

  /** Contacts queued since the last drain (M2b damage/VFX). */
  drainContacts(f: (c: Readonly<NearFieldContact>) => void): number {
    const n = this.queueLen;
    for (let i = 0; i < n; i++) f(this.queue[i]);
    this.queueLen = 0;
    return n;
  }

  /** Contacts of the last resolved step (harness). */
  lastStepContacts(f: (c: Readonly<NearFieldContact>) => void): number {
    for (let i = 0; i < this.stepContactLen; i++) f(this.stepContacts[i]);
    return this.stepContactLen;
  }

  /** Step ms summed since the last call (one rendered frame). */
  takeFrameStepMs(): number {
    const ms = this.frameStepMs;
    this.frameStepMs = 0;
    this.recentFrameMs[this.recentN++ % this.recentFrameMs.length] = ms;
    return ms;
  }

  /** Per-frame step ms over the last ≤120 frames. */
  recentStepMs(): { frames: number; mean: number; max: number } {
    const n = Math.min(this.recentN, this.recentFrameMs.length);
    let sum = 0, max = 0;
    for (let i = 0; i < n; i++) {
      sum += this.recentFrameMs[i];
      if (this.recentFrameMs[i] > max) max = this.recentFrameMs[i];
    }
    return { frames: n, mean: n > 0 ? sum / n : 0, max };
  }

  origin(): { frameId: FrameId | null; anchorKm: [number, number, number] } {
    return { frameId: this.frameId, anchorKm: [this.anchorKm.x, this.anchorKm.y, this.anchorKm.z] };
  }

  /** Engine-side offset of a collider from where the registry says it is (current anchor), m. */
  engineDriftM(id: NearFieldColliderId): number | null {
    const e = this.entries.get(id);
    if (!e || e.handle === null || !this.world) return null;
    if (!this.world.readFixedColliderPose(e.handle, _readPose)) return null;
    this.localPose(e);
    return Math.hypot(_readPose.x - _pose.x, _readPose.y - _pose.y, _readPose.z - _pose.z);
  }

  engineColliderCount(): number {
    return this.world?.fixedColliderCount() ?? 0;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private reason(ship: ShipState): SuspendReason | null {
    if (!this.world) return "not-ready";
    if (this.gateDead) return "dead";
    if (this.gateTransit) return "transit";
    if (this.gateDevSpeed) return "dev-speed";
    if (ship.velKmps.length() > this.maxSpeedKmps) return "over-speed";
    return null;
  }

  private own(o: StepOwner): StepOwner {
    if (o === "physics") this.counters.stepsPhysics++;
    else this.counters.stepsAnalytic++;
    this.lastOwner = o;
    return o;
  }

  private fill(dst: NearFieldContact, id: NearFieldColliderId, c: Readonly<PhysicsContact>, sb: number, sa: number, serial: number): void {
    dst.colliderId = id;
    dst.nx = c.nx; dst.ny = c.ny; dst.nz = c.nz;
    dst.penetrationM = c.penetrationM;
    dst.dvNormalMps = c.dvNormalMps;
    dst.impulseNs = c.impulseNs;
    dst.speedBeforeMps = sb;
    dst.speedAfterMps = sa;
    dst.serial = serial;
    dst.hasPoint = c.hasPoint;
    const a = this.anchorKm;
    dst.pxKm = a.x + c.px / 1000; dst.pyKm = a.y + c.py / 1000; dst.pzKm = a.z + c.pz / 1000;
    dst.frameId = this.frameId ?? "";
  }

  private createInWorld(world: PhysicsWorld, e: Entry): void {
    this.localPose(e);
    e.handle = world.addFixedCollider(e.shape, _pose);
    this.byHandle.set(e.handle, e);
  }

  /** Entry pose in physics metres (writes _pose). Frames are resolved through their live origins. */
  private localPose(e: Entry): void {
    const a = this.anchorKm;
    let x = e.relKm.x - a.x, y = e.relKm.y - a.y, z = e.relKm.z - a.z;
    if (this.frameId !== null && e.frameId !== this.frameId) {
      frameOriginKm(e.frameId, _colOrigin);
      frameOriginKm(this.frameId, _shipOrigin);
      x += _colOrigin.x - _shipOrigin.x;
      y += _colOrigin.y - _shipOrigin.y;
      z += _colOrigin.z - _shipOrigin.z;
    }
    _pose.x = x * 1000; _pose.y = y * 1000; _pose.z = z * 1000;
    _pose.qx = e.quat.x; _pose.qy = e.quat.y; _pose.qz = e.quat.z; _pose.qw = e.quat.w;
  }

  private readonly refreshForeign = (e: Entry): void => {
    if (e.handle === null || e.frameId === this.frameId || !this.world) return;
    this.localPose(e);
    this.world.setFixedColliderPose(e.handle, _pose);
  };

  private reanchor(frameId: FrameId, posKm: Vector3): void {
    const t0 = performance.now();
    this.frameId = frameId;
    this.anchorKm.copy(posKm);
    let foreign = 0;
    const w = this.world;
    this.entries.forEach((e) => {
      if (e.frameId !== frameId) foreign++;
      if (e.handle === null || !w) return;
      this.localPose(e);
      w.setFixedColliderPose(e.handle, _pose);
    });
    this.foreign = foreign;
    const ms = performance.now() - t0;
    if (ms > this.counters.maxReanchorMs) this.counters.maxReanchorMs = ms;
  }

  private reseed(frameId: FrameId, posKm: Vector3): void {
    this.reanchor(frameId, posKm);
    this.needsReseed = false;
    this.counters.reseeds++;
    this.reseedListeners.forEach((f) => f());
  }
}

// ── The game's singleton ──────────────────────────────────────────────────────

export const nearField = new NearField();
// HMR re-evaluates this module: free the previous singleton's WASM world.
if (DEV) {
  const g = globalThis as typeof globalThis & { __nearFieldPrev?: NearField };
  g.__nearFieldPrev?.dispose();
  g.__nearFieldPrev = nearField;
}

let _load: Promise<void> | null = null;
let _loadState: "idle" | "loading" | "ready" | "failed" = "idle";
let _loadMs = 0;
let _loadStartMs = 0;

/** Start loading the engine (idempotent). Failure or timeout leaves analytic collisions only. */
export function loadNearFieldEngine(): Promise<void> {
  if (_load) return _load;
  _loadState = "loading";
  const t0 = performance.now();
  _loadStartMs = t0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${PHYSICS_LOAD_TIMEOUT_MS} ms`)), PHYSICS_LOAD_TIMEOUT_MS);
  });
  _load = Promise.race([import("./rapierBackend").then((m) => m.loadRapierFactory()), timeout])
    .then((factory: PhysicsWorldFactory) => {
      nearField.attachWorld(factory(physicsWorldConfig()));
      _loadState = "ready";
      _loadMs = performance.now() - t0;
    })
    .catch((e: unknown) => {
      _loadState = "failed";
      console.warn("[physics] engine unavailable: celestial bodies keep the analytic sweep, asteroids have NO collision:", e);
    })
    .finally(() => clearTimeout(timer));
  return _load;
}

/** True once loading has succeeded or given up (the loading gate's condition). */
export function nearFieldLoadSettled(): boolean {
  return _loadState === "ready" || _loadState === "failed";
}

export function nearFieldLoadInfo(): { state: string; loadMs: number; startedAtMs: number } {
  return { state: _loadState, loadMs: Math.round(_loadMs), startedAtMs: Math.round(_loadStartMs) };
}

export function physicsWorldConfig(dt = FIXED_DT): { dt: number; restitution: number; friction: number } {
  const t = getPhysicsTuning();
  return { dt, restitution: t.restitution, friction: t.friction };
}
