import * as THREE from "three";
import { BASE_ERODE, BASE_FBM_BILLOW, BASE_FBM_BIAS } from "./cloudDetile";

// =============================================================================
// Nubis-style noise volumes for the volumetric cloud shell.
//
// Base volume (128³ RGBA8):
//   R: Low-freq Perlin-Worley hybrid (Schneider's "perlin-worley" R channel).
//      `perlinWorley = worley + perlin × (1 - worley)` — i.e. Schneider's
//      remap(perlin, 0, 1, worley, 1): pinned to 1 at Worley feature points
//      (billowy "puff" cores), falling to `perlin` in the gaps (smooth
//      gradient fill, no hard cell boundaries). The result has the
//      cumulus-cauliflower character that pure Perlin (smooth blobs) and
//      pure Worley (sharp cells) each lack on their own.
//      Earlier this slot was pure Perlin to avoid "honeycomb" artifacts at
//      close range; in practice with this hybrid and G_LOW=4 (large cells),
//      no honeycomb appears — the cells read as cloud bodies, not as a
//      regular pattern.
//   G: Worley FBM at low/mid/high octaves [grid 4, 8, 16].   Low-freq band.
//   B: Worley FBM at mid/high/v.high octaves [grid 8, 16, 32]. Mid-freq band.
//   A: Worley FBM at high/v.high/detail octaves [grid 16, 32, 48]. High-freq band.
//
// In the shader, GBA are weighted (0.625, 0.25, 0.125) into a single FBM which
// is fed into Schneider's `remap` to dilate/erode the Perlin-Worley R channel.
// See `earthClouds.ts`.
//
// Detail volume (64³ RGBA8 — A unused, padded to 1.0):
//   R/G/B: Three Worley octaves at progressively higher freq [grid 4, 8, 16],
//          sampled separately for shader-side FBM. Used to erode cloud edges
//          and (R/G at CARVE_SCALE) as the macro billow-carve source.
//          64³ (was 32³): at 32³ the grid-16 octave had only 2 voxels per
//          Worley cell — aliased mush instead of crisp cells. 64³ gives
//          16/8/4 voxels per cell — every octave resolves, which is what the
//          close-range cauliflower carving needs. Memory: 1 MB (was 128 KB).
//
// Both volumes are tileable via wrap-around feature-point lookup. WebGPU does
// not support `RGBFormat`, so the detail volume is RGBA with a constant alpha;
// the +25% memory cost is negligible (32 KB).
//
// Reference: Schneider 2015, "Real-Time Volumetric Cloudscapes of Horizon Zero
// Dawn" (GPU Pro 7 / SIGGRAPH 2015 Advances in Real-Time Rendering).
// =============================================================================

const BASE_SIZE = 128;
const DETAIL_SIZE = 64;

// Base-volume Worley grids. Each "grid" is the number of feature-point cells
// per axis. 128 / grid = cell size in voxels. Smaller grid = bigger puffs.
const G_LOW = 4;     // ~32 voxels per cell — macro shape
const G_MID = 8;
const G_HIGH = 16;
const G_VHIGH = 32;
const G_FINE = 48;   // ~2.7 voxels per cell — finest detail in base

// Detail-volume Worley grids.
const DG_LOW = 4;
const DG_MID = 8;
const DG_HIGH = 16;

// Salt offsets so feature points across grids are decorrelated.
const SALT_W4 = 1;
const SALT_W8 = 2;
const SALT_W16 = 3;
const SALT_W32 = 4;
const SALT_W48 = 5;
const SALT_PERLIN = 9999;
const SALT_DW4 = 11;
const SALT_DW8 = 12;
const SALT_DW16 = 13;

