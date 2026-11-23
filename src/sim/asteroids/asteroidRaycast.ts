// ---------------------------------------------------------------------------
// EXACT RAY vs ASTEROID MESH — docs/VFX_REALISM_PLAN.md §2, B1.
//
// The mining beam never bends: it ends where the ship's forward ray meets the rock's
// RENDERED surface, and mining halts while it misses. Bounding spheres are not the
// surface (an irregular rock sits metres inside its sphere), so this tests the LOD0
// triangles under the exact instance transform the renderer draws:
//   world = x + q·(v · scale),  q = instanceQuat × baseQuat,  scale = r/geomRadius
// (asteroidColliders.ts `asteroidInstanceTransform`). LOD0 meshes are ≤ ~1,000 triangles,
// so brute force behind a sphere early-out is microseconds; no BVH.
// Pure, allocation-free in the hot path, headless (sim-core rules).
// ---------------------------------------------------------------------------

import type { AsteroidChunkData } from "./runtimeTypes";

type RayModel = {
  /** Triangles in raw geometry space, 9 floats each. */
  tris: Float32Array;
  baseQuat: [number, number, number, number];
  /** scale = radiusM · invBaseRadius · baseScale (= radiusM / geometry radius). */
  invBaseRadius: number;
  baseScale: number;
};

const models = new Map<string, RayModel>();

/** Register a model's LOD0 triangles (`index` null = non-indexed). Called where the render registry loads. */
export function registerAsteroidRayModel(
  modelId: string,
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null,
  baseQuat: [number, number, number, number],
  baseRadiusM: number,
  baseScale: number,
): void {
  const n = index ? index.length : positions.length / 3;
  const tris = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const v = index ? index[k] : k;
    tris[k * 3] = positions[v * 3];
    tris[k * 3 + 1] = positions[v * 3 + 1];
    tris[k * 3 + 2] = positions[v * 3 + 2];
  }
  models.set(modelId, { tris, baseQuat: [...baseQuat], invBaseRadius: 1 / baseRadiusM, baseScale });
}

export function hasAsteroidRayModels(): boolean {
  return models.size > 0;
}

export type AsteroidRayHit = {
  /** Distance along the ray, metres. */
  t: number;
  fieldId: string;
  chunkKey: string;
  modelId: string;
  localIndex: number;
  instanceId: number;
  radiusM: number;
  /** Hit point and outward surface normal, field-local metres. */
  point: [number, number, number];
  normal: [number, number, number];
  /** Rock centre, field-local metres. */
  center: [number, number, number];
};

export function createAsteroidRayHit(): AsteroidRayHit {
  return {
    t: Infinity, fieldId: "", chunkKey: "", modelId: "", localIndex: -1, instanceId: 0, radiusM: 0,
    point: [0, 0, 0], normal: [0, 0, 0], center: [0, 0, 0],
  };
}

// Scratch (single-threaded; the hot path allocates nothing).
const _q = [0, 0, 0, 1];
const _o = [0, 0, 0];
const _d = [0, 0, 0];
const _n = [0, 0, 0];
const _r = [0, 0, 0];

/** v ← conj(q)·v (q unit). */
function rotateInv(q: number[], x: number, y: number, z: number, out: number[]): void {
  const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3];
  // t = 2·(q.xyz × v); v' = v + qw·t + q.xyz × t
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
}

function rotate(q: number[], x: number, y: number, z: number, out: number[]): void {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
}

/**
 * Nearest triangle hit of a model-space ray (Möller–Trumbore, both faces), or Infinity.
 * Writes the hit triangle's geometric normal (model space, unnormalised) to `_n`.
 */
function meshT(tris: Float32Array, o: number[], d: number[], tMax: number): number {
  let best = tMax;
  for (let k = 0; k < tris.length; k += 9) {
    const ax = tris[k], ay = tris[k + 1], az = tris[k + 2];
    const e1x = tris[k + 3] - ax, e1y = tris[k + 4] - ay, e1z = tris[k + 5] - az;
    const e2x = tris[k + 6] - ax, e2y = tris[k + 7] - ay, e2z = tris[k + 8] - az;
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) continue;
    const inv = 1 / det;
    const sx = o[0] - ax, sy = o[1] - ay, sz = o[2] - az;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 1e-6 && t < best) {
      best = t;
      _n[0] = e1y * e2z - e1z * e2y; _n[1] = e1z * e2x - e1x * e2z; _n[2] = e1x * e2y - e1y * e2x;
    }
  }
  return best;
}

/**
 * Test one instance. `o`/`dir` field-local metres (dir unit). Returns the hit distance, or
 * Infinity; on a hit `out` is filled (point/normal/center in field-local metres).
 */
