import * as THREE from "three/webgpu";
import {
  Fn,
  instanceIndex,
  uint,
  int,
  float,
  uvec3,
  vec3,
  vec4,
  floor,
  sqrt,
  select,
  Loop,
  texture3D,
  textureStore,
  storage,
} from "three/tsl";
import { StorageInstancedBufferAttribute } from "three/webgpu";

// =============================================================================
// GPU compute bake of the Nubis-style BASE cloud noise volume (128³ RGBA8).
//
// WHY: generateBaseVolume() in noiseVolumes.ts runs ~5 worleySample calls/voxel
// over 2.1M voxels (each a 27-cell neighbour loop with a sqrt) SYNCHRONOUSLY on
// the main thread — ~1.8s after the CPU mitigation, ~3.9s before — freezing the
// game the first time Earth crosses into the "near" tier. This module runs the
// SAME math as a TSL compute kernel writing a Storage3DTexture directly, so the
// 2.1M voxels are baked in parallel on the GPU off the main thread. The marcher
// samples the storage texture through the SAME texture3D(...).level(int(0)) node
// it already uses for the Data3DTexture — drop-in (the base is sampled at level
// 0 ONLY, so no mip chain is needed; cf. earthClouds.ts).
//
// Modelled on the proven in-repo compute precedents:
//   - cloudLightVolume.ts (Storage3DTexture + textureStore().toWriteOnly()
//     inside Fn().compute(), uint index math, float(uint) conversions).
//   - asteroidCullCompute.ts (storage() buffers, .element(i).assign, If/select).
//
// INTEGER STRATEGY (2026-06-23): float→uint / float→int ConvertNodes do NOT
// reliably materialise to u32/i32 in r183 (a reused uint(select(...float...))
// stayed f32 → "operator + (f32, u32)" compile error). So this port computes
// every cell index in PURE UINT — cell = voxel*grid/N via integer division
// (exact: all base grids use N=128=2^7, so voxel*grid < 2^24 and grid/N is exact
// in f32), neighbour wrap via modular uint arithmetic (no negatives), and the
// Perlin gradient index via float bit-extraction — using ONLY float(uint), uint
// arithmetic, float arithmetic, and select(bool,float,float). No float→int(eger)
// conversion anywhere.
//
// FIDELITY: the Mulberry32 hash is ported bit-faithfully — all integer ops are
// exact in u32 (WGSL u32 wraps mod 2^32, matching JS int32 bit-ops). The ONLY
// divergence from the CPU (which computes in JS f64) is the final f32(u32)/2^32
// in seededRandom and all downstream float math running in f32 vs f64 — a
// ~2^-24 relative perturbation, far below the 1/255 quantisation step. Output is
// statistically identical (histogram parity) but NOT bit-identical. Validate
// with /dev/cloud-volume-gpu (acceptance: per-channel mean|Δ| ≪ 1).
//
// COMPILE COST: the kernel is large (5 Worley loops × hashing + an 8-corner
// Perlin). First-dispatch compute-pipeline compilation can stall (the project's
// known WebGPU compile-stutter — see feedback_webgpu_perf). Warm it with a
// throwaway dispatch at load (behind the loading screen) so the in-flight
// near-tier crossing pays nothing.
// =============================================================================

// ── Lockstep mirror of noiseVolumes.ts — KEEP IN SYNC ──
// These define the cloud LOOK (grids, salts, Alligator radius, crease). If you
// retune them in noiseVolumes.ts, mirror here or the GPU bake drifts from the
// CPU reference. (Mirrored, not imported, matching the cloudLightVolume.ts
// pattern for this cloud code.)
const BASE_SIZE = 128;
const G_LOW = 4;
const G_MID = 8;
const G_HIGH = 16;
const G_VHIGH = 32;
const G_FINE = 48;
const SALT_W4 = 1;
const SALT_W8 = 2;
const SALT_W16 = 3;
const SALT_W32 = 4;
const SALT_W48 = 5;
const SALT_PERLIN = 9999;
const ALLIGATOR_RADIUS = 0.9;
const ALLIGATOR_R2 = ALLIGATOR_RADIUS * ALLIGATOR_RADIUS;
const BILLOW_CREASE_POWER = 1.0;

/* eslint-disable @typescript-eslint/no-explicit-any */
// TSL nodes are dynamically typed; the repo convention (cloudLightVolume.ts)
// uses `any` for them rather than fighting the node generics.
type Node = any;

// =============================================================================
// Hash — bit-faithful port of noiseVolumes.ts seededRandom / hash3.
// Inputs are uint; integer ops are exact in u32 (wrapping). Only the final
// float(u32)/2^32 is f32 (the documented, invisible divergence).
// =============================================================================

