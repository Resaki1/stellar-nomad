#!/usr/bin/env node
// =============================================================================
// bake_takram_noise.mjs — offline baker for takram/three-clouds' EXACT noise
// recipe (docs/CLOUD_VS_TAKRAM.md Phase 3), ported from their GLSL:
//   packages/clouds/src/shaders/{perlin.glsl, tileableNoise.glsl,
//                                 cloudShape.frag, cloudShapeDetail.frag}
// Produces two single-channel Uint8 3D volumes (RedFormat, tileable):
//   public/textures/clouds/takram_shape.bin        128^3  (Perlin-Worley)
//   public/textures/clouds/takram_shape_detail.bin  32^3  (Worley-FBM)
// Layout: x fastest, then y, then z (matches Data3DTexture row/col/depth).
// Also writes mid-Z slices (.raw, 8-bit) for visual verification.
//
// Bit-exactness vs takram is NOT required — the CHARACTER (Perlin-Worley billow
// floor at their frequencies) is what gives the cauliflower look. This port is
// faithful to the recipe (same freqs/weights/composition, tileable).
//
// Run:  node scripts/bake_takram_noise.mjs
// =============================================================================

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SHAPE_SIZE = 128;
const DETAIL_SIZE = 32;

// ── scalar helpers (GLSL semantics) ─────────────────────────────────────────
const fract = (x) => x - Math.floor(x);
const glslMod = (x, y) => x - Math.floor(x / y) * y; // GLSL mod (y>0 here)
const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const step = (edge, x) => (x < edge ? 0 : 1);
// remap [ol,oh]→[nl,nh] (no clamp, like takram's remap)
const remap = (v, ol, oh, nl, nh) => nl + ((v - ol) * (nh - nl)) / (oh - ol);

// ── tileableNoise.glsl: value noise + tileable Worley ───────────────────────
const hash = (n) => fract(Math.sin(n + 1.951) * 43758.5453);

// value noise on the integer lattice (n = px + py*57 + pz*113)
function valueNoise(x, y, z) {
  const px = Math.floor(x), py = Math.floor(y), pz = Math.floor(z);
  let fx = x - px, fy = y - py, fz = z - pz;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const n = px + py * 57 + 113 * pz;
  return mix(
    mix(mix(hash(n + 0), hash(n + 1), fx), mix(hash(n + 57), hash(n + 58), fx), fy),
    mix(mix(hash(n + 113), hash(n + 114), fx), mix(hash(n + 170), hash(n + 171), fx), fy),
    fz,
  );
}

// getWorleyNoise(p, cellCount): tileable (period `cellCount` in cell space =
// period 1 in p). Returns clamp(minDistSq, 0, 1).
function worley(px, py, pz, cellCount) {
  const cx = px * cellCount, cy = py * cellCount, cz = pz * cellCount;
  const fcx = Math.floor(cx), fcy = Math.floor(cy), fcz = Math.floor(cz);
  let d = 1e10;
  for (let x = -1; x <= 1; ++x)
    for (let y = -1; y <= 1; ++y)
      for (let z = -1; z <= 1; ++z) {
        const tix = fcx + x, tiy = fcy + y, tiz = fcz + z;
        // BUG FIX (2026-07-23): the jitter was ONE SCALAR applied to all three
        // axes — `dx=cx-tix-jn, dy=cy-tiy-jn, dz=cz-tiz-jn` — which pinned every
        // feature point to its cell's (1,1,1) DIAGONAL instead of scattering it
        // in 3D. (valueNoise is called on integer lattice coords here, so it
        // reduced to a single hash per cell.) The reference uses a vec3 random
        // offset per cell. Three INDEPENDENT offsets, still a pure function of
        // the WRAPPED cell index so tileability is preserved.
        const wcx = glslMod(tix, cellCount),
          wcy = glslMod(tiy, cellCount),
          wcz = glslMod(tiz, cellCount);
        const cellId = wcx + wcy * 57 + 113 * wcz;
        const jx = hash(cellId);
        const jy = hash(cellId + 37.719);
        const jz = hash(cellId + 91.313);
        const dx = cx - tix - jx, dy = cy - tiy - jy, dz = cz - tiz - jz;
        const dd = dx * dx + dy * dy + dz * dz;
        if (dd < d) d = dd;
      }
  return clamp01(d);
}