// =============================================================================
// EXPERIMENT (2026-06-15): crease-preserving combine — "Alligator direction" test.
//
// Hypothesis (per VOLUMETRIC_CLOUDS_SHAPE_PLAN §Phase B findings + Nubis³ p.98):
// our "elongated/stringy" billows are the isosurface of ADDITIVE inverted-Worley
// FBM. Inverted Worley has BROAD smooth saddles between feature points; summing
// octaves fills them further. Thresholding that field where blobs touch keeps the
// broad saddles as long NECKS → strings. Real cauliflower = round bumps separated
// by NARROW DEEP creases. Schneider hit this exact wall ("packed spheres") and
// fixed it by switching the noise generator (inverted Worley → Houdini Alligator).
//
// This is the CHEAP falsification test before committing to a full Alligator port:
// deepen the creases of our existing Worley with a single exponent and see whether
// billows round out / crevices sharpen.
//   crease(v) = pow(v, k) · (k+1)/2      (mean-preserving for v~U[0,1]; k=1 ⇒ no-op)
// pow(v,k>1) pushes saddle (low) values down hard while caps clamp to 1 → round
// caps + deep narrow creases. The (k+1)/2 gain keeps the mean ≈ unchanged so
// coverage/density barely shift and SHAPE is the isolated variable (mean of v^k
// over U[0,1] is 1/(k+1); ×(k+1)/2 restores it to 1/2). Applied to the billow
// Worley everywhere it feeds the LIT shape: base R Worley, base FBM bands (G/B/A),
// and the detail channels (R/G/B) that drive the macro carve.
//
// k = 1.0 is an EXACT identity (committing this is visually neutral). Try k≈2–3
// live: REQUIRES A PAGE RELOAD (the volume is baked once at startup, not a shader
// constant). If billows round out → confirms the saddle hypothesis → build real
// Alligator noise. If still stringy → necking is deeper than crease depth; stop
// and re-diagnose before any rewrite.
// =============================================================================
const BILLOW_CREASE_POWER = 1.0;

function crease(v: number): number {
  const k = BILLOW_CREASE_POWER;
  if (k === 1) return v; // exact identity — zero-cost default
  const c = Math.pow(v < 0 ? 0 : v, k) * ((k + 1) * 0.5);
  return c < 0 ? 0 : c > 1 ? 1 : c;
}

// PRNG — same Mulberry32 the previous Worley generator used.
function seededRandom(seed: number): number {
  let s = (seed | 0) + 0x6d2b79f5;
  s = Math.imul(s ^ (s >>> 15), s | 1);
  s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
  return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
}

function hash3(x: number, y: number, z: number, salt: number): number {
  return seededRandom(
    ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) + salt * 1597334677,
  );
}

// =============================================================================
// Worley
// =============================================================================

type WorleyGrid = {
  fx: Float32Array;
  fy: Float32Array;
  fz: Float32Array;
  grid: number;
};

function seedWorleyGrid(grid: number, salt: number): WorleyGrid {
  const fx = new Float32Array(grid * grid * grid);
  const fy = new Float32Array(grid * grid * grid);
  const fz = new Float32Array(grid * grid * grid);
  for (let z = 0; z < grid; z++) {
    for (let y = 0; y < grid; y++) {
      for (let x = 0; x < grid; x++) {
        const idx = (z * grid + y) * grid + x;
        fx[idx] = x + hash3(x, y, z, salt);
        fy[idx] = y + hash3(x + 1, y + 3, z + 7, salt);
        fz[idx] = z + hash3(x + 2, y + 5, z + 11, salt);
      }
    }
  }
  return { fx, fy, fz, grid };
}

// ── Alligator-style noise (2026-06-18 — the "packed spheres" fix) ──
// Inverted Worley uses a LINEAR falloff from the nearest feature point → cones
// with BROAD saddles between cells → round balls with WIDE gaps ("packed
// spheres", the wall Schneider documents). Houdini Alligator noise (round caps,
// NARROW creases) is proprietary, but its CHARACTER is reproduced by a
// metaball: the MAX over feature points of a smooth round cap. Round-topped
// caps that just overlap meet at thin valleys → narrow creases; near a point
// the cap is flat (round bump). USE_ALLIGATOR swaps worleySample's mapping from
// inverted-cone to metaball-max. Re-bake (reload) to apply.
//   ALLIGATOR_RADIUS: cap radius in CELL units. Points sit ~1 cell apart, so
//     < ~0.7 leaves flat-zero gaps (wide creases again); > ~1.2 merges caps
//     (no creases). ~0.9 → caps that just overlap → round bumps, narrow creases.
const USE_ALLIGATOR = true;
const ALLIGATOR_RADIUS = 0.9;

