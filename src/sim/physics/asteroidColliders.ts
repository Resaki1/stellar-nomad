/**
 * Streamed asteroid colliders (docs/PHYSICS_PLAN.md §7.2): fixed convex hulls from each model's
 * LOD1 vertices, placed with the exact transform the GPU cull pass gives the rendered instance.
 */
import { Quaternion } from "three";
import type { FrameId } from "@/sim/frames";
import type { AsteroidChunkData, AsteroidChunkModelInstances } from "@/sim/asteroids/runtimeTypes";
import type { NearField, NearFieldColliderId } from "./nearField";
import { getPhysicsTuning } from "./physicsTuning";
import type { ColliderShape, ConvexHullData } from "./types";

export interface AsteroidColliderModel {
  modelId: string;
  /** Collision mesh vertices, model space. */
  points: Float32Array;
  source: "lod1" | "lod0";
  /** The near tier's uBaseQuat, uInvBaseRadius, uBaseScale (f64; the GPU rounds them). */
  baseQuat: [number, number, number, number];
  invBaseRadius: number;
  baseScale: number;
  hull: ConvexHullData | null;
  hullFailed: boolean;
  /** Registration-time facts for the harness (vertex counts, mesh radii). */
  info: Record<string, number>;
}

const models = new Map<string, AsteroidColliderModel>();

/** Register (or refresh) a model's collision mesh and render transform constants. */
export function registerAsteroidColliderModel(
  modelId: string,
  points: Float32Array,
  source: "lod1" | "lod0",
  baseQuat: [number, number, number, number],
  baseRadiusM: number,
  baseScale: number,
  info: Record<string, number> = {},
): void {
  const prev = models.get(modelId);
  const samePoints = prev !== undefined && prev.points.length === points.length && prev.points.every((v, i) => v === points[i]);
  models.set(modelId, {
    modelId, points, source,
    baseQuat: [baseQuat[0], baseQuat[1], baseQuat[2], baseQuat[3]],
    invBaseRadius: 1 / baseRadiusM,
    baseScale,
    hull: samePoints ? prev.hull : null,
    hullFailed: samePoints ? prev.hullFailed : false,
    info,
  });
}

export function getAsteroidColliderModel(modelId: string): AsteroidColliderModel | undefined {
  return models.get(modelId);
}

export function listAsteroidColliderModels(): AsteroidColliderModel[] {
  return Array.from(models.values());
}

/** The model's unit-scale hull, built once by the engine (null until a world exists or if degenerate). */
export function ensureModelHull(m: AsteroidColliderModel, builder: Pick<NearField, "convexHull" | "ready">): ConvexHullData | null {
  if (m.hull || m.hullFailed) return m.hull;
  if (m.points.length < 12) {
    m.hullFailed = true;
    return null;
  }
  let h: ConvexHullData | null = null;
  try {
    h = builder.convexHull(m.points);
  } catch {
    h = null;
  }
  // No world yet: try again later. A world that returned null means a degenerate set.
  if (h) m.hull = h;
  else if (builder.ready) m.hullFailed = true;
  return m.hull;
}

export interface InstanceTransform {
  /** Field-local metres (f64 truth; the GPU draws it to < 1 mm via split precision). */
  x: number; y: number; z: number;
  /** instanceQuat × baseQuat, unnormalised, as the cull shader composes it. */
  qx: number; qy: number; qz: number; qw: number;
  /** radius · uInvBaseRadius · uBaseScale. */
  scale: number;
  radiusM: number;
}