// Mulberry32. seed is u32; all ops are u32 (wrapping) → bit-exact vs JS int32.
const tslSeededRandom = (seed: Node): Node => {
  const s = seed.add(uint(0x6d2b79f5)).toVar();
  // s = Math.imul(s ^ (s >>> 15), s | 1)
  s.assign(s.bitXor(s.shiftRight(uint(15))).mul(s.bitOr(uint(1))));
  // s ^= s + Math.imul(s ^ (s >>> 7), s | 61)
  s.assign(
    s.bitXor(s.add(s.bitXor(s.shiftRight(uint(7))).mul(s.bitOr(uint(61))))),
  );
  // ((s ^ (s >>> 14)) >>> 0) / 2^32
  const r = s.bitXor(s.shiftRight(uint(14)));
  return float(r).div(4294967296.0);
};

// hash3(x,y,z,salt). x/y/z are small non-negative uints. The salt term is
// precomputed mod 2^32 in JS (salt is a compile-time constant).
const tslHash3 = (x: Node, y: Node, z: Node, salt: number): Node => {
  const m = x
    .mul(uint(73856093))
    .bitXor(y.mul(uint(19349663)))
    .bitXor(z.mul(uint(83492791)));
  const seed = m.add(uint((salt * 1597334677) >>> 0));
  return tslSeededRandom(seed);
};

// =============================================================================
// Worley (Alligator metaball-max). Mirrors seedWorleyGrid + worleySample
// (USE_ALLIGATOR path). Cell math is pure uint; the sample-space feature
// position folds the neighbour offset in: noiseVolumes.ts stores fx = cell +
// hash3 and samples w.fx[fIdx] + offX == unwrappedCell + hash3, so here
// featurePos = float(unwrappedNeighbourCell) + hash3(wrappedCell).
//
// x,y,z are the UINT voxel coords (0..N-1). The sample scale is grid/N.
// =============================================================================
const tslWorley = (
  x: Node,
  y: Node,
  z: Node,
  grid: number,
  salt: number,
  n: number = BASE_SIZE,
): Node => {
  const Gu = uint(grid);
  const Nu = uint(n);
  const Gm1 = uint(grid - 1);
  const scale = grid / n; // exact in f32 when n is a power of 2 (128 / 64)

  // Base cell = floor(voxel*grid/N), computed as exact uint integer division.
  const cxu = x.mul(Gu).div(Nu);
  const cyu = y.mul(Gu).div(Nu);
  const czu = z.mul(Gu).div(Nu);
  const pxf = float(x).mul(scale);
  const pyf = float(y).mul(scale);
  const pzf = float(z).mul(scale);

  const maxCap = float(0).toVar();
  // 27 neighbour cells (3×3×3) in one uint Loop to keep the shader compact.
  Loop({ start: uint(0), end: uint(27), type: "uint", condition: "<" }, ({ i }: { i: Node }) => {
    const dxp = i.mod(uint(3)); // 0,1,2  (offset = dxp - 1 ∈ {-1,0,1})
    const dyp = i.div(uint(3)).mod(uint(3));
    const dzp = i.div(uint(9));
    // Wrapped cell via modular uint arithmetic: (cell + offset) mod grid, with
    // (offset-1) folded into +Gm1 so the operand stays non-negative.
    const wx = cxu.add(dxp).add(Gm1).mod(Gu);
    const wy = cyu.add(dyp).add(Gm1).mod(Gu);
    const wz = czu.add(dzp).add(Gm1).mod(Gu);
    // Unwrapped neighbour cell as float = cell + (offset).
    const nxf = float(cxu).add(float(dxp)).sub(1);
    const nyf = float(cyu).add(float(dyp)).sub(1);
    const nzf = float(czu).add(float(dzp)).sub(1);
    // Feature point (per-axis decorrelated hash offsets — matches seedWorleyGrid).
    const fx = nxf.add(tslHash3(wx, wy, wz, salt));
    const fy = nyf.add(tslHash3(wx.add(uint(1)), wy.add(uint(3)), wz.add(uint(7)), salt));
    const fz = nzf.add(tslHash3(wx.add(uint(2)), wy.add(uint(5)), wz.add(uint(11)), salt));
    const ddx = pxf.sub(fx);
    const ddy = pyf.sub(fy);
    const ddz = pzf.sub(fz);
    const d2 = ddx.mul(ddx).add(ddy.mul(ddy)).add(ddz.mul(ddz));
    // Smooth round cap, gated on d2 < R² (≡ t < 1). Matches the CPU mitigation.
    const t = sqrt(d2).div(ALLIGATOR_RADIUS);
    const tt = t.mul(t);
    const cap = float(1).sub(tt.mul(3).sub(tt.mul(t).mul(2))); // 1 - (3t² - 2t³)
    const capGated = select(d2.lessThan(ALLIGATOR_R2), cap, float(0));
    maxCap.assign(maxCap.max(capGated));
  });
  return maxCap;
};