// Sample Worley at (px,py,pz) given in cell-space (i.e. caller has
// pre-multiplied by `grid / volSize`). Returns ~[0, 1] where 1 = at feature
// point. USE_ALLIGATOR=false → classic inverted Worley (cone, broad saddle);
// true → metaball max-of-caps (round bump, narrow crease).
function worleySample(
  px: number,
  py: number,
  pz: number,
  w: WorleyGrid,
): number {
  const grid = w.grid;
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  const cz = Math.floor(pz);
  let minD2 = 1e9;
  let maxCap = 0;
  for (let dz = -1; dz <= 1; dz++) {
    const nz = cz + dz;
    // Cheap one-shot wrap (|dz| ≤ 1 means we never need full modulo).
    const wz = nz < 0 ? nz + grid : nz >= grid ? nz - grid : nz;
    const offZ = nz - wz;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = cy + dy;
      const wy = ny < 0 ? ny + grid : ny >= grid ? ny - grid : ny;
      const offY = ny - wy;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        const wx = nx < 0 ? nx + grid : nx >= grid ? nx - grid : nx;
        const offX = nx - wx;
        const fIdx = (wz * grid + wy) * grid + wx;
        const ddx = px - (w.fx[fIdx] + offX);
        const ddy = py - (w.fy[fIdx] + offY);
        const ddz = pz - (w.fz[fIdx] + offZ);
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d2 < minD2) minD2 = d2;
        if (USE_ALLIGATOR) {
          // Smooth round cap (smoothstep): 1 at the point → 0 at the radius.
          const t = Math.sqrt(d2) / ALLIGATOR_RADIUS;
          if (t < 1) {
            const cap = 1 - (3 * t * t - 2 * t * t * t);
            if (cap > maxCap) maxCap = cap;
          }
        }
      }
    }
  }
  if (USE_ALLIGATOR) return maxCap;
  // Half cell-diagonal as the "max" for normalization. Empirical Worley
  // distributions clamp well below 1 so we'll rarely hit the floor.
  const v = 1 - Math.sqrt(minD2) / (Math.sqrt(3) * 0.5);
  return v < 0 ? 0 : v;
}

// 3-octave Worley FBM with Schneider weighting (0.625, 0.25, 0.125).
// Each grid is sampled at its own scale relative to the volume size.
function worleyFbm(
  px: number,
  py: number,
  pz: number,
  volSize: number,
  o0: WorleyGrid,
  o1: WorleyGrid,
  o2: WorleyGrid,
): number {
  const s0 = o0.grid / volSize;
  const s1 = o1.grid / volSize;
  const s2 = o2.grid / volSize;
  return (
    worleySample(px * s0, py * s0, pz * s0, o0) * 0.625 +
    worleySample(px * s1, py * s1, pz * s1, o1) * 0.25 +
    worleySample(px * s2, py * s2, pz * s2, o2) * 0.125
  );
}

// =============================================================================
// Perlin (tileable, gradient noise)
// =============================================================================

// 12 unit-cube edge midpoints — Ken Perlin's improved noise gradients.
// Constant table avoids per-sample allocation.
const PG_X = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0];
const PG_Y = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1];
const PG_Z = [0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1];

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function gradHash(
  x: number,
  y: number,
  z: number,
  grid: number,
  salt: number = SALT_PERLIN,
): number {
  const wx = x < 0 ? x + grid : x >= grid ? x - grid : x;
  const wy = y < 0 ? y + grid : y >= grid ? y - grid : y;
  const wz = z < 0 ? z + grid : z >= grid ? z - grid : z;
  return Math.floor(hash3(wx, wy, wz, salt) * 12) % 12;
}

function dotGrad(g: number, dx: number, dy: number, dz: number): number {
  return PG_X[g] * dx + PG_Y[g] * dy + PG_Z[g] * dz;
}

// Tileable Perlin in a `grid`-sized lattice. Caller pre-multiplies world coords
// by `grid / volSize`. Returns [0, 1] (raw Perlin is [-1, 1]; we centre on 0.5).
function perlinSample(
  px: number,
  py: number,
  pz: number,
  grid: number,
  salt: number = SALT_PERLIN,
): number {
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  const cz = Math.floor(pz);
  const dx = px - cx;
  const dy = py - cy;
  const dz = pz - cz;
  const fx = fade(dx);
  const fy = fade(dy);
  const fz = fade(dz);

  const g000 = dotGrad(gradHash(cx, cy, cz, grid, salt), dx, dy, dz);
  const g100 = dotGrad(gradHash(cx + 1, cy, cz, grid, salt), dx - 1, dy, dz);
  const g010 = dotGrad(gradHash(cx, cy + 1, cz, grid, salt), dx, dy - 1, dz);
  const g110 = dotGrad(
    gradHash(cx + 1, cy + 1, cz, grid, salt),
    dx - 1,
    dy - 1,
    dz,
  );
  const g001 = dotGrad(gradHash(cx, cy, cz + 1, grid, salt), dx, dy, dz - 1);
  const g101 = dotGrad(
    gradHash(cx + 1, cy, cz + 1, grid, salt),
    dx - 1,
    dy,
    dz - 1,
  );
  const g011 = dotGrad(
    gradHash(cx, cy + 1, cz + 1, grid, salt),
    dx,
    dy - 1,
    dz - 1,
  );
  const g111 = dotGrad(
    gradHash(cx + 1, cy + 1, cz + 1, grid, salt),
    dx - 1,
    dy - 1,
    dz - 1,
  );

  const lx00 = g000 + fx * (g100 - g000);
  const lx10 = g010 + fx * (g110 - g010);
  const lx01 = g001 + fx * (g101 - g001);
  const lx11 = g011 + fx * (g111 - g011);
  const ly0 = lx00 + fy * (lx10 - lx00);
  const ly1 = lx01 + fy * (lx11 - lx01);
  const v = ly0 + fz * (ly1 - ly0);
  return v * 0.5 + 0.5;
}