/** The rendered instance transform (asteroidCullCompute.ts + GpuSlotAllocator.ts), for instance `i`. */
export function asteroidInstanceTransform(
  originKm: readonly number[],
  inst: AsteroidChunkModelInstances,
  i: number,
  m: Pick<AsteroidColliderModel, "baseQuat" | "invBaseRadius" | "baseScale">,
  out: InstanceTransform,
): InstanceTransform {
  const p = inst.positionsM, q = inst.quaternions;
  out.x = originKm[0] * 1000 + p[i * 3];
  out.y = originKm[1] * 1000 + p[i * 3 + 1];
  out.z = originKm[2] * 1000 + p[i * 3 + 2];
  const ax = q[i * 4], ay = q[i * 4 + 1], az = q[i * 4 + 2], aw = q[i * 4 + 3];
  const [bx, by, bz, bw] = m.baseQuat;
  out.qx = aw * bx + ax * bw + ay * bz - az * by;
  out.qy = aw * by - ax * bz + ay * bw + az * bx;
  out.qz = aw * bz + ax * by - ay * bx + az * bw;
  out.qw = aw * bw - ax * bx - ay * by - az * bz;
  out.radiusM = inst.radiiM[i];
  out.scale = out.radiusM * m.invBaseRadius * m.baseScale;
  return out;
}

/** Collider shape for one instance: the scaled model hull, or a ball of the radius as fallback. */
export function asteroidColliderShape(m: AsteroidColliderModel | undefined, hull: ConvexHullData | null, scale: number, radiusM: number): ColliderShape {
  if (!m || !hull) return { kind: "ball", radiusM };
  const src = hull.points;
  const pts = new Float32Array(src.length);
  for (let k = 0; k < src.length; k++) pts[k] = src[k] * scale;
  return { kind: "hull", points: pts };
}

export interface FieldColliderContext {
  chunks: ReadonlyMap<string, AsteroidChunkData>;
  /** Frame the field rides in, and the field anchor relative to that frame's origin, km. */
  frameId: FrameId;
  anchorRelKm: readonly number[];
  /** Ship centre relative to the field anchor, km. */
  shipX: number; shipY: number; shipZ: number;
}

interface Entry {
  instanceId: number;
  chunkKey: string;
  modelId: string;
  colliderId: NearFieldColliderId | null;
  kind: "hull" | "ball" | null;
  seen: number;
  /** Surface distance from the ship at the last scan, km. */
  distKm: number;
  dropped: boolean;
  /** Raw instance data: field-local position (m), instance quaternion, radius. */
  x: number; y: number; z: number;
  iq: [number, number, number, number];
  radiusM: number;
  /** Composed at creation (needs the model's base transform). */
  t: InstanceTransform;
}

export interface AsteroidColliderInfo {
  instanceId: number;
  chunkKey: string;
  modelId: string;
  colliderId: number | null;
  kind: "hull" | "ball" | null;
  inEngine: boolean;
  dropped: boolean;
  distKm: number;
  transform: InstanceTransform;
}

const SCAN_EVERY_FRAMES = 3;
const IDENTITY_BASE = { baseQuat: [0, 0, 0, 1] as [number, number, number, number], invBaseRadius: 1, baseScale: 1 };

/** Same composition as asteroidInstanceTransform, from an entry's stored raw instance data. */
function composeTransform(e: Entry, m: AsteroidColliderModel): void {
  const [ax, ay, az, aw] = e.iq;
  const [bx, by, bz, bw] = m.baseQuat;
  const t = e.t;
  t.qx = aw * bx + ax * bw + ay * bz - az * by;
  t.qy = aw * by - ax * bz + ay * bw + az * bx;
  t.qz = aw * bz + ax * by - ay * bx + az * bw;
  t.qw = aw * bw - ax * bx - ay * by - az * bz;
  t.scale = e.radiusM * m.invBaseRadius * m.baseScale;
}
const _pending: Entry[] = [];
const _byDist = (a: Entry, b: Entry): number => a.distKm - b.distKm;
const _rel = { x: 0, y: 0, z: 0 };
const _q = new Quaternion();

/** One field's colliders around the ship. Positions live in the near field's registry (frame-relative). */
export class AsteroidFieldColliders {
  readonly tag: string;
  /** chunkKey → instanceId → entry: instance ids are 32-bit hashes and do collide across chunks. */
  private readonly entries = new Map<string, Map<number, Entry>>();
  private epoch = 0;
  private frame = 0;
  private forceScan = true;
  private capLogged = false;
  private unsubscribe: (() => void) | null = null;
  readonly counters = {
    created: 0, removed: 0, upgraded: 0, scans: 0,
    maxCreateMsFrame: 0, maxCreatedFrame: 0, lastCreateMs: 0, dropped: 0, mustCreateOverBudget: 0,
    maxSingleCreateMs: 0, meanCreateMs: 0,
  };