// =============================================================================
// Perlin (tileable gradient noise) — mirrors perlinSample / gradHash / dotGrad.
// The 12-gradient table is reproduced via a 3-band decomposition of the index g
// (bands: ±1±1·0 / ±1·0±1 / 0·±1±1). g and its bits are extracted in FLOAT (no
// float→int conversion). Cell coords are pure uint, wrapped corners precomputed.
// =============================================================================
const tslFade = (t: Node): Node =>
  t.mul(t).mul(t).mul(t.mul(t.mul(6).sub(15)).add(10));

// wx/wy/wz are the WRAPPED uint lattice coords of the corner; d* the local offset.
const tslGradDot = (
  wxu: Node,
  wyu: Node,
  wzu: Node,
  dxf: Node,
  dyf: Node,
  dzf: Node,
  salt: number,
): Node => {
  const h = tslHash3(wxu, wyu, wzu, salt); // [0,1)
  // g = floor(h*12) % 12  (the %12 guards the f32 case where h rounds to 1.0).
  const gRaw = floor(h.mul(12));
  const g = gRaw.sub(floor(gRaw.div(12)).mul(12)); // 0..11, float
  const half = floor(g.mul(0.5)); // floor(g/2)
  const gOdd = g.sub(half.mul(2)); // g & 1   → 0 or 1
  const halfOdd = half.sub(floor(half.mul(0.5)).mul(2)); // (g>>1)&1 → 0 or 1
  const s1 = float(1).sub(gOdd.mul(2)); // 1 - 2·(g&1)
  const s2 = float(1).sub(halfOdd.mul(2)); // 1 - 2·((g>>1)&1)
  const gx = select(g.lessThan(8), s1, float(0));
  const gy = select(g.lessThan(4), s2, select(g.greaterThanEqual(8), s1, float(0)));
  const gz = select(g.lessThan(4), float(0), s2);
  return gx.mul(dxf).add(gy.mul(dyf)).add(gz.mul(dzf));
};

// x,y,z are the UINT voxel coords; sample scale = grid/N.
const tslPerlin = (x: Node, y: Node, z: Node, grid: number, salt: number): Node => {
  const Gu = uint(grid);
  const Nu = uint(BASE_SIZE);
  const scale = grid / BASE_SIZE;

  const cxu = x.mul(Gu).div(Nu); // base cell, in [0,grid)
  const cyu = y.mul(Gu).div(Nu);
  const czu = z.mul(Gu).div(Nu);
  const dx = float(x).mul(scale).sub(float(cxu)); // fractional [0,1)
  const dy = float(y).mul(scale).sub(float(cyu));
  const dz = float(z).mul(scale).sub(float(czu));
  const u = tslFade(dx);
  const v = tslFade(dy);
  const wF = tslFade(dz);

  // 8-corner trilinear as a weighted SUM in a Loop (built ONCE → ~8× fewer TSL
  // nodes than unrolling; equals the nested-lerp form). Corner i's bits select
  // the cell offset (+0/+1, wrapped) and the per-axis weight (fade or 1-fade).
  const val = float(0).toVar();
  Loop({ start: uint(0), end: uint(8), type: "uint", condition: "<" }, ({ i }: { i: Node }) => {
    const bx = i.mod(uint(2));
    const by = i.div(uint(2)).mod(uint(2));
    const bz = i.div(uint(4));
    const cxC = cxu.add(bx).mod(Gu);
    const cyC = cyu.add(by).mod(Gu);
    const czC = czu.add(bz).mod(Gu);
    const g = tslGradDot(
      cxC, cyC, czC,
      dx.sub(float(bx)), dy.sub(float(by)), dz.sub(float(bz)),
      salt,
    );
    const wx = select(bx.lessThan(uint(1)), float(1).sub(u), u);
    const wy = select(by.lessThan(uint(1)), float(1).sub(v), v);
    const wz = select(bz.lessThan(uint(1)), float(1).sub(wF), wF);
    val.addAssign(g.mul(wx).mul(wy).mul(wz));
  });
  return val.mul(0.5).add(0.5);
};

// crease — mirrors noiseVolumes.ts crease(). k === 1 is an exact identity (the
// current tuned value), so this is a no-op until BILLOW_CREASE_POWER changes.
const tslCrease = (val: Node): Node => {
  const k = BILLOW_CREASE_POWER;
  if (k === 1) return val;
  return val.max(0).pow(k).mul((k + 1) * 0.5).clamp(0, 1);
};

