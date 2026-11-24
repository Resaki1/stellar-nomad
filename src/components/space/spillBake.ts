/**
 * S3 — baked lamp spill (docs/VFX_REALISM_PLAN.md §4; bake: tools/models/spill-bake.mjs).
 *
 * Each station LOD has a lightmap of its steady lamps' diffuse light on its second UV map
 * (TEXCOORD_1). A texel holds irradiance E in game units; three adds a light map as
 * irradiance × diffuse/π, so the material only needs `lightMapIntensity` = pre-exposure (D25),
 * written every frame like every other light.
 */

import { useLoader } from "@react-three/fiber";
import { MeshStandardMaterial, type Material, type Texture } from "three";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";

const live = new Set<MeshStandardMaterial>();
const maps = new Set<Texture>();
let _gain = 1;

/** The baked lightmaps of an asset's render LODs (suspends while loading). */
export function useSpillLightmaps(base: string, lods: number): Texture[] {
  const urls = Array.from({ length: lods }, (_, k) => `${base}-spill-lod${k}.hdr`);
  const textures = useLoader(HDRLoader, urls) as Texture[];
  for (const t of textures) {
    t.channel = 1;
    // Blender writes the .hdr bottom row first: flip V (MEASURED: unflipped, the pools land on
    // the wrong UV islands, bright blocks far from any lamp).
    t.repeat.set(1, -1);
    t.offset.set(0, 1);
    maps.add(t);
  }
  return textures;
}

/**
 * Give one surface material the light map (TEXCOORD_1). GLB materials are per LOD, so the
 * material is used as is; returns it for chaining.
 */
export function withSpillLightmap<T extends Material>(m: T, map: Texture | undefined): T {
  if (!map || !(m instanceof MeshStandardMaterial)) return m;
  m.lightMap = map;
  m.lightMapIntensity = 0;
  live.add(m);
  return m;
}

/** Per frame: intensity = pre-exposure (× dev gain). */
export function updateSpillLightmaps(preExposure: number): void {
  const v = preExposure * _gain;
  live.forEach((m) => { m.lightMapIntensity = v; });
}

/** Dev: undo the V flip (orientation check: `__spill.flip(false)` shows the wrong mapping). */
export function flipSpillLightmaps(on: boolean): void {
  maps.forEach((t) => { t.repeat.set(1, on ? -1 : 1); t.offset.set(0, on ? 1 : 0); t.needsUpdate = true; });
}

/** Dev A/B: 0 removes the baked spill. */
export function setSpillBakeGain(g: number): void {
  _gain = g;
}

export function spillBakeStats(): { materials: number; gain: number } {
  return { materials: live.size, gain: _gain };
}