// ── perlin.glsl: GLM classic periodic Perlin (4D, used 3D with w=0) ──────────
// vec4 helpers (arrays [x,y,z,w]).
const v4 = (a, b, c, d) => [a, b, c, d];
const v4map = (v, f) => [f(v[0]), f(v[1]), f(v[2]), f(v[3])];
const v4add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
const v4sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
const v4mul = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3]];
const v4muls = (a, s) => [a[0] * s, a[1] * s, a[2] * s, a[3] * s];
const v4adds = (a, s) => [a[0] + s, a[1] + s, a[2] + s, a[3] + s];
const v4dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const mod289v = (x) => v4map(x, (v) => v - Math.floor(v * (1 / 289)) * 289);
const permute = (v) => mod289v(v4mul(v4adds(v4muls(v, 34), 1), v)); // ((v*34+1)*v)%289
const taylorInvSqrt = (r) => v4map(r, (v) => 1.79284291400159 - 0.85373472095314 * v);
const fadeV = (v) => v4map(v, (t) => t * t * t * (t * (t * 6 - 15) + 10));

// classic periodic Perlin; position/rep are [x,y,z,w]
function perlin4(position, rep) {
  const Pi0 = v4map(position, (v, i) => 0); // placeholder, fill below
  for (let i = 0; i < 4; i++) Pi0[i] = glslMod(Math.floor(position[i]), rep[i]);
  const Pi1 = [
    glslMod(Pi0[0] + 1, rep[0]),
    glslMod(Pi0[1] + 1, rep[1]),
    glslMod(Pi0[2] + 1, rep[2]),
    glslMod(Pi0[3] + 1, rep[3]),
  ];
  const Pf0 = v4map(position, fract);
  const Pf1 = v4adds(Pf0, -1);
  const ix = v4(Pi0[0], Pi1[0], Pi0[0], Pi1[0]);
  const iy = v4(Pi0[1], Pi0[1], Pi1[1], Pi1[1]);
  const iz0 = v4(Pi0[2], Pi0[2], Pi0[2], Pi0[2]);
  const iz1 = v4(Pi1[2], Pi1[2], Pi1[2], Pi1[2]);
  const iw0 = v4(Pi0[3], Pi0[3], Pi0[3], Pi0[3]);
  const iw1 = v4(Pi1[3], Pi1[3], Pi1[3], Pi1[3]);

  const ixy = permute(v4add(permute(ix), iy));
  const ixy0 = permute(v4add(ixy, iz0));
  const ixy1 = permute(v4add(ixy, iz1));
  const ixy00 = permute(v4add(ixy0, iw0));
  const ixy01 = permute(v4add(ixy0, iw1));
  const ixy10 = permute(v4add(ixy1, iw0));
  const ixy11 = permute(v4add(ixy1, iw1));

  // gradient extraction (repeated 4×) — returns [gx,gy,gz,gw] each vec4
  function grads(ixyN) {
    let gx = v4muls(ixyN, 1 / 7);
    let gy = v4muls(v4map(gx, Math.floor), 1 / 7);
    let gz = v4muls(v4map(gy, Math.floor), 1 / 6);
    gx = v4adds(v4map(gx, fract), -0.5);
    gy = v4adds(v4map(gy, fract), -0.5);
    gz = v4adds(v4map(gz, fract), -0.5);
    const gw = v4sub(
      v4sub(v4sub(v4(0.75, 0.75, 0.75, 0.75), v4map(gx, Math.abs)), v4map(gy, Math.abs)),
      v4map(gz, Math.abs),
    );
    const sw = v4map(gw, (v) => step(v, 0));
    gx = v4sub(gx, v4mul(sw, v4map(gx, (v) => step(0, v) - 0.5)));
    gy = v4sub(gy, v4mul(sw, v4map(gy, (v) => step(0, v) - 0.5)));
    return [gx, gy, gz, gw];
  }
  const [gx00, gy00, gz00, gw00] = grads(ixy00);
  const [gx01, gy01, gz01, gw01] = grads(ixy01);
  const [gx10, gy10, gz10, gw10] = grads(ixy10);
  const [gx11, gy11, gz11, gw11] = grads(ixy11);

  // assemble 16 gradient vec4s (component c of each lane)
  const G = (gx, gy, gz, gw, c) => [gx[c], gy[c], gz[c], gw[c]];
  let g0000 = G(gx00, gy00, gz00, gw00, 0);
  let g1000 = G(gx00, gy00, gz00, gw00, 1);
  let g0100 = G(gx00, gy00, gz00, gw00, 2);
  let g1100 = G(gx00, gy00, gz00, gw00, 3);
  let g0010 = G(gx10, gy10, gz10, gw10, 0);
  let g1010 = G(gx10, gy10, gz10, gw10, 1);
  let g0110 = G(gx10, gy10, gz10, gw10, 2);
  let g1110 = G(gx10, gy10, gz10, gw10, 3);
  let g0001 = G(gx01, gy01, gz01, gw01, 0);
  let g1001 = G(gx01, gy01, gz01, gw01, 1);
  let g0101 = G(gx01, gy01, gz01, gw01, 2);
  let g1101 = G(gx01, gy01, gz01, gw01, 3);
  let g0011 = G(gx11, gy11, gz11, gw11, 0);
  let g1011 = G(gx11, gy11, gz11, gw11, 1);
  let g0111 = G(gx11, gy11, gz11, gw11, 2);
  let g1111 = G(gx11, gy11, gz11, gw11, 3);

  const norm00 = taylorInvSqrt(v4(v4dot(g0000, g0000), v4dot(g0100, g0100), v4dot(g1000, g1000), v4dot(g1100, g1100)));
  g0000 = v4muls(g0000, norm00[0]); g0100 = v4muls(g0100, norm00[1]); g1000 = v4muls(g1000, norm00[2]); g1100 = v4muls(g1100, norm00[3]);
  const norm01 = taylorInvSqrt(v4(v4dot(g0001, g0001), v4dot(g0101, g0101), v4dot(g1001, g1001), v4dot(g1101, g1101)));
  g0001 = v4muls(g0001, norm01[0]); g0101 = v4muls(g0101, norm01[1]); g1001 = v4muls(g1001, norm01[2]); g1101 = v4muls(g1101, norm01[3]);
  const norm10 = taylorInvSqrt(v4(v4dot(g0010, g0010), v4dot(g0110, g0110), v4dot(g1010, g1010), v4dot(g1110, g1110)));
  g0010 = v4muls(g0010, norm10[0]); g0110 = v4muls(g0110, norm10[1]); g1010 = v4muls(g1010, norm10[2]); g1110 = v4muls(g1110, norm10[3]);
  const norm11 = taylorInvSqrt(v4(v4dot(g0011, g0011), v4dot(g0111, g0111), v4dot(g1011, g1011), v4dot(g1111, g1111)));
  g0011 = v4muls(g0011, norm11[0]); g0111 = v4muls(g0111, norm11[1]); g1011 = v4muls(g1011, norm11[2]); g1111 = v4muls(g1111, norm11[3]);

  const P = (a, b, c, d) => [a, b, c, d];
  const n0000 = v4dot(g0000, Pf0);
  const n1000 = v4dot(g1000, P(Pf1[0], Pf0[1], Pf0[2], Pf0[3]));
  const n0100 = v4dot(g0100, P(Pf0[0], Pf1[1], Pf0[2], Pf0[3]));
  const n1100 = v4dot(g1100, P(Pf1[0], Pf1[1], Pf0[2], Pf0[3]));
  const n0010 = v4dot(g0010, P(Pf0[0], Pf0[1], Pf1[2], Pf0[3]));
  const n1010 = v4dot(g1010, P(Pf1[0], Pf0[1], Pf1[2], Pf0[3]));
  const n0110 = v4dot(g0110, P(Pf0[0], Pf1[1], Pf1[2], Pf0[3]));
  const n1110 = v4dot(g1110, P(Pf1[0], Pf1[1], Pf1[2], Pf0[3]));
  const n0001 = v4dot(g0001, P(Pf0[0], Pf0[1], Pf0[2], Pf1[3]));
  const n1001 = v4dot(g1001, P(Pf1[0], Pf0[1], Pf0[2], Pf1[3]));
  const n0101 = v4dot(g0101, P(Pf0[0], Pf1[1], Pf0[2], Pf1[3]));
  const n1101 = v4dot(g1101, P(Pf1[0], Pf1[1], Pf0[2], Pf1[3]));
  const n0011 = v4dot(g0011, P(Pf0[0], Pf0[1], Pf1[2], Pf1[3]));
  const n1011 = v4dot(g1011, P(Pf1[0], Pf0[1], Pf1[2], Pf1[3]));
  const n0111 = v4dot(g0111, P(Pf0[0], Pf1[1], Pf1[2], Pf1[3]));
  const n1111 = v4dot(g1111, Pf1);

  const fx = fadeV(Pf0);
  const n_0w = [mix(n0000, n0001, fx[3]), mix(n1000, n1001, fx[3]), mix(n0100, n0101, fx[3]), mix(n1100, n1101, fx[3])];
  const n_1w = [mix(n0010, n0011, fx[3]), mix(n1010, n1011, fx[3]), mix(n0110, n0111, fx[3]), mix(n1110, n1111, fx[3])];
  const n_zw = [mix(n_0w[0], n_1w[0], fx[2]), mix(n_0w[1], n_1w[1], fx[2]), mix(n_0w[2], n_1w[2], fx[2]), mix(n_0w[3], n_1w[3], fx[2])];
  const n_yzw = [mix(n_zw[0], n_zw[2], fx[1]), mix(n_zw[1], n_zw[3], fx[1])];
  const n_xyzw = mix(n_yzw[0], n_yzw[1], fx[0]);
  return 2.2 * n_xyzw;
}

