import * as THREE from "three";

// 64³ R8 = 256 KB. Fits cleanly in the GPU texture cache; the tile rate
// in the shader hides the lower absolute resolution.
const SIZE = 64;
// Cells per axis for the Worley grid. Smaller = bigger puffs.
const GRID = 4;

function seededRandom(seed: number): number {
  let s = (seed | 0) + 0x6d2b79f5;
  s = Math.imul(s ^ (s >>> 15), s | 1);
  s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
  return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
}

function hash3(x: number, y: number, z: number): number {
  return seededRandom((x * 73856093) ^ (y * 19349663) ^ (z * 83492791));
}

/**
 * Tileable 3D Worley noise, inverted so the feature-point neighbourhoods
 * become bright lobes (cloud-ish) and the cell boundaries become dark gaps.
 * Pre-computes feature points for the GRID³ cells, then samples each voxel
 * against the 3×3×3 neighbourhood with wrap-around.
 */
function generateNoise(): Uint8Array {
  // Pre-seed feature points so we don't hash inside the voxel loop.
  const fx = new Float32Array(GRID * GRID * GRID);
  const fy = new Float32Array(GRID * GRID * GRID);
  const fz = new Float32Array(GRID * GRID * GRID);
  for (let z = 0; z < GRID; z++) {
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const idx = (z * GRID + y) * GRID + x;
        fx[idx] = x + hash3(x, y, z);
        fy[idx] = y + hash3(x + 1, y + 3, z + 7);
        fz[idx] = z + hash3(x + 2, y + 5, z + 11);
      }
    }
  }

  const data = new Uint8Array(SIZE * SIZE * SIZE);
  const cellScale = GRID / SIZE;
  // Furthest possible distance before normalising: half a cell diagonal.
  const invMaxDist = 1.0 / (Math.sqrt(3) * 0.5);

  let idx = 0;
  for (let z = 0; z < SIZE; z++) {
    const pz = z * cellScale;
    const cz = Math.floor(pz);
    for (let y = 0; y < SIZE; y++) {
      const py = y * cellScale;
      const cy = Math.floor(py);
      for (let x = 0; x < SIZE; x++) {
        const px = x * cellScale;
        const cx = Math.floor(px);

        let minD2 = 1e9;
        for (let dz = -1; dz <= 1; dz++) {
          const nz = cz + dz;
          const wz = ((nz % GRID) + GRID) % GRID;
          const offZ = nz - wz; // compensate wrap so feature sits in neighbour cell
          for (let dy = -1; dy <= 1; dy++) {
            const ny = cy + dy;
            const wy = ((ny % GRID) + GRID) % GRID;
            const offY = ny - wy;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx;
              const wx = ((nx % GRID) + GRID) % GRID;
              const offX = nx - wx;

              const fIdx = (wz * GRID + wy) * GRID + wx;
              const ddx = px - (fx[fIdx] + offX);
              const ddy = py - (fy[fIdx] + offY);
              const ddz = pz - (fz[fIdx] + offZ);
              const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
              if (d2 < minD2) minD2 = d2;
            }
          }
        }

        // Inverted Worley: 1 at feature points, 0 at cell boundaries.
        const v = Math.max(0, 1 - Math.sqrt(minD2) * invMaxDist);
        data[idx++] = (v * 255) | 0;
      }
    }
  }
  return data;
}

/**
 * 2× box-downsample of an R8 3D volume — averages the 8 voxels of each parent
 * cell into the child voxel. Used to build the mip chain by hand, since
 * Three.js doesn't auto-generate mipmaps for Data3DTexture.
 */
function downsample3D(src: Uint8Array, srcSize: number): Uint8Array {
  const dstSize = Math.max(1, srcSize >> 1);
  const dst = new Uint8Array(dstSize * dstSize * dstSize);
  let dstIdx = 0;
  for (let z = 0; z < dstSize; z++) {
    const sz = z * 2;
    for (let y = 0; y < dstSize; y++) {
      const sy = y * 2;
      for (let x = 0; x < dstSize; x++) {
        const sx = x * 2;
        let sum = 0;
        for (let dz = 0; dz < 2; dz++) {
          const zRow = (sz + dz) * srcSize;
          for (let dy = 0; dy < 2; dy++) {
            const yRow = (zRow + sy + dy) * srcSize;
            sum += src[yRow + sx];
            sum += src[yRow + sx + 1];
          }
        }
        dst[dstIdx++] = (sum / 8) | 0;
      }
    }
  }
  return dst;
}

let cached: THREE.Data3DTexture | null = null;

export function getCloudNoise3D(): THREE.Data3DTexture {
  if (cached) return cached;

  const t0 = performance.now();
  const data = generateNoise();
  const tGen = performance.now();

  // Build mip chain: 64³ → 32³ → 16³ → 8³ → 4³ → 2³ → 1.
  // Trilinear MIP filtering removes shimmer when the cloud animation drifts
  // the noise sample position across the voxel grid, and reduces aliasing on
  // distant fragments where adjacent screen pixels span multiple voxels.
  const mipmaps: { data: Uint8Array; width: number; height: number; depth: number }[] = [];
  let mipData = data;
  let mipSize = SIZE;
  mipmaps.push({ data: mipData, width: mipSize, height: mipSize, depth: mipSize });
  while (mipSize > 1) {
    mipData = downsample3D(mipData, mipSize);
    mipSize = mipSize >> 1;
    mipmaps.push({ data: mipData, width: mipSize, height: mipSize, depth: mipSize });
  }

  const tex = new THREE.Data3DTexture(data, SIZE, SIZE, SIZE);
  tex.format = THREE.RedFormat;
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
    `[cloudNoise] generated ${SIZE}^3 in ${(tGen - t0).toFixed(0)} ms, ` +
    `${mipmaps.length} mip levels in ${(performance.now() - tGen).toFixed(0)} ms`,
  );

  cached = tex;
  return tex;
}
