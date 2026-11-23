// ---------------------------------------------------------------------------
// FLUX-CONSERVING LIGHT POINTS — docs/VFX_REALISM_PLAN.md §1 (L1–L3).
//
// Small bright things (station lamps, beacons, beam muzzles and impacts) go sub-pixel
// long before they should go dark. Under 4× MSAA a sub-pixel lamp mesh covers 0–4
// samples of one pixel and pops (measured 2 → 10 px frame to frame at 250 m). A real
// lamp at distance is a PSF-sized point whose flux falls as I/d².
//
// So each lamp is ALSO a point: an instanced Gaussian sprite whose integrated radiance
// equals E = I/d² (StarField's validated normalisation), and the lamp's mesh emissive
// and its point crossfade by projected size with the flux held constant:
//   mesh only above PX_MESH, point only below PX_POINT (both from the lamp's size).
//
// Producers call `emitLightPoints` / `pushLightPoint` from their useFrame (priority < 0.9);
// `LightPoints.tsx` uploads and resets the buffer once per frame before the render.
// ---------------------------------------------------------------------------

import { clamp, float, materialEmissive, positionView, select, uniform, vec3 } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import type { Matrix4, MeshStandardMaterial, Object3D } from "three";
import { Vector3 } from "three";
import { EMITTERS, emitterColor, type EmitterId } from "./emissivePhotometry";

/** Point owns all of the flux below this projected size (px)… */
export const PX_POINT = 2;
/** …the mesh all of it above this one. */
export const PX_MESH = 4;
export const LIGHT_POINT_CAPACITY = 4096;

/** tan(θ) per drawing-buffer pixel of the local camera; written by LightPoints each frame. */
export const uTanPerPx = uniform(1e-3);
/** Dev: 0 removes every lamp (points AND fading meshes) so an on/off pair isolates their flux. */
export const uLampGain = uniform(1);
/** Dev: ≥ 0 forces the point share of the crossfade (0 = mesh only, 1 = points only); −1 = by size. */
export const uForcePointShare = uniform(-1);

/** Point share 0..1 from a lamp's projected size in px (both sides of the crossfade use this). */
export function pointShare(px: ReturnType<typeof float>) {
  const w = clamp(float(PX_MESH).sub(px).div(PX_MESH - PX_POINT), 0, 1);
  return select(uForcePointShare.greaterThanEqual(0), uForcePointShare, w);
}

/** One lamp set, read once from a model (Blender `light_*` empties, L3). Model space. */
export type LightTemplate = {
  count: number;
  /** xyz per point, metres. */
  pos: Float32Array;
  /** Unit facing direction, or 0 for an isotropic lamp. */
  dir: Float32Array;
  /** Intensity per channel in game units × m² (radiance × emitting area): cd / 6037.7. */
  rgb: Float32Array;
  /** Characteristic size, metres — the crossfade measures this in pixels. */
  size: Float32Array;
  /** 1 = follows the blink phase, 0 = steady. */
  blink: Uint8Array;
};

const _p = new Vector3();

function isEmitter(id: unknown): id is EmitterId {
  return typeof id === "string" && id in EMITTERS;
}

/**
 * Collect every node carrying light extras (`emitter`, `area_m2`, `size_m`, `blink`,
 * `cosine`) under `root`, in root space. Intensity = the emitter's radiance × area.
 */
export function readLightTemplate(root: Object3D): LightTemplate {
  root.updateMatrixWorld(true);
  const nodes: Object3D[] = [];
  root.traverse((n) => {
    if (isEmitter(n.userData?.emitter) && Number(n.userData.area_m2) > 0) nodes.push(n);
  });
  const t: LightTemplate = {
    count: nodes.length,
    pos: new Float32Array(nodes.length * 3),
    dir: new Float32Array(nodes.length * 3),
    rgb: new Float32Array(nodes.length * 3),
    size: new Float32Array(nodes.length),
    blink: new Uint8Array(nodes.length),
  };
  const inv = root.matrixWorld.clone().invert();
  nodes.forEach((n, i) => {
    const local = inv.clone().multiply(n.matrixWorld);
    _p.setFromMatrixPosition(local);
    t.pos.set([_p.x, _p.y, _p.z], i * 3);
    if (Number(n.userData.cosine) > 0) {
      _p.setFromMatrixColumn(local, 2).normalize();
      t.dir.set([_p.x, _p.y, _p.z], i * 3);
    }
    const c = emitterColor(n.userData.emitter as EmitterId);
    const area = Number(n.userData.area_m2);
    t.rgb.set([c.r * area, c.g * area, c.b * area], i * 3);
    t.size[i] = Number(n.userData.size_m) || Math.sqrt(area);
    t.blink[i] = Number(n.userData.blink) > 0 ? 1 : 0;
  });
  return t;
}