// getPerlinNoise FBM (octaves, roughness 0.5, freq ×2 per octave)
function perlinFbm(px, py, pz, frequency, octaveCount) {
  let sum = 0, weightSum = 0, weight = 1, f = frequency;
  for (let i = 0; i < octaveCount; ++i) {
    sum += perlin4([px * f, py * f, pz * f, 0], [f, f, f, 1]) * weight;
    weightSum += weight;
    weight *= 0.5;
    f *= 2;
  }
  return sum / weightSum;
}

// ── cloudShape.frag: base Perlin-Worley 128^3 ───────────────────────────────
function getPerlinWorley(px, py, pz) {
  const perlin = clamp01(perlinFbm(px, py, pz, 8, 3));
  const cc = 4;
  const w1 = 1 - worley(px, py, pz, cc * 2);
  const w2 = 1 - worley(px, py, pz, cc * 8);
  const w3 = 1 - worley(px, py, pz, cc * 14);
  const fbm = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
  return remap(perlin, 0, 1, fbm, 1);
}
function getWorleyFbmShape(px, py, pz) {
  const cc = 4;
  const n0 = 1 - worley(px, py, pz, cc * 2);
  const n1 = 1 - worley(px, py, pz, cc * 4);
  const n2 = 1 - worley(px, py, pz, cc * 8);
  const n3 = 1 - worley(px, py, pz, cc * 16);
  const f0 = n0 * 0.625 + n1 * 0.25 + n2 * 0.125;
  const f1 = n1 * 0.625 + n2 * 0.25 + n3 * 0.125;
  const f2 = n2 * 0.75 + n3 * 0.25;
  return f0 * 0.625 + f1 * 0.25 + f2 * 0.125;
}
function shapeValue(px, py, pz) {
  const pw = getPerlinWorley(px, py, pz);
  const wf = getWorleyFbmShape(px, py, pz);
  return remap(pw, wf - 1, 1, 0, 1); // remap(pw, wf-1, 1) → [0,1]
}