// =============================================================================
// Curl-noise distortion for WISPY detail (Nubis "Curly-Alligator", 2026-06-18).
//
// Nubis builds wisps from INVERTED Alligator noise (web-like shapes) DISTORTED
// BY CURL NOISE → swept, curly strands. The curl of a 3-component Perlin vector
// potential is divergence-free, so it warps the web without clumping/tearing
// (Bridson 2007). We bake this into the detail volume's previously-unused A
// channel; the shader blends billowy↔wispy by edge/density (wisps where density
// decreases = edges, per Nubis "Decreasing Density = Curly Layered Wisps").
// =============================================================================
const WISP_GRID = 8; // inverted-Alligator base freq for the wisp web
const CURL_GRID = 8; // Perlin potential freq (lower = broader swirls)
const CURL_AMP = 2.1; // curl distortion strength (wisp-cell units)
const SALT_WISP = 41;
const SALT_CURL_A = 42;
const SALT_CURL_B = 43;
const SALT_CURL_C = 44;

// Curl ∇×ψ of a Perlin vector potential ψ=(A,B,C), evaluated in WISP-cell space
// (px,py,pz already in WISP_GRID cells). The potential is sampled at the lower
// CURL_GRID freq so the swirls are broad relative to the wisp web. Central
// finite differences (step h in wisp-cell units). Returns an offset vector.
function curlNoise(
  px: number,
  py: number,
  pz: number,
): { x: number; y: number; z: number } {
  const r = CURL_GRID / WISP_GRID; // wisp-cell → curl-cell space
  const h = 0.5;
  const inv = 1 / (2 * h);
  const psi = (a: number, b: number, c: number, salt: number): number =>
    perlinSample(a * r, b * r, c * r, CURL_GRID, salt);
  const dCdy =
    (psi(px, py + h, pz, SALT_CURL_C) - psi(px, py - h, pz, SALT_CURL_C)) * inv;
  const dBdz =
    (psi(px, py, pz + h, SALT_CURL_B) - psi(px, py, pz - h, SALT_CURL_B)) * inv;
  const dAdz =
    (psi(px, py, pz + h, SALT_CURL_A) - psi(px, py, pz - h, SALT_CURL_A)) * inv;
  const dCdx =
    (psi(px + h, py, pz, SALT_CURL_C) - psi(px - h, py, pz, SALT_CURL_C)) * inv;
  const dBdx =
    (psi(px + h, py, pz, SALT_CURL_B) - psi(px - h, py, pz, SALT_CURL_B)) * inv;
  const dAdy =
    (psi(px, py + h, pz, SALT_CURL_A) - psi(px, py - h, pz, SALT_CURL_A)) * inv;
  return { x: dCdy - dBdz, y: dAdz - dCdx, z: dBdx - dAdy };
}

// =============================================================================
// Volume generation
// =============================================================================