// =============================================================================
// DETAIL-volume noise — float-POSITION variants (the wisp/curl path samples at
// curl-distorted, NON-voxel-aligned positions, so the integer-division cell
// trick used above does not apply). These convert floor(position)→uint, which
// the base path deliberately avoided; the conversion of a value already reduced
// to [0,grid) is forced to materialise as u32 via .toVar(). Validate detail
// numerically before relying on it (see /dev/cloud-volume-gpu).
//
// Lockstep mirror of noiseVolumes.ts detail constants — KEEP IN SYNC.
// =============================================================================
const DETAIL_SIZE = 64;
const DG_LOW = 4;
const DG_MID = 8;
const DG_HIGH = 16;
const SALT_DW4 = 11;
const SALT_DW8 = 12;
const SALT_DW16 = 13;
const WISP_GRID = 8;
const CURL_GRID = 8;
const CURL_AMP = 2.1;
const SALT_WISP = 41;
const SALT_CURL_A = 42;
const SALT_CURL_B = 43;
const SALT_CURL_C = 44;

// Wrap a (possibly negative) integer-valued float cell coord to [0,grid) and
// convert to u32. The subtraction reduces it to [0,grid) (non-negative) BEFORE
// the uint() cast; .toVar() forces the result to materialise as a u32 variable
// (a bare uint(floatExpr) reused downstream can stay f32 — the base-path bug).
const wrapToUint = (ncF: Node, grid: number): Node =>
  uint(ncF.sub(floor(ncF.div(grid)).mul(grid))).toVar();

// Worley (Alligator) sampled at an ARBITRARY float position (cell-space). Same
// math as tslWorley but the base cell comes from floor(position) and the wrap
// is a true modulo (handles negative positions from the curl distortion).
const tslWorleyAt = (
  pxf: Node,
  pyf: Node,
  pzf: Node,
  grid: number,
  salt: number,
): Node => {
  const cxF = floor(pxf);
  const cyF = floor(pyf);
  const czF = floor(pzf);
  const maxCap = float(0).toVar();
  Loop({ start: uint(0), end: uint(27), type: "uint", condition: "<" }, ({ i }: { i: Node }) => {
    const dxp = i.mod(uint(3));
    const dyp = i.div(uint(3)).mod(uint(3));
    const dzp = i.div(uint(9));
    const nxF = cxF.add(float(dxp)).sub(1); // unwrapped neighbour cell (float, may be < 0)
    const nyF = cyF.add(float(dyp)).sub(1);
    const nzF = czF.add(float(dzp)).sub(1);
    const wx = wrapToUint(nxF, grid);
    const wy = wrapToUint(nyF, grid);
    const wz = wrapToUint(nzF, grid);
    const fx = nxF.add(tslHash3(wx, wy, wz, salt));
    const fy = nyF.add(tslHash3(wx.add(uint(1)), wy.add(uint(3)), wz.add(uint(7)), salt));
    const fz = nzF.add(tslHash3(wx.add(uint(2)), wy.add(uint(5)), wz.add(uint(11)), salt));
    const ddx = pxf.sub(fx);
    const ddy = pyf.sub(fy);
    const ddz = pzf.sub(fz);
    const d2 = ddx.mul(ddx).add(ddy.mul(ddy)).add(ddz.mul(ddz));
    const t = sqrt(d2).div(ALLIGATOR_RADIUS);
    const tt = t.mul(t);
    const cap = float(1).sub(tt.mul(3).sub(tt.mul(t).mul(2)));
    maxCap.assign(maxCap.max(select(d2.lessThan(ALLIGATOR_R2), cap, float(0))));
  });
  return maxCap;
};

// Perlin sampled at an ARBITRARY float position (cell-space). Mirrors tslPerlin
// but cells come from floor(position) with a true-modulo wrap.
const tslPerlinAt = (
  pxf: Node,
  pyf: Node,
  pzf: Node,
  grid: number,
  salt: number,
): Node => {
  const cxF = floor(pxf);
  const cyF = floor(pyf);
  const czF = floor(pzf);
  const dx = pxf.sub(cxF);
  const dy = pyf.sub(cyF);
  const dz = pzf.sub(czF);
  const u = tslFade(dx);
  const v = tslFade(dy);
  const wf = tslFade(dz);

  // 8-corner trilinear weighted SUM in a Loop — built once. This is the big
  // startup win: the curl calls this 12×, so unrolling the 8 corners here was
  // ~96 gradDot blocks in the detail kernel's TSL node graph.
  const val = float(0).toVar();
  Loop({ start: uint(0), end: uint(8), type: "uint", condition: "<" }, ({ i }: { i: Node }) => {
    const bx = i.mod(uint(2));
    const by = i.div(uint(2)).mod(uint(2));
    const bz = i.div(uint(4));
    const cxC = wrapToUint(cxF.add(float(bx)), grid);
    const cyC = wrapToUint(cyF.add(float(by)), grid);
    const czC = wrapToUint(czF.add(float(bz)), grid);
    const g = tslGradDot(
      cxC, cyC, czC,
      dx.sub(float(bx)), dy.sub(float(by)), dz.sub(float(bz)),
      salt,
    );
    const wx = select(bx.lessThan(uint(1)), float(1).sub(u), u);
    const wy = select(by.lessThan(uint(1)), float(1).sub(v), v);
    const wz = select(bz.lessThan(uint(1)), float(1).sub(wf), wf);
    val.addAssign(g.mul(wx).mul(wy).mul(wz));
  });
  return val.mul(0.5).add(0.5);
};