  constructor(readonly fieldId: string, private readonly nf: NearField) {
    this.tag = `asteroid:${fieldId}`;
  }

  /** Subscribe to re-seeds; call from the owning effect (StrictMode re-runs it after `dispose`). */
  attach(): void {
    this.unsubscribe ??= this.nf.onReseed(() => (this.forceScan = true));
    this.forceScan = true;
  }

  private forEachEntry(f: (e: Entry) => void): void {
    this.entries.forEach((m) => m.forEach(f));
  }

  /** Once per rendered frame. */
  update(ctx: FieldColliderContext): void {
    if (this.forceScan || ++this.frame >= SCAN_EVERY_FRAMES) {
      this.frame = 0;
      this.forceScan = false;
      this.scan(ctx);
    }
    this.create(ctx);
  }

  /** A loaded chunk changed (an `asteroid.destroyed` event): drop colliders of instances it lost, at once. */
  onChunkUpdated(chunkKey: string, chunk: AsteroidChunkData): void {
    this.entries.get(chunkKey)?.forEach((e) => {
      const inst = chunk.instancesByModel[e.modelId];
      let found = false;
      if (inst) for (let i = 0; i < inst.count && !found; i++) found = inst.instanceIds[i] >>> 0 === e.instanceId;
      if (!found) this.remove(e);
    });
  }

  clear(): void {
    this.forEachEntry((e) => this.remove(e));
  }