function generateBaseVolume(): Uint8Array {
  const w4 = seedWorleyGrid(G_LOW, SALT_W4);
  const w8 = seedWorleyGrid(G_MID, SALT_W8);
  const w16 = seedWorleyGrid(G_HIGH, SALT_W16);
  const w32 = seedWorleyGrid(G_VHIGH, SALT_W32);
  const w48 = seedWorleyGrid(G_FINE, SALT_W48);

  const data = new Uint8Array(BASE_SIZE * BASE_SIZE * BASE_SIZE * 4);
  const sPerlin = G_LOW / BASE_SIZE;
  const sWorleyR = G_LOW / BASE_SIZE; // R-channel Worley matches Perlin scale

  let idx = 0;
  for (let z = 0; z < BASE_SIZE; z++) {
    for (let y = 0; y < BASE_SIZE; y++) {
      for (let x = 0; x < BASE_SIZE; x++) {
        // R: Perlin-Worley hybrid. Schneider's standard recipe is
        //   perlinWorley = remap(perlin, 0, 1, worley, 1)
        //                = worley + perlin × (1 - worley)
        // where `worley` is inverted (1 at feature point, 0 at boundary).
        // This pins R to 1 at Worley feature points (giving bright
        // cumulus puff centres) and falls to `perlin` in the gaps
        // between cells (smooth gradient fill, no hard cell boundaries).
        //
        // Mean value ≈ 0.75 (vs ~0.5 for pure Perlin), so after the
        // shader's `remap(R, -(1-fbm), 1, 0, 1)` dilation the baseCloud
        // density is meaningfully higher → cumulus bodies actually
        // saturate to opaque alpha in the marcher.
        //
        // Pure Perlin (previous slot contents) gave smooth dunes/hills
        // with iso-altitude contour bands visible inside the body,
        // because nothing in the 3D structure broke up altitude as the
        // dominant variable.
        const perlin = perlinSample(
          x * sPerlin,
          y * sPerlin,
          z * sPerlin,
          G_LOW,
        );
        const worleyR = crease(
          worleySample(x * sWorleyR, y * sWorleyR, z * sWorleyR, w4),
        );
        const perlinWorley = worleyR + perlin * (1 - worleyR);

        // GBA: three FBM bands at progressively higher base frequencies.
        // Each band overlaps the next by two octaves so the shader can blend.
        const fbmG = crease(worleyFbm(x, y, z, BASE_SIZE, w4, w8, w16));
        const fbmB = crease(worleyFbm(x, y, z, BASE_SIZE, w8, w16, w32));
        const fbmA = crease(worleyFbm(x, y, z, BASE_SIZE, w16, w32, w48));

        // Quantize 0..1 → 0..255 with clamp (overflow paranoia for the FBM
        // sums, which can exceed 1 if a sample hits exactly at a feature
        // point on every octave).
        data[idx++] =
          perlinWorley < 0
            ? 0
            : perlinWorley > 1
            ? 255
            : (perlinWorley * 255) | 0;
        data[idx++] = fbmG < 0 ? 0 : fbmG > 1 ? 255 : (fbmG * 255) | 0;
        data[idx++] = fbmB < 0 ? 0 : fbmB > 1 ? 255 : (fbmB * 255) | 0;
        data[idx++] = fbmA < 0 ? 0 : fbmA > 1 ? 255 : (fbmA * 255) | 0;
      }
    }
  }
  logBaseDistribution(data);
  return data;
}

// DEBUG (2026-06-16, floater / smooth-blob root-cause probe): histogram the
// base-shape value distribution from the QUANTIZED texture (what the shader
// actually samples). Logs the raw Perlin-Worley channel (R) AND the dilated
// base `(R + (1-fbm))/(2-fbm)` the value-erosion sees. A saturated base reads
// as a high mean + a large "%>=0.95" + a histogram piled at the top bin → the
// erosion has nothing to carve and pinned-to-1 peaks become floaters. After a
// de-saturation pass the histogram should spread toward a centred distribution.
function logBaseDistribution(data: Uint8Array): void {
  const N = data.length / 4;
  const histR = new Array(10).fill(0);
  const histD = new Array(10).fill(0);
  let sumR = 0;
  let sumD = 0;
  let satR = 0;
  let satD = 0;
  let minD = 1;
  let maxD = 0;
  for (let i = 0; i < N; i++) {
    const R = data[i * 4] / 255;
    const g = data[i * 4 + 1] / 255;
    const b = data[i * 4 + 2] / 255;
    const a = data[i * 4 + 3] / 255;
    const fbm = g * 0.625 + b * 0.25 + a * 0.125;
    // Mirror of cloudDetile.ts baseDilate: erode term + centered mid FBM billow.
    const dil = Math.max(
      0,
      Math.min(1, R - fbm * BASE_ERODE + (fbm - BASE_FBM_BIAS) * BASE_FBM_BILLOW),
    );
    sumR += R;
    sumD += dil;
    if (R >= 0.95) satR++;
    if (dil >= 0.95) satD++;
    if (dil < minD) minD = dil;
    if (dil > maxD) maxD = dil;
    histR[Math.min(9, (R * 10) | 0)]++;
    histD[Math.min(9, (dil * 10) | 0)]++;
  }
  const pct = (x: number): string => ((100 * x) / N).toFixed(1);
  const bars = (h: number[]): string =>
    h.map((c) => pct(c).padStart(5)).join(" ");
  console.log(
    `[cloud base dist] N=${N}  bins = value 0.0..1.0 in 10% steps (% of voxels)\n` +
      `  perlinWorley(R): mean=${(sumR / N).toFixed(3)}  >=0.95: ${pct(satR)}%\n` +
      `    ${bars(histR)}\n` +
      `  dilated base:    mean=${(sumD / N).toFixed(3)}  min=${minD.toFixed(
        3,
      )} max=${maxD.toFixed(3)}  >=0.95: ${pct(satD)}%\n` +
      `    ${bars(histD)}`,
  );
}