// ── The per-frame buffer ────────────────────────────────────────────────────

export const lightPointBuffer = {
  count: 0,
  pos: new Float32Array(LIGHT_POINT_CAPACITY * 3),
  dir: new Float32Array(LIGHT_POINT_CAPACITY * 3),
  rgb: new Float32Array(LIGHT_POINT_CAPACITY * 3),
  size: new Float32Array(LIGHT_POINT_CAPACITY),
  /** Points dropped for lack of capacity, and the count drawn, last frame (diagnostics). */
  dropped: 0,
  drawn: 0,
};

/**
 * Append one point in local-scene metres. `rgb` in game units × m² (see LightTemplate),
 * `dir` a unit vector or null for isotropic.
 */
export function pushLightPoint(
  x: number, y: number, z: number,
  r: number, g: number, b: number,
  sizeM: number,
  dir: Vector3 | null = null,
): void {
  const B = lightPointBuffer;
  if (B.count >= LIGHT_POINT_CAPACITY) { B.dropped++; return; }
  const i = B.count++;
  B.pos[i * 3] = x; B.pos[i * 3 + 1] = y; B.pos[i * 3 + 2] = z;
  B.rgb[i * 3] = r; B.rgb[i * 3 + 1] = g; B.rgb[i * 3 + 2] = b;
  B.dir[i * 3] = dir ? dir.x : 0; B.dir[i * 3 + 1] = dir ? dir.y : 0; B.dir[i * 3 + 2] = dir ? dir.z : 0;
  B.size[i] = sizeM;
}

/**
 * Append a template placed by `m` (model → local-scene metres; rigid, unit scale).
 * Blinking points take `blinkGain` (0..1), the rest `gain`.
 */
export function emitLightPoints(t: LightTemplate, m: Matrix4, blinkGain: number, gain = 1): void {
  const e = m.elements;
  const B = lightPointBuffer;
  for (let i = 0; i < t.count; i++) {
    const k = t.blink[i] ? blinkGain : gain;
    if (k <= 0) continue;
    if (B.count >= LIGHT_POINT_CAPACITY) { B.dropped += t.count - i; return; }
    const j = B.count++;
    const x = t.pos[i * 3], y = t.pos[i * 3 + 1], z = t.pos[i * 3 + 2];
    B.pos[j * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
    B.pos[j * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    B.pos[j * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    const dx = t.dir[i * 3], dy = t.dir[i * 3 + 1], dz = t.dir[i * 3 + 2];
    B.dir[j * 3] = e[0] * dx + e[4] * dy + e[8] * dz;
    B.dir[j * 3 + 1] = e[1] * dx + e[5] * dy + e[9] * dz;
    B.dir[j * 3 + 2] = e[2] * dx + e[6] * dy + e[10] * dz;
    B.rgb[j * 3] = t.rgb[i * 3] * k;
    B.rgb[j * 3 + 1] = t.rgb[i * 3 + 1] * k;
    B.rgb[j * 3 + 2] = t.rgb[i * 3 + 2] * k;
    B.size[j] = t.size[i];
  }
}

/** Mast-beacon flash (0/1): 450 ms every 2 s, from SIM time so co-op peers blink together (L3). */
export function beaconFlash(simEpochMs: number): number {
  const t = ((simEpochMs % 2000) + 2000) % 2000;
  return t < 450 ? 1 : 0;
}

// ── Mesh side of the crossfade (L2) ─────────────────────────────────────────

/** Mesh share of a lamp of `sizeM` at this fragment: 0 below PX_POINT px, 1 above PX_MESH. */
export function lampMeshWeight(sizeM: number) {
  const px = float(sizeM).div(positionView.length().mul(uTanPerPx).max(1e-12));
  return float(1).sub(pointShare(px));
}

/**
 * Node-material copy of a lamp material whose emissive fades out exactly as its light
 * points fade in. Emissive colour stays on `emissive` (pre-exposure registry, blink).
 */
export function fadingLampMaterial(src: MeshStandardMaterial, sizeM: number): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = src.name;
  m.color.copy(src.color);
  m.roughness = src.roughness;
  m.metalness = src.metalness;
  m.map = src.map;
  m.normalMap = src.normalMap;
  m.normalScale.copy(src.normalScale);
  m.roughnessMap = src.roughnessMap;
  m.metalnessMap = src.metalnessMap;
  m.emissive.copy(src.emissive);
  m.emissiveMap = src.emissiveMap;
  m.emissiveIntensity = src.emissiveIntensity;
  m.side = src.side;
  // `materialEmissive` is emissive × emissiveIntensity × emissiveMap, read from the material.
  m.emissiveNode = vec3(materialEmissive).mul(lampMeshWeight(sizeM)).mul(uLampGain);
  return m;
}