// Curl ∇×ψ of a Perlin vector potential (px,py,pz in WISP cells). Mirrors
// noiseVolumes.ts curlNoise: central finite differences (step h) of a 3-channel
// Perlin potential sampled at CURL_GRID. Returns the offset as a vec3.
const tslCurl = (pxf: Node, pyf: Node, pzf: Node): Node => {
  const r = CURL_GRID / WISP_GRID; // wisp-cell → curl-cell space
  const h = 0.5;
  const inv = 1 / (2 * h);
  const psi = (a: Node, b: Node, c: Node, salt: number): Node =>
    tslPerlinAt(a.mul(r), b.mul(r), c.mul(r), CURL_GRID, salt);
  const dCdy = psi(pxf, pyf.add(h), pzf, SALT_CURL_C).sub(psi(pxf, pyf.sub(h), pzf, SALT_CURL_C)).mul(inv);
  const dBdz = psi(pxf, pyf, pzf.add(h), SALT_CURL_B).sub(psi(pxf, pyf, pzf.sub(h), SALT_CURL_B)).mul(inv);
  const dAdz = psi(pxf, pyf, pzf.add(h), SALT_CURL_A).sub(psi(pxf, pyf, pzf.sub(h), SALT_CURL_A)).mul(inv);
  const dCdx = psi(pxf.add(h), pyf, pzf, SALT_CURL_C).sub(psi(pxf.sub(h), pyf, pzf, SALT_CURL_C)).mul(inv);
  const dBdx = psi(pxf.add(h), pyf, pzf, SALT_CURL_B).sub(psi(pxf.sub(h), pyf, pzf, SALT_CURL_B)).mul(inv);
  const dAdy = psi(pxf, pyf.add(h), pzf, SALT_CURL_A).sub(psi(pxf, pyf.sub(h), pzf, SALT_CURL_A)).mul(inv);
  return vec3(dCdy.sub(dBdz), dAdz.sub(dCdx), dBdx.sub(dAdy));
};

// =============================================================================
// Public API
// =============================================================================

export type CloudBaseVolumeCompute = {
  /** rgba8 storage texture, sampled by the marcher via texture3D(...).level(0). */
  tex: THREE.Storage3DTexture;
  /** Dispatch with renderer.compute(computeNode) (or computeAsync). */
  computeNode: Node;
  /**
   * Validation readback buffer (only when withReadbackBuffer=true). vec4/voxel,
   * indexed by instanceIndex. Read via await renderer.getArrayBufferAsync(this).
   */
  readbackAttr: StorageInstancedBufferAttribute | null;
  dispose: () => void;
};

/**
 * Build the base-volume storage texture + its populate compute node.
 *
 * @param withReadbackBuffer also writes each voxel to a StorageInstancedBuffer
 *   for CPU readback/histogram validation (33 MB; dev only — do NOT enable in
 *   the game path).
 */