function generateDetailVolume(): Uint8Array {
  const w4 = seedWorleyGrid(DG_LOW, SALT_DW4);
  const w8 = seedWorleyGrid(DG_MID, SALT_DW8);
  const w16 = seedWorleyGrid(DG_HIGH, SALT_DW16);
  // Wisp octave: a separate Alligator grid, INVERTED (web-like) + curl-distorted.
  const wWisp = seedWorleyGrid(WISP_GRID, SALT_WISP);

  const data = new Uint8Array(DETAIL_SIZE * DETAIL_SIZE * DETAIL_SIZE * 4);
  const sR = DG_LOW / DETAIL_SIZE;
  const sG = DG_MID / DETAIL_SIZE;
  const sB = DG_HIGH / DETAIL_SIZE;
  const sWisp = WISP_GRID / DETAIL_SIZE;

  let idx = 0;
  for (let z = 0; z < DETAIL_SIZE; z++) {
    for (let y = 0; y < DETAIL_SIZE; y++) {
      for (let x = 0; x < DETAIL_SIZE; x++) {
        // RGB = three independent Worley(→Alligator) octaves = BILLOWS. Shader
        // assembles its own FBM at runtime so each channel can be tweaked.
        const r = crease(worleySample(x * sR, y * sR, z * sR, w4));
        const g = crease(worleySample(x * sG, y * sG, z * sG, w8));
        const b = crease(worleySample(x * sB, y * sB, z * sB, w16));
        // A = WISP: inverted Alligator (web) sampled at a curl-distorted
        // position → swept curly strands. NOT creased (creasing thins the web
        // into fragments; the wisp wants a connected web). Decorrelated from the
        // billow channels via SALT_WISP.
        const wcx = x * sWisp;
        const wcy = y * sWisp;
        const wcz = z * sWisp;
        const c = curlNoise(wcx, wcy, wcz);
        const wisp =
          1 -
          worleySample(
            wcx + c.x * CURL_AMP,
            wcy + c.y * CURL_AMP,
            wcz + c.z * CURL_AMP,
            wWisp,
          );
        data[idx++] = (r * 255) | 0;
        data[idx++] = (g * 255) | 0;
        data[idx++] = (b * 255) | 0;
        data[idx++] = wisp < 0 ? 0 : wisp > 1 ? 255 : (wisp * 255) | 0;
      }
    }
  }
  logDetailDistribution(data);
  return data;
}

// DEBUG (2026-06-17, cauliflower / "edge speckle" probe): histogram the detail
// volume's three Worley octaves and the composites the shader builds from them.
// The detail noise is the EROSION source that should carve rounded cauliflower
// billows. If a channel has a high mean + narrow spread (low contrast), erosion
// can only nibble shallow → mushy edges; if the HIGH octave (B, grid-16 ≈ the
// finest, sub-march-step features) carries most of the energy, erosion reads as
// fine grain / TV static rather than coherent lumps. `crease` (BILLOW_CREASE_
// POWER) is meant to push saddles down (deeper, narrower creases → rounder
// caps): a healthy creased channel skews LOW (mean well under 0.5) with a real
// high tail. Two composites are logged: the carve mix (0.6·R+0.4·G) that feeds
// the LIT macro carve, and the Schneider FBM (0.625·R+0.25·G+0.125·B) as a
// reference weighting. Pair with DEBUG_VIZ 'eroded' (the carved shape at the
// surface) and 'detailShadow' (the near self-shadow relief).
function logDetailDistribution(data: Uint8Array): void {
  const N = data.length / 4;
  const mk = (): {
    hist: number[];
    sum: number;
    min: number;
    max: number;
  } => ({ hist: new Array(10).fill(0), sum: 0, min: 1, max: 0 });
  const acc = (s: ReturnType<typeof mk>, v: number): void => {
    s.sum += v;
    if (v < s.min) s.min = v;
    if (v > s.max) s.max = v;
    s.hist[Math.min(9, Math.max(0, (v * 10) | 0))]++;
  };
  const chR = mk();
  const chG = mk();
  const chB = mk();
  const carve = mk(); // 0.6·R + 0.4·G — feeds the LIT macro billow carve
  const fbm = mk(); // 0.625·R + 0.25·G + 0.125·B — Schneider reference FBM
  const chA = mk(); // A = curl-distorted inverted-Alligator WISP (thin web)
  for (let i = 0; i < N; i++) {
    const r = data[i * 4] / 255;
    const g = data[i * 4 + 1] / 255;
    const b = data[i * 4 + 2] / 255;
    const a = data[i * 4 + 3] / 255;
    acc(chR, r);
    acc(chG, g);
    acc(chB, b);
    acc(chA, a);
    acc(carve, r * 0.6 + g * 0.4);
    acc(fbm, r * 0.625 + g * 0.25 + b * 0.125);
  }
  const pct = (x: number): string => ((100 * x) / N).toFixed(1);
  const bars = (h: number[]): string =>
    h.map((c) => pct(c).padStart(5)).join(" ");
  const line = (name: string, s: ReturnType<typeof mk>): string =>
    `  ${name.padEnd(16)} mean=${(s.sum / N).toFixed(3)} min=${s.min.toFixed(
      3,
    )} max=${s.max.toFixed(3)}\n    ${bars(s.hist)}`;
  console.log(
    `[cloud detail dist] N=${N}  crease k=${BILLOW_CREASE_POWER}  ` +
      `bins = value 0.0..1.0 in 10% steps (% of voxels)\n` +
      `${line("R (grid 4, lo)", chR)}\n` +
      `${line("G (grid 8, mid)", chG)}\n` +
      `${line("B (grid 16, hi)", chB)}\n` +
      `${line("A (wisp/curl)", chA)}\n` +
      `${line("carve 0.6R+0.4G", carve)}\n` +
      `${line("fbm .625/.25/.125", fbm)}`,
  );
}