  dispose(): void {
    this.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  stats(): { entries: number; colliders: number; hull: number; ball: number; pending: number; dropped: number; counters: AsteroidFieldColliders["counters"] } {
    let colliders = 0, hull = 0, ball = 0, pending = 0, dropped = 0, entries = 0;
    this.forEachEntry((e) => {
      entries++;
      if (e.dropped) dropped++;
      else if (e.colliderId === null) pending++;
      else {
        colliders++;
        if (e.kind === "hull") hull++;
        else ball++;
      }
    });
    return { entries, colliders, hull, ball, pending, dropped, counters: { ...this.counters } };
  }

  list(): AsteroidColliderInfo[] {
    const all: Entry[] = [];
    this.forEachEntry((e) => all.push(e));
    return all.map((e) => ({
      instanceId: e.instanceId, chunkKey: e.chunkKey, modelId: e.modelId,
      colliderId: e.colliderId, kind: e.kind,
      inEngine: e.colliderId !== null && this.nf.colliderInEngine(e.colliderId),
      dropped: e.dropped, distKm: e.distKm, transform: { ...e.t },
    }));
  }

  colliderOf(instanceId: number): NearFieldColliderId | null {
    const id = instanceId >>> 0;
    let out: NearFieldColliderId | null = null;
    this.entries.forEach((m) => {
      const e = m.get(id);
      if (e && out === null) out = e.colliderId;
    });
    return out;
  }

  private remove(e: Entry): void {
    if (e.colliderId !== null) {
      this.nf.removeCollider(e.colliderId);
      this.counters.removed++;
    }
    const m = this.entries.get(e.chunkKey);
    if (m?.get(e.instanceId) === e) {
      m.delete(e.instanceId);
      if (m.size === 0) this.entries.delete(e.chunkKey);
    }
  }

  private scan(ctx: FieldColliderContext): void {
    const t = getPhysicsTuning();
    const R = t.physicsRadiusKm;
    // Keep band: a rock at the edge must not churn as the ship jitters across it.
    const keep = R * 1.1 + 0.05;
    const ep = ++this.epoch;
    this.counters.scans++;
    const sx = ctx.shipX, sy = ctx.shipY, sz = ctx.shipZ;
    ctx.chunks.forEach((chunk, key) => {
      const mn = chunk.aabbMinKm, mx = chunk.aabbMaxKm;
      const dx = Math.max(mn[0] - sx, 0, sx - mx[0]);
      const dy = Math.max(mn[1] - sy, 0, sy - mx[1]);
      const dz = Math.max(mn[2] - sz, 0, sz - mx[2]);
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) - chunk.maxRadiusM / 1000 > keep) return;
      const o = chunk.originKm;
      let byId = this.entries.get(key);
      for (const modelId in chunk.instancesByModel) {
        const inst = chunk.instancesByModel[modelId];
        const p = inst.positionsM;
        for (let i = 0; i < inst.count; i++) {
          const ex = o[0] + p[i * 3] / 1000 - sx, ey = o[1] + p[i * 3 + 1] / 1000 - sy, ez = o[2] + p[i * 3 + 2] / 1000 - sz;
          const d = Math.sqrt(ex * ex + ey * ey + ez * ez) - inst.radiiM[i] / 1000;
          if (d > keep) continue;
          const id = inst.instanceIds[i] >>> 0;
          let e = byId?.get(id);
          if (!e) {
            if (d > R) continue;
            const tr = asteroidInstanceTransform(o, inst, i, IDENTITY_BASE, { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, scale: 1, radiusM: 0 });
            const q = inst.quaternions;
            e = {
              instanceId: id, chunkKey: key, modelId, colliderId: null, kind: null, seen: ep, distKm: d, dropped: false,
              x: tr.x, y: tr.y, z: tr.z, iq: [q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3]], radiusM: tr.radiusM, t: tr,
            };
            if (!byId) this.entries.set(key, (byId = new Map()));
            byId.set(id, e);
          }
          e.seen = ep;
          e.distKm = d;
        }
      }
    });
    // Unloaded chunk, destroyed instance, out of range, or a reloaded world.
    this.forEachEntry((e) => {
      if (e.seen !== ep) this.remove(e);
    });
    this.applyCap(t.colliderCap);
  }

  private applyCap(cap: number): void {
    _pending.length = 0;
    this.forEachEntry((e) => _pending.push(e));
    if (_pending.length <= cap) {
      for (let i = 0; i < _pending.length; i++) _pending[i].dropped = false;
      this.counters.dropped = 0;
      _pending.length = 0;
      return;
    }
    _pending.sort(_byDist);
    let dropped = 0;
    for (let i = 0; i < _pending.length; i++) {
      const e = _pending[i];
      e.dropped = i >= cap;
      if (!e.dropped) continue;
      dropped++;
      if (e.colliderId !== null) {
        this.nf.removeCollider(e.colliderId);
        this.counters.removed++;
        e.colliderId = null;
        e.kind = null;
      }
    }
    this.counters.dropped = dropped;
    if (!this.capLogged) {
      this.capLogged = true;
      console.warn(`[physics] ${this.tag}: ${_pending.length} rocks within range, cap ${cap}: dropped the ${dropped} farthest (nearest dropped ${(_pending[cap].distKm * 1000).toFixed(0)} m)`);
    }
    _pending.length = 0;
  }

  private create(ctx: FieldColliderContext): void {
    const t = getPhysicsTuning();
    _pending.length = 0;
    this.forEachEntry((e) => {
      if (e.dropped) return;
      if (e.colliderId === null) _pending.push(e);
      else if (e.kind === "ball") {
        const m = models.get(e.modelId);
        if (m && !m.hullFailed && (m.hull || this.nf.ready)) _pending.push(e);
      }
    });
    if (_pending.length === 0) return;
    _pending.sort(_byDist);
    const t0 = performance.now();
    let n = 0, over = 0;
    for (let i = 0; i < _pending.length; i++) {
      const e = _pending[i];
      const elapsed = performance.now() - t0;
      // Stop BEFORE the creation that would overrun: one hull costs ~0.1–0.5 ms (engine re-hulls it).
      if (n > 0 && elapsed + this.counters.meanCreateMs >= t.colliderBudgetMs) {
        if (e.distKm > t.colliderMustCreateKm || over >= t.colliderMustCreateMaxPerFrame) break;
        over++;
        this.counters.mustCreateOverBudget++;
      }
      const m = models.get(e.modelId);
      const hull = m ? ensureModelHull(m, this.nf) : null;
      if (e.colliderId !== null) {
        if (!hull) continue;
        this.nf.removeCollider(e.colliderId);
        this.counters.removed++;
        this.counters.upgraded++;
      }
      if (m) composeTransform(e, m);
      const a = ctx.anchorRelKm;
      _rel.x = a[0] + e.x / 1000; _rel.y = a[1] + e.y / 1000; _rel.z = a[2] + e.z / 1000;
      _q.set(e.t.qx, e.t.qy, e.t.qz, e.t.qw).normalize();
      const c0 = performance.now();
      e.colliderId = this.nf.addCollider(asteroidColliderShape(m, hull, e.t.scale, e.t.radiusM), ctx.frameId, _rel, _q, this.tag);
      const cm = performance.now() - c0;
      if (cm > this.counters.maxSingleCreateMs) this.counters.maxSingleCreateMs = cm;
      this.counters.meanCreateMs = this.counters.meanCreateMs === 0 ? cm : this.counters.meanCreateMs * 0.9 + cm * 0.1;
      e.kind = hull ? "hull" : "ball";
      this.counters.created++;
      n++;
    }
    const ms = performance.now() - t0;
    this.counters.lastCreateMs = ms;
    if (ms > this.counters.maxCreateMsFrame) this.counters.maxCreateMsFrame = ms;
    if (n > this.counters.maxCreatedFrame) this.counters.maxCreatedFrame = n;
    _pending.length = 0;
  }
}