export function createCloudBaseVolumeCompute(
  withReadbackBuffer = false,
): CloudBaseVolumeCompute {
  const N = BASE_SIZE;
  const voxels = N * N * N;

  const tex = new THREE.Storage3DTexture(N, N, N);
  tex.format = THREE.RGBAFormat; // drives getFormat()
  tex.type = THREE.UnsignedByteType; // RGBAFormat + UnsignedByte ⇒ rgba8unorm
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace; // raw data, like the CPU Data3DTexture — no sRGB decode on sample
  tex.generateMipmaps = false; // storage textures are single-mip; base uses LOD 0 only

  const readbackAttr = withReadbackBuffer
    ? new StorageInstancedBufferAttribute(voxels, 4)
    : null;
  const readbackNode = readbackAttr
    ? storage(readbackAttr, "vec4", voxels)
    : null;

  const Nu = uint(N);
  const NuHW = uint(N * N);

  const populate = Fn(() => {
    const i = instanceIndex; // uint linear index over the N³ dispatch
    const x = i.mod(Nu);
    const y = i.div(Nu).mod(Nu);
    const z = i.div(NuHW);

    const perlin = tslPerlin(x, y, z, G_LOW, SALT_PERLIN);
    const sw4 = tslWorley(x, y, z, G_LOW, SALT_W4);
    const sw8 = tslWorley(x, y, z, G_MID, SALT_W8);
    const sw16 = tslWorley(x, y, z, G_HIGH, SALT_W16);
    const sw32 = tslWorley(x, y, z, G_VHIGH, SALT_W32);
    const sw48 = tslWorley(x, y, z, G_FINE, SALT_W48);

    // R: Perlin-Worley hybrid. GBA: Schneider-weighted (0.625/0.25/0.125) FBM
    // bands. Identical assembly to generateBaseVolume().
    const worleyR = tslCrease(sw4);
    const r = worleyR.add(perlin.mul(float(1).sub(worleyR)));
    const g = tslCrease(sw4.mul(0.625).add(sw8.mul(0.25)).add(sw16.mul(0.125)));
    const b = tslCrease(sw8.mul(0.625).add(sw16.mul(0.25)).add(sw32.mul(0.125)));
    const a = tslCrease(sw16.mul(0.625).add(sw32.mul(0.25)).add(sw48.mul(0.125)));

    const rgba = vec4(r.clamp(0, 1), g.clamp(0, 1), b.clamp(0, 1), a.clamp(0, 1));
    const coord = (uvec3 as any)(x, y, z);
    textureStore(tex, coord, rgba).toWriteOnly();
    if (readbackNode) readbackNode.element(i).assign(rgba);
  });

  const computeNode = populate().compute(voxels);

  return {
    tex,
    computeNode,
    readbackAttr,
    dispose: () => tex.dispose(),
  };
}

/**
 * Build the DETAIL-volume storage texture (64³) + its populate compute node.
 * RGB = three creased Worley(→Alligator) octaves (voxel-indexed, integer cell
 * math); A = curl-distorted inverted Alligator "wisp" (float-position path).
 * Mirrors generateDetailVolume() in noiseVolumes.ts.
 *
 * NOTE: single-mip. The marcher samples the detail at level 0 AND level 1
 * (DETAIL_SS_MIP). Level-1 handling is an INTEGRATION concern (a second 32³
 * box-downsample, or keep the CPU mip) — out of scope for the bake itself,
 * which this validates at level 0.
 */
export function createCloudDetailVolumeCompute(
  withReadbackBuffer = false,
): CloudBaseVolumeCompute {
  const N = DETAIL_SIZE;
  const voxels = N * N * N;

  const tex = new THREE.Storage3DTexture(N, N, N);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;

  const readbackAttr = withReadbackBuffer
    ? new StorageInstancedBufferAttribute(voxels, 4)
    : null;
  const readbackNode = readbackAttr
    ? storage(readbackAttr, "vec4", voxels)
    : null;

  const Nu = uint(N);
  const NuHW = uint(N * N);
  const sWisp = WISP_GRID / DETAIL_SIZE;

  const populate = Fn(() => {
    const i = instanceIndex;
    const x = i.mod(Nu);
    const y = i.div(Nu).mod(Nu);
    const z = i.div(NuHW);

    // RGB: three creased Worley octaves at voxel positions (integer cell math).
    const rC = tslCrease(tslWorley(x, y, z, DG_LOW, SALT_DW4, N));
    const gC = tslCrease(tslWorley(x, y, z, DG_MID, SALT_DW8, N));
    const bC = tslCrease(tslWorley(x, y, z, DG_HIGH, SALT_DW16, N));

    // A: curl-distorted inverted Alligator wisp (float-position path). NOT creased.
    const wcx = float(x).mul(sWisp);
    const wcy = float(y).mul(sWisp);
    const wcz = float(z).mul(sWisp);
    const c = tslCurl(wcx, wcy, wcz);
    const wisp = float(1).sub(
      tslWorleyAt(
        wcx.add(c.x.mul(CURL_AMP)),
        wcy.add(c.y.mul(CURL_AMP)),
        wcz.add(c.z.mul(CURL_AMP)),
        WISP_GRID,
        SALT_WISP,
      ),
    );

    const rgba = vec4(
      rC.clamp(0, 1),
      gC.clamp(0, 1),
      bC.clamp(0, 1),
      wisp.clamp(0, 1),
    );
    const coord = (uvec3 as any)(x, y, z);
    textureStore(tex, coord, rgba).toWriteOnly();
    if (readbackNode) readbackNode.element(i).assign(rgba);
  });

  const computeNode = populate().compute(voxels);

  return {
    tex,
    computeNode,
    readbackAttr,
    dispose: () => tex.dispose(),
  };
}