// =============================================================================
// Mip chain — per-channel box average + VARIANCE RENORMALIZATION.
// Three.js doesn't auto-mip Data3DTexture.
//
// ✅ UPLOADED since 2026-06-11 via patches/three@0.183.2.patch: stock three
// (≤ r184 incl. upstream dev) writes ONLY level 0 for a Data3DTexture and
// never transfers `texture.mipmaps`, while still allocating
// mipLevelCount = mipmaps.length — GPU mip levels 1+ were ZERO, so any
// `.level(>0)` sample blended toward zero. This silently broke the
// 2026-06-03 explicit-mip experiment ("coverage drops with distance",
// misdiagnosed as box-filter variance loss) and the 2026-06-10/11
// footprint-mip scheme ("small clouds fade in close") — see
// CLOUD_DEBUGGING_LESSONS case study #16. The pnpm patch uploads each
// mipmaps[] entry slice-by-slice to its mip level; verified by the readback
// test at /dev/mip3d-test (re-run it after any three upgrade, and check
// whether upstream has gained the upload before rebasing the patch).
// Consumers still sample `.level(int(0))` until the footprint-matched mip
// scheme is deliberately re-enabled.
//
// NOTE: AUTO mip selection (GPU computing mip from per-quad texture-coord
// derivatives) cross-hatches inside the ray-march loop (per-pixel dither spikes
// the derivative → inconsistent mip at iso-distance contours; see
// `docs/CLOUD_DEBUGGING_LESSONS.md` case study #2), so the marcher never uses
// implicit LOD — it passes an EXPLICIT `.level(...)` everywhere.
//
// The renormalization (`renormalizeToMoments`): each level carries mip-0's
// per-channel mean/std, so a band-limited level passes the Schneider Remap
// threshold at roughly the same expected rate as mip 0 — required for any
// future distance-mip scheme to avoid coverage shifts.
// Startup ~10 ms; GPU memory +33% of the base volume.
// =============================================================================

function downsample3DRGBA(src: Uint8Array, srcSize: number): Uint8Array {
  const dstSize = Math.max(1, srcSize >> 1);
  const dst = new Uint8Array(dstSize * dstSize * dstSize * 4);
  let dstIdx = 0;
  for (let z = 0; z < dstSize; z++) {
    const sz = z * 2;
    for (let y = 0; y < dstSize; y++) {
      const sy = y * 2;
      for (let x = 0; x < dstSize; x++) {
        const sx = x * 2;
        let r = 0,
          g = 0,
          b = 0,
          a = 0;
        for (let dz = 0; dz < 2; dz++) {
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const sIdx =
                (((sz + dz) * srcSize + (sy + dy)) * srcSize + (sx + dx)) * 4;
              r += src[sIdx];
              g += src[sIdx + 1];
              b += src[sIdx + 2];
              a += src[sIdx + 3];
            }
          }
        }
        dst[dstIdx++] = (r / 8) | 0;
        dst[dstIdx++] = (g / 8) | 0;
        dst[dstIdx++] = (b / 8) | 0;
        dst[dstIdx++] = (a / 8) | 0;
      }
    }
  }
  return dst;
}

