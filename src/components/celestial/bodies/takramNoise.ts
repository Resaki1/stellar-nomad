import * as THREE from "three";

// =============================================================================
// Takram-recipe noise volumes (docs/CLOUD_VS_TAKRAM.md Phase 3).
//
// Loads the offline-baked single-channel (RedFormat) 3D volumes produced by
// scripts/bake_takram_noise.mjs — a faithful port of @takram/three-clouds'
// noise recipe (Sébastien Hillaire Perlin-Worley shape + Worley-FBM detail):
//   /textures/clouds/takram_shape.bin        128^3  (Perlin-Worley billows)
//   /textures/clouds/takram_shape_detail.bin  32^3  (Worley-FBM cells)
// Raw Uint8, x-fastest, tileable. Consumed by the TAKRAM_SHAPE path in
// earthClouds' marcher (takramDensity). Async-filled: the texture is returned
// immediately (zeros) and populated when the fetch resolves (needsUpdate).
//
// Regenerate the .bin with:  node scripts/bake_takram_noise.mjs
// =============================================================================

export const TAKRAM_SHAPE_SIZE = 128;
export const TAKRAM_DETAIL_SIZE = 32;

function makeVolume(
  size: number,
  path: string,
  label: string,
): THREE.Data3DTexture {
  const data = new Uint8Array(size * size * size); // zeros until the fetch lands
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.wrapR = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter; // no mips (Data3DTexture mip upload is fiddly; see noiseVolumes)
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace; // data, not colour
  tex.unpackAlignment = 1; // single-channel rows
  tex.needsUpdate = true;

  fetch(path)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((buf) => {
      const src = new Uint8Array(buf);
      if (src.length !== data.length) {
        console.error(
          `[takramNoise] ${label}: expected ${data.length} B, got ${src.length} B — not applied`,
        );
        return;
      }
      data.set(src);
      tex.needsUpdate = true;
      console.log(`[takramNoise] ${label} loaded (${src.length} B, ${size}^3)`);
    })
    .catch((e) => {
      console.error(`[takramNoise] ${label} load failed (${path})`, e);
    });

  return tex;
}

let cachedShape: THREE.Data3DTexture | null = null;
let cachedDetail: THREE.Data3DTexture | null = null;

export function getTakramShapeVolume(): THREE.Data3DTexture {
  if (!cachedShape) {
    cachedShape = makeVolume(
      TAKRAM_SHAPE_SIZE,
      "/textures/clouds/takram_shape.bin",
      "shape",
    );
  }
  return cachedShape;
}

export function getTakramDetailVolume(): THREE.Data3DTexture {
  if (!cachedDetail) {
    cachedDetail = makeVolume(
      TAKRAM_DETAIL_SIZE,
      "/textures/clouds/takram_shape_detail.bin",
      "detail",
    );
  }
  return cachedDetail;
}