// ── cloudShapeDetail.frag: Worley-FBM 32^3 ──────────────────────────────────
function detailValue(px, py, pz) {
  const cc = 2;
  const n0 = 1 - worley(px, py, pz, cc * 1);
  const n1 = 1 - worley(px, py, pz, cc * 2);
  const n2 = 1 - worley(px, py, pz, cc * 4);
  const n3 = 1 - worley(px, py, pz, cc * 8);
  const f0 = n0 * 0.625 + n1 * 0.25 + n2 * 0.125;
  const f1 = n1 * 0.625 + n2 * 0.25 + n3 * 0.125;
  const f2 = n2 * 0.75 + n3 * 0.25;
  return f0 * 0.625 + f1 * 0.25 + f2 * 0.125;
}

// ── bake ────────────────────────────────────────────────────────────────────
function bake(size, fn, label) {
  const out = new Uint8Array(size * size * size);
  let mn = 1e9, mx = -1e9, sum = 0;
  const t0 = Date.now();
  for (let z = 0; z < size; ++z) {
    for (let y = 0; y < size; ++y) {
      for (let x = 0; x < size; ++x) {
        const v = fn((x + 0.5) / size, (y + 0.5) / size, (z + 0.5) / size);
        const c = clamp01(v);
        out[x + y * size + z * size * size] = Math.round(c * 255);
        if (c < mn) mn = c;
        if (c > mx) mx = c;
        sum += c;
      }
    }
    if (z % 16 === 0) process.stdout.write(`  ${label} z=${z}/${size}\r`);
  }
  const mean = sum / out.length;
  console.log(`\n  ${label}: mean ${mean.toFixed(3)} min ${mn.toFixed(3)} max ${mx.toFixed(3)}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return out;
}

// tileability check: max |edge - opposite-edge| along x (should be small)
function tileError(vol, size) {
  let maxd = 0;
  for (let z = 0; z < size; z += 8)
    for (let y = 0; y < size; y += 8) {
      const a = vol[0 + y * size + z * size * size];
      const b = vol[size - 1 + y * size + z * size * size];
      maxd = Math.max(maxd, Math.abs(a - b));
    }
  return maxd; // in 0-255 units; wrap is exact only if periodic, expect smallish
}

function writeSlice(vol, size, path) {
  const z = size >> 1;
  const slice = new Uint8Array(size * size);
  for (let y = 0; y < size; ++y)
    for (let x = 0; x < size; ++x) slice[x + y * size] = vol[x + y * size + z * size * size];
  writeFileSync(path, slice);
}

const OUT_DIR = "public/textures/clouds";
mkdirSync(OUT_DIR, { recursive: true });

console.log("baking takram shape (128^3 Perlin-Worley)...");
const shape = bake(SHAPE_SIZE, shapeValue, "shape");
writeFileSync(`${OUT_DIR}/takram_shape.bin`, Buffer.from(shape.buffer));
writeSlice(shape, SHAPE_SIZE, "/private/tmp/claude-502/-Users-privat-Code-stellar-nomad/34d3ce7d-6e8b-44e5-9451-45081f693f03/scratchpad/takram_shape_slice.raw");
console.log(`  tile |Δedge| x: ${tileError(shape, SHAPE_SIZE)}/255`);

console.log("baking takram detail (32^3 Worley-FBM)...");
const detail = bake(DETAIL_SIZE, detailValue, "detail");
writeFileSync(`${OUT_DIR}/takram_shape_detail.bin`, Buffer.from(detail.buffer));
writeSlice(detail, DETAIL_SIZE, "/private/tmp/claude-502/-Users-privat-Code-stellar-nomad/34d3ce7d-6e8b-44e5-9451-45081f693f03/scratchpad/takram_detail_slice.raw");
console.log(`  tile |Δedge| x: ${tileError(detail, DETAIL_SIZE)}/255`);

console.log(`\nwrote ${OUT_DIR}/takram_shape.bin (${shape.length} B) + takram_shape_detail.bin (${detail.length} B)`);