/**
 * Per-channel variance-renorm params for the detail level-1 mip. Mirrors
 * noiseVolumes.ts renormalizeToMoments: v' = refMean + (v - l1Mean) * gain,
 * where ref = level-0 moments, l1 = raw (pre-renorm) box-downsampled moments,
 * gain = clamp(refStd/l1Std, 1, 4). The detail noise is deterministic, so these
 * are effectively constants (≈seed-invariant for the noise type) — measured
 * from the CPU reference (see /dev/cloud-volume-gpu) and passed in as kernel
 * constants rather than computed via a runtime GPU reduction.
 */
export type DetailMip1Renorm = {
  refMean: [number, number, number, number];
  l1Mean: [number, number, number, number];
  gain: [number, number, number, number];
};

/**
 * Build the detail LEVEL-1 (32³) box-downsample + renorm of an existing detail
 * level-0 storage texture. Reads the 8 covered level-0 texels via texture3D at
 * their CENTRES ((2i+0.5)/64 → exact texel under LinearFilter), averages, and
 * applies the renorm. A SEPARATE 32³ storage texture (avoids the unverified 3D
 * mip-write); the marcher samples it at level 0 in place of detailVolume.level(1).
 */
export function createDetailMip1Compute(
  level0Tex: THREE.Storage3DTexture,
  renorm: DetailMip1Renorm,
  withReadbackBuffer = false,
): CloudBaseVolumeCompute {
  const N0 = DETAIL_SIZE; // 64
  const N1 = DETAIL_SIZE >> 1; // 32
  const voxels = N1 * N1 * N1;
  const inv0 = 1 / N0;

  const tex = new THREE.Storage3DTexture(N1, N1, N1);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = false;

  const readbackAttr = withReadbackBuffer
    ? new StorageInstancedBufferAttribute(voxels, 4)
    : null;
  const readbackNode = readbackAttr
    ? storage(readbackAttr, "vec4", voxels)
    : null;

  const N1u = uint(N1);
  const N1HW = uint(N1 * N1);
  const refMean = vec4(...renorm.refMean);
  const l1Mean = vec4(...renorm.l1Mean);
  const gain = vec4(...renorm.gain);

  const populate = Fn(() => {
    const i = instanceIndex;
    const x = i.mod(N1u);
    const y = i.div(N1u).mod(N1u);
    const z = i.div(N1HW);

    // Box-average the 8 level-0 texels covering this level-1 voxel. Recover the
    // exact stored BYTE from each sample (round) and average-then-truncate, to
    // mirror downsample3DRGBA's (Σbyte/8)|0 exactly (a plain float average would
    // diverge by up to ~gain LSB after the renorm).
    const acc = vec4(0).toVar();
    for (let dz = 0; dz < 2; dz++) {
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = x.mul(2).add(dx);
          const sy = y.mul(2).add(dy);
          const sz = z.mul(2).add(dz);
          const uvw = vec3(
            float(sx).add(0.5).mul(inv0),
            float(sy).add(0.5).mul(inv0),
            float(sz).add(0.5).mul(inv0),
          );
          const s = texture3D(level0Tex, uvw).level(int(0));
          acc.addAssign(floor(s.mul(255).add(0.5))); // recovered byte [0,255]
        }
      }
    }
    const avg = floor(acc.mul(0.125)).mul(1 / 255); // floor(Σbyte/8) → [0,1]
    const out = refMean.add(avg.sub(l1Mean).mul(gain)).clamp(0, 1);
    const coord = (uvec3 as any)(x, y, z);
    textureStore(tex, coord, out).toWriteOnly();
    if (readbackNode) readbackNode.element(i).assign(out);
  });

  const computeNode = populate().compute(voxels);

  return {
    tex,
    computeNode,
    readbackAttr,
    dispose: () => tex.dispose(),
  };
}

// =============================================================================
// Game integration — lazy singleton + render-loop dispatch.
//
// The texture is allocated lazily (no renderer needed) and returned immediately
// to buildEarthClouds; the marcher binds it via texture3D. The actual GPU bake
// is dispatched ONCE from the render loop (flushCloudBakes), since renderer.
// compute() needs a device and ordering ahead of the marcher draw — buildEarth-
// Clouds runs in React render and has no renderer. Mirrors how cloudLightVolume
// is dispatched from SpaceRenderer.
// =============================================================================

let cachedBaseGpu: CloudBaseVolumeCompute | null = null;
const pendingBakes: CloudBaseVolumeCompute[] = [];