/** Live field collider sets, by field id (harness and debug view). */
export const asteroidFieldColliders = new Map<string, AsteroidFieldColliders>();

/** Dev/test view of one asteroid tier batch (one field, one model). */
export interface AsteroidBatchDebug {
  tier: "near" | "mid" | "far";
  mesh: { readonly visible: boolean; readonly matrixWorld: { readonly elements: ArrayLike<number> } };
  /** Visible instance count the last cull wrote (GPU read-back). */
  readCount(): Promise<number>;
  /** The cull's output buffer (GPU read-back): mat4 per instance (near/mid) or vec4 pos+radius (far). */
  readOutput(): Promise<Float32Array>;
  /** The cull's origin/camera/frustum uniforms and its distance band [min, max) in metres. */
  cull: {
    uOriginHigh: { value: { x: number; y: number; z: number } };
    uOriginLow: { value: { x: number; y: number; z: number } };
    originM: ArrayLike<number>;
    uCameraPos: { value: { x: number; y: number; z: number } };
    uFrustum: { value: { x: number; y: number; z: number; w: number } }[];
    bandM(): [number, number];
  };
}

/** Dev/test: what the GPU receives: slot allocators per field, near-tier cull uniforms per `${fieldId}:${modelId}`. */
export const renderDebug = {
  allocators: new Map<string, { readonly current: ReadonlyMap<string, { readInstance(chunkKey: string, localIndex: number): number[] | null }> }>(),
  nearUniforms: new Map<string, {
    uBaseQuat: { value: { x: number; y: number; z: number; w: number } };
    uInvBaseRadius: { value: number };
    uBaseScale: { value: number };
    uOriginHigh: { value: { x: number; y: number; z: number } };
    uOriginLow: { value: { x: number; y: number; z: number } };
    /** f64 world origin in field-local metres the origin uniforms were last set from. */
    originM: ArrayLike<number>;
    uCameraPos: { value: { x: number; y: number; z: number } };
    uNearRadiusM: { value: number };
    uFrustum: { value: { x: number; y: number; z: number; w: number } }[];
  }>(),
  /** Keyed `${tier}:${fieldId}:${modelId}`. */
  batches: new Map<string, AsteroidBatchDebug>(),
};