export function rayHitInstance(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  chunk: AsteroidChunkData, modelId: string, i: number,
  tMax: number,
  out: AsteroidRayHit,
): number {
  const m = models.get(modelId);
  const inst = chunk.instancesByModel[modelId];
  if (!inst || i < 0 || i >= inst.count) return Infinity;
  const cx = chunk.originKm[0] * 1000 + inst.positionsM[i * 3];
  const cy = chunk.originKm[1] * 1000 + inst.positionsM[i * 3 + 1];
  const cz = chunk.originKm[2] * 1000 + inst.positionsM[i * 3 + 2];
  const r = inst.radiiM[i];
  // Sphere early-out (the geometry fits its bounding sphere, which is the radius).
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tc = lx * dx + ly * dy + lz * dz;
  const d2 = lx * lx + ly * ly + lz * lz - tc * tc;
  if (d2 > r * r * 1.0001) return Infinity;
  const th = Math.sqrt(Math.max(0, r * r - d2));
  if (tc + th < 0 || tc - th > tMax) return Infinity;

  let tHit: number;
  if (m) {
    const qa = inst.quaternions, b = m.baseQuat;
    const ax = qa[i * 4], ay = qa[i * 4 + 1], az = qa[i * 4 + 2], aw = qa[i * 4 + 3];
    let qx = aw * b[0] + ax * b[3] + ay * b[2] - az * b[1];
    let qy = aw * b[1] - ax * b[2] + ay * b[3] + az * b[0];
    let qz = aw * b[2] + ax * b[1] - ay * b[0] + az * b[3];
    let qw = aw * b[3] - ax * b[0] - ay * b[1] - az * b[2];
    const ql = Math.hypot(qx, qy, qz, qw) || 1;
    qx /= ql; qy /= ql; qz /= ql; qw /= ql;
    _q[0] = qx; _q[1] = qy; _q[2] = qz; _q[3] = qw;
    const scale = r * m.invBaseRadius * m.baseScale;
    // Model-space ray with the SAME parameter t: o' = q⁻¹(o − c)/s, d' = q⁻¹d/s.
    rotateInv(_q, -lx, -ly, -lz, _o);
    rotateInv(_q, dx, dy, dz, _d);
    _o[0] /= scale; _o[1] /= scale; _o[2] /= scale;
    _d[0] /= scale; _d[1] /= scale; _d[2] /= scale;
    tHit = meshT(m.tris, _o, _d, tMax);
    if (!(tHit < tMax)) return Infinity;
    // Normal: model → world is rotation then uniform scale, so the normal just rotates.
    rotate(_q, _n[0], _n[1], _n[2], _r);
  } else {
    // No mesh registered (headless, or before load): the sphere.
    tHit = tc - th;
    if (tHit < 0 || tHit > tMax) return Infinity;
    _r[0] = ox + dx * tHit - cx; _r[1] = oy + dy * tHit - cy; _r[2] = oz + dz * tHit - cz;
  }
  let nl = Math.hypot(_r[0], _r[1], _r[2]) || 1;
  // Face the ray: both triangle windings are accepted above.
  if (_r[0] * dx + _r[1] * dy + _r[2] * dz > 0) nl = -nl;
  out.t = tHit;
  out.fieldId = chunk.fieldId;
  out.chunkKey = chunk.key;
  out.modelId = modelId;
  out.localIndex = i;
  out.instanceId = inst.instanceIds[i] >>> 0;
  out.radiusM = r;
  out.point[0] = ox + dx * tHit; out.point[1] = oy + dy * tHit; out.point[2] = oz + dz * tHit;
  out.normal[0] = _r[0] / nl; out.normal[1] = _r[1] / nl; out.normal[2] = _r[2] / nl;
  out.center[0] = cx; out.center[1] = cy; out.center[2] = cz;
  return tHit;
}

const _tmpHit = createAsteroidRayHit();

/**
 * Nearest rock surface along a ray through every loaded chunk of one field.
 * `o` field-local metres, `dir` unit, `tMax` metres. Fills `out` and returns true on a hit.
 */
export function castAsteroidRayInField(
  chunks: { forEach(cb: (chunk: AsteroidChunkData) => void): void },
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  tMax: number,
  out: AsteroidRayHit,
): boolean {
  let best = tMax;
  let found = false;
  chunks.forEach((chunk) => {
    // Chunk AABB (km, field-local) vs the segment's bounding box, padded by the largest rock.
    const pad = chunk.maxRadiusM;
    const ex = ox + dx * best, ey = oy + dy * best, ez = oz + dz * best;
    if (Math.min(ox, ex) - pad > chunk.aabbMaxKm[0] * 1000 || Math.max(ox, ex) + pad < chunk.aabbMinKm[0] * 1000 ||
        Math.min(oy, ey) - pad > chunk.aabbMaxKm[1] * 1000 || Math.max(oy, ey) + pad < chunk.aabbMinKm[1] * 1000 ||
        Math.min(oz, ez) - pad > chunk.aabbMaxKm[2] * 1000 || Math.max(oz, ez) + pad < chunk.aabbMinKm[2] * 1000) return;
    for (const modelId in chunk.instancesByModel) {
      const inst = chunk.instancesByModel[modelId];
      for (let i = 0; i < inst.count; i++) {
        const t = rayHitInstance(ox, oy, oz, dx, dy, dz, chunk, modelId, i, best, _tmpHit);
        if (t < best) {
          best = t;
          found = true;
          copyHit(_tmpHit, out);
        }
      }
    }
  });
  return found;
}

export function copyHit(a: AsteroidRayHit, b: AsteroidRayHit): void {
  b.t = a.t; b.fieldId = a.fieldId; b.chunkKey = a.chunkKey; b.modelId = a.modelId;
  b.localIndex = a.localIndex; b.instanceId = a.instanceId; b.radiusM = a.radiusM;
  b.point[0] = a.point[0]; b.point[1] = a.point[1]; b.point[2] = a.point[2];
  b.normal[0] = a.normal[0]; b.normal[1] = a.normal[1]; b.normal[2] = a.normal[2];
  b.center[0] = a.center[0]; b.center[1] = a.center[1]; b.center[2] = a.center[2];
}