/**
 * The base cloud noise volume as a GPU-baked storage texture. Allocated (empty)
 * on first call and queued for a one-shot GPU bake; the bake runs the next time
 * flushCloudBakes(renderer) is called from the render loop. Drop-in for
 * getCloudBaseVolume() — the marcher samples it via the same texture3D node.
 */
export function getGpuCloudBaseVolume(): THREE.Storage3DTexture {
  if (!cachedBaseGpu) {
    cachedBaseGpu = createCloudBaseVolumeCompute(false);
    pendingBakes.push(cachedBaseGpu);
  }
  return cachedBaseGpu.tex;
}

// Detail level-1 renorm constants, measured from the CPU reference at
// /dev/cloud-volume-gpu (validated: GPU mip1 matches CPU mipmaps[1] up to the
// rgba8 round-vs-truncate ~0.5-LSB offset). ≈seed-invariant for the noise type,
// so reused for any planet.
const DETAIL_MIP1_RENORM: DetailMip1Renorm = {
  refMean: [0.4051184, 0.3954044, 0.3976031, 0.5985577],
  l1Mean: [0.40342, 0.3936896, 0.395891, 0.5968456],
  gain: [1.0161949, 1.06026, 1.2440437, 1.3615878],
};

let cachedDetailGpu: { l0: CloudBaseVolumeCompute; mip1: CloudBaseVolumeCompute } | null = null;

function ensureDetailGpu(): NonNullable<typeof cachedDetailGpu> {
  if (!cachedDetailGpu) {
    const l0 = createCloudDetailVolumeCompute(false);
    // mip1 READS l0's texture → it MUST be queued AFTER l0 so the dispatch
    // order populates l0 before mip1 samples it.
    const mip1 = createDetailMip1Compute(l0.tex, DETAIL_MIP1_RENORM, false);
    pendingBakes.push(l0, mip1);
    cachedDetailGpu = { l0, mip1 };
  }
  return cachedDetailGpu;
}

/**
 * The detail cloud noise volume (64³ level-0) as a GPU-baked storage texture.
 * Drop-in for getCloudDetailVolume(). The matching box-filtered level-1 (for
 * the DETAIL_SS_MIP self-shadow tap) is getGpuCloudDetailMip1().
 */
export function getGpuCloudDetailVolume(): THREE.Storage3DTexture {
  return ensureDetailGpu().l0.tex;
}

/**
 * The detail LEVEL-1 (32³, box-downsampled + variance-renormed) storage texture
 * — sample it at level 0 in place of detailVolume.level(DETAIL_SS_MIP).
 */
export function getGpuCloudDetailMip1(): THREE.Storage3DTexture {
  return ensureDetailGpu().mip1.tex;
}

/**
 * Dispatch any pending one-shot cloud-volume bakes. Call ONCE per frame from the
 * render loop BEFORE anything samples the volume (the marcher draw and the light
 * -volume bake, which also reads the base). No-op once drained, and a no-op
 * until the WebGPU device is ready.
 *
 * NOTE: the first dispatch compiles the (large) compute pipeline synchronously —
 * a one-time ~150 ms hitch (vs the old ~1.9 s CPU block). A startup warm-up
 * (computeAsync at load, behind the loading screen) is the follow-up that
 * removes even that. See project_cloud_noise_startup.
 */
export function flushCloudBakes(renderer: any): void {
  if (pendingBakes.length === 0) return;
  if (!renderer?.backend?.device) return; // device not ready yet — stay queued
  for (const bake of pendingBakes) renderer.compute(bake.computeNode);
  pendingBakes.length = 0;
}

let warmed = false;

/**
 * Warm-up: at app start (player still far from Earth), eagerly allocate + bake
 * the static cloud volumes via computeAsync — the compute-pipeline compile
 * (~150 ms) and the bake run OFF the main thread, so by the time Earth reaches
 * the near tier the volumes are long ready and flushCloudBakes() there is a
 * no-op with zero gameplay hitch. Idempotent; retries until the device exists.
 * Call once per frame from the render loop. (flushCloudBakes remains the
 * synchronous safety net for the rare case the near tier is reached before the
 * async warm finished — e.g. spawning at Earth.)
 */
export function warmCloudBakes(renderer: any): void {
  if (warmed) return;
  if (!renderer?.backend?.device) return; // device not ready — try next frame
  warmed = true;
  getGpuCloudBaseVolume(); // ensure base allocated + queued
  getGpuCloudDetailVolume(); // ensure detail level-0 + mip1 allocated + queued
  // Dispatch in queue order (base, detail L0, detail mip1) — mip1 reads detail
  // L0, which precedes it in pendingBakes, so the GPU populates L0 first.
  for (const bake of pendingBakes) renderer.computeAsync?.(bake.computeNode);
  pendingBakes.length = 0;
}
