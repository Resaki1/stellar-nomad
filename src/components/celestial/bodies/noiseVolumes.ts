import * as THREE from "three";

// =============================================================================
// Nubis-style noise volumes for the volumetric cloud shell.
//
// Base volume (128³ RGBA8):
//   R: Low-freq Perlin-Worley hybrid (Schneider's "perlin-worley" R channel).
//      `perlinWorley = mix(perlin, 1 - worley, 0.5)` — Perlin fills the gaps
//      between Worley cell-centers, Worley contributes billowy "puff" cores.
//      The result has the cumulus-cauliflower character that pure Perlin
//      (smooth blobs) and pure Worley (sharp cells) each lack on their own.
//      Earlier this slot was pure Perlin to avoid "honeycomb" artifacts at
//      close range; in practice with `mix(perlin, 1-worley, 0.5)` and
//      G_LOW=4 (large cells), no honeycomb appears — the cells read as
//      cloud bodies, not as a regular pattern.
//   G: Worley FBM at low/mid/high octaves [grid 4, 8, 16].   Low-freq band.
//   B: Worley FBM at mid/high/v.high octaves [grid 8, 16, 32]. Mid-freq band.
//   A: Worley FBM at high/v.high/detail octaves [grid 16, 32, 48]. High-freq band.
//
// In the shader, GBA are weighted (0.625, 0.25, 0.125) into a single FBM which
// is fed into Schneider's `remap` to dilate/erode the Perlin-Worley R channel.
// See `earthClouds.ts`.
//
// Detail volume (32³ RGBA8 — A unused, padded to 1.0):
//   R/G/B: Three Worley octaves at progressively higher freq [grid 4, 8, 16],
//          sampled separately for shader-side FBM. Used to erode cloud edges.
//
// Both volumes are tileable via wrap-around feature-point lookup. WebGPU does
// not support `RGBFormat`, so the detail volume is RGBA with a constant alpha;
// the +25% memory cost is negligible (32 KB).
//
// Reference: Schneider 2015, "Real-Time Volumetric Cloudscapes of Horizon Zero
// Dawn" (GPU Pro 7 / SIGGRAPH 2015 Advances in Real-Time Rendering).
// =============================================================================

const BASE_SIZE = 128;
const DETAIL_SIZE = 32;

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

// Sample inverted Worley at (px,py,pz) given in cell-space (i.e. caller has
// pre-multiplied by `grid / volSize`). Returns ~[0, 1] where 1 = at feature
// point and 0 = halfway between cells.
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
      }
    }
  }
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

function gradHash(x: number, y: number, z: number, grid: number): number {
  const wx = x < 0 ? x + grid : x >= grid ? x - grid : x;
  const wy = y < 0 ? y + grid : y >= grid ? y - grid : y;
  const wz = z < 0 ? z + grid : z >= grid ? z - grid : z;
  return Math.floor(hash3(wx, wy, wz, SALT_PERLIN) * 12) % 12;
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

  const g000 = dotGrad(gradHash(cx, cy, cz, grid), dx, dy, dz);
  const g100 = dotGrad(gradHash(cx + 1, cy, cz, grid), dx - 1, dy, dz);
  const g010 = dotGrad(gradHash(cx, cy + 1, cz, grid), dx, dy - 1, dz);
  const g110 = dotGrad(
    gradHash(cx + 1, cy + 1, cz, grid),
    dx - 1,
    dy - 1,
    dz,
  );
  const g001 = dotGrad(gradHash(cx, cy, cz + 1, grid), dx, dy, dz - 1);
  const g101 = dotGrad(
    gradHash(cx + 1, cy, cz + 1, grid),
    dx - 1,
    dy,
    dz - 1,
  );
  const g011 = dotGrad(
    gradHash(cx, cy + 1, cz + 1, grid),
    dx,
    dy - 1,
    dz - 1,
  );
  const g111 = dotGrad(
    gradHash(cx + 1, cy + 1, cz + 1, grid),
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
        const worleyR = worleySample(
          x * sWorleyR,
          y * sWorleyR,
          z * sWorleyR,
          w4,
        );
        const perlinWorley = worleyR + perlin * (1 - worleyR);

        // GBA: three FBM bands at progressively higher base frequencies.
        // Each band overlaps the next by two octaves so the shader can blend.
        const fbmG = worleyFbm(x, y, z, BASE_SIZE, w4, w8, w16);
        const fbmB = worleyFbm(x, y, z, BASE_SIZE, w8, w16, w32);
        const fbmA = worleyFbm(x, y, z, BASE_SIZE, w16, w32, w48);

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
  return data;
}

function generateDetailVolume(): Uint8Array {
  const w4 = seedWorleyGrid(DG_LOW, SALT_DW4);
  const w8 = seedWorleyGrid(DG_MID, SALT_DW8);
  const w16 = seedWorleyGrid(DG_HIGH, SALT_DW16);

  const data = new Uint8Array(DETAIL_SIZE * DETAIL_SIZE * DETAIL_SIZE * 4);
  const sR = DG_LOW / DETAIL_SIZE;
  const sG = DG_MID / DETAIL_SIZE;
  const sB = DG_HIGH / DETAIL_SIZE;

  let idx = 0;
  for (let z = 0; z < DETAIL_SIZE; z++) {
    for (let y = 0; y < DETAIL_SIZE; y++) {
      for (let x = 0; x < DETAIL_SIZE; x++) {
        // RGB = three independent Worley octaves. Shader assembles its own FBM
        // at runtime so each channel can be tweaked independently if needed.
        const r = worleySample(x * sR, y * sR, z * sR, w4);
        const g = worleySample(x * sG, y * sG, z * sG, w8);
        const b = worleySample(x * sB, y * sB, z * sB, w16);
        data[idx++] = (r * 255) | 0;
        data[idx++] = (g * 255) | 0;
        data[idx++] = (b * 255) | 0;
        data[idx++] = 255; // A unused — RGBA8 because WebGPU drops RGBFormat.
      }
    }
  }
  return data;
}

// =============================================================================
// Mip chain — per-channel box average. Three.js doesn't auto-mip Data3DTexture.
//
// NOTE: the cloud marcher (`earthClouds.ts`) currently samples ALL noise
// volumes at mip 0 explicitly via `.level(int(0))`. Auto-mip selection from
// per-quad texture-coord derivatives causes visible band artifacts inside a
// ray-march loop (per-pixel dither variance spikes the derivative, GPU picks
// inconsistent mip levels at iso-distance contours from the camera → soft
// cross-hatched ridges; see `docs/CLOUD_DEBUGGING_LESSONS.md` case study #2).
// The chain is still generated here in case a future LOD scheme uses it
// (e.g. analytic camera-distance-based mip selection for the far-LOD), but
// nothing reads it today. The startup cost is ~10ms and the GPU memory
// overhead is +33% of the base volume.
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

function buildMippedTexture(
  baseData: Uint8Array,
  size: number,
  label: string,
): THREE.Data3DTexture {
  const tStart = performance.now();
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