// Per-channel mean + std over an RGBA8 volume.
function channelMoments(data: Uint8Array): { mean: number[]; std: number[] } {
  const n = data.length / 4;
  const sum = [0, 0, 0, 0];
  const sumSq = [0, 0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      const v = data[i + c];
      sum[c] += v;
      sumSq[c] += v * v;
    }
  }
  const mean = sum.map((s) => s / n);
  const std = sumSq.map((s, c) => {
    const variance = s / n - mean[c] * mean[c];
    return Math.sqrt(Math.max(variance, 0));
  });
  return { mean, std };
}

// Remap a mip level's channels to match mip-0's mean/std (see the header note
// above — this is the coverage-compensation that makes distance-mip sampling
// safe against the shader's Remap threshold). In-place.
function renormalizeToMoments(
  data: Uint8Array,
  ref: { mean: number[]; std: number[] },
): void {
  const { mean, std } = channelMoments(data);
  // Gain clamped to [1, 4]: ≥1 because box filtering only ever SHRINKS std
  // (a measured gain < 1 is sample noise on tiny mips); ≤4 so the deepest
  // levels (8³ and below, where std is statistically meaningless) can't
  // explode values to the 0/255 rails. The marcher clamps its explicit lod
  // to ≤4 anyway, so levels past 8³ are never sampled.
  const gain = [0, 1, 2, 3].map((c) => {
    if (std[c] <= 1e-3) return 1;
    const g = ref.std[c] / std[c];
    return g < 1 ? 1 : g > 4 ? 4 : g;
  });
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      const v = ref.mean[c] + (data[i + c] - mean[c]) * gain[c];
      data[i + c] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    }
  }
}

function buildMippedTexture(
  baseData: Uint8Array,
  size: number,
  label: string,
): THREE.Data3DTexture {
  const tStart = performance.now();
  const refMoments = channelMoments(baseData);
  const mipmaps: {
    data: Uint8Array;
    width: number;
    height: number;
    depth: number;
  }[] = [];
  let mipData = baseData;
  let mipSize = size;
  mipmaps.push({
    data: mipData,
    width: mipSize,
    height: mipSize,
    depth: mipSize,
  });
  while (mipSize > 1) {
    mipData = downsample3DRGBA(mipData, mipSize);
    mipSize = mipSize >> 1;
    // Variance-preserving: every mip carries mip-0's per-channel moments so
    // explicit distance-mip sampling in the marcher doesn't shift coverage.
    // NOTE: renormalize in-place BEFORE the next downsample reads this level —
    // the chain therefore band-limits the renormalized signal, which keeps
    // the moment correction stable down the chain.
    renormalizeToMoments(mipData, refMoments);
    mipmaps.push({
      data: mipData,
      width: mipSize,
      height: mipSize,
      depth: mipSize,
    });
  }

  const tex = new THREE.Data3DTexture(baseData, size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipMapLinearFilter;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (tex as any).mipmaps = mipmaps;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  console.log(
    `[noiseVolumes] ${label} mip chain: ${mipmaps.length} levels in ${(
      performance.now() - tStart
    ).toFixed(0)} ms`,
  );

  return tex;
}

// =============================================================================
// Public API — lazy, cached across calls.
// =============================================================================

let cachedBase: THREE.Data3DTexture | null = null;
let cachedDetail: THREE.Data3DTexture | null = null;

export function getCloudBaseVolume(): THREE.Data3DTexture {
  if (cachedBase) return cachedBase;
  const t0 = performance.now();
  const data = generateBaseVolume();
  console.log(
    `[noiseVolumes] base ${BASE_SIZE}^3 RGBA8 generated in ${(
      performance.now() - t0
    ).toFixed(0)} ms (${(data.length / 1024 / 1024).toFixed(1)} MB)`,
  );
  cachedBase = buildMippedTexture(data, BASE_SIZE, `base ${BASE_SIZE}^3`);
  return cachedBase;
}

export function getCloudDetailVolume(): THREE.Data3DTexture {
  if (cachedDetail) return cachedDetail;
  const t0 = performance.now();
  const data = generateDetailVolume();
  console.log(
    `[noiseVolumes] detail ${DETAIL_SIZE}^3 RGBA8 generated in ${(
      performance.now() - t0
    ).toFixed(0)} ms`,
  );
  cachedDetail = buildMippedTexture(
    data,
    DETAIL_SIZE,
    `detail ${DETAIL_SIZE}^3`,
  );
  return cachedDetail;
}
