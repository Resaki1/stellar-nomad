/**
 * S2 — one ship-following shadow map for the key light (docs/VFX_REALISM_PLAN.md §4).
 *
 * Covers what spheres can't: the ship on itself, stations, drones, other ships, wrecks.
 * Rocks don't cast into it (castShadow off; their shadows are S1's analytic spheres, so
 * nothing is counted twice), but every receiver samples it. Directional, orthographic,
 * centred on the ship and snapped to whole texels so edges don't swim as the ship moves.
 * Read once at startup (`settings.shadowMap`, `?shadows=0`): it changes every lit pipeline.
 */

import { Matrix4, Vector3, type DirectionalLight, type OrthographicCamera } from "three";
import { float, mix, shadow, uniform } from "three/tsl";
import { localShadowNode } from "./localShadows";

export const SHADOW_MAP_SIZE = 2048;
/** Half width of the map, m: 300 m covers the ship, a docked station (~75 m) and nearby drones. */
export const SHADOW_HALF_EXTENT_M = 150;
/** Depth slab along the sun line, m (casters up to this far sunward of the ship still land). */
const SHADOW_DEPTH_M = 1500;

let _cached: boolean | null = null;
/** Dev A/B: 0 bypasses the map's result (it still renders and samples, so cost is unchanged). */
const uMapOn = uniform(1);
export function setShadowMapTermEnabled(on: boolean): void {
  uMapOn.value = on ? 1 : 0;
}

export function isShadowMapRequested(): boolean {
  if (_cached !== null) return _cached;
  let on = true;
  try {
    const q = new URLSearchParams(window.location.search).get("shadows");
    if (q !== null) on = q !== "0";
    else {
      const raw = window.localStorage.getItem("settings");
      if (raw) on = JSON.parse(raw)?.shadowMap !== false;
    }
  } catch {
    on = true;
  }
  return (_cached = on);
}

/** Configure the key light's shadow; returns the node to install as `shadow.shadowNode`. */
export function configureKeyShadow(light: DirectionalLight): ReturnType<typeof localShadowNode> {
  if (!isShadowMapRequested()) return localShadowNode();
  const s = light.shadow;
  s.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  const cam = s.camera as OrthographicCamera;
  cam.left = -SHADOW_HALF_EXTENT_M; cam.right = SHADOW_HALF_EXTENT_M;
  cam.top = SHADOW_HALF_EXTENT_M; cam.bottom = -SHADOW_HALF_EXTENT_M;
  cam.near = 1; cam.far = SHADOW_DEPTH_M * 2;
  cam.updateProjectionMatrix();
  // Normal offset ≈ one texel (0.15 m); depth bias ~5 cm over the 3 km slab.
  s.normalBias = 0.12;
  s.bias = -0.05 / (SHADOW_DEPTH_M * 2);
  s.radius = 1.5;
  // ShadowNode's typings lack the node extensions; it is a float node at runtime.
  const map = float(shadow(light, s) as unknown as Parameters<typeof float>[0]);
  return localShadowNode().mul(mix(float(1), map, uMapOn)) as unknown as ReturnType<typeof localShadowNode>;
}

const _m = new Matrix4();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();

/**
 * Place the light (direction `dir`, unit, toward the sun) so its shadow camera centres on
 * `centre` (scene metres), snapped to the map's texel grid in light space.
 */
export function followWithShadow(light: DirectionalLight, centre: Vector3, dir: Vector3): void {
  if (!light.castShadow || !isShadowMapRequested()) {
    light.position.copy(dir);
    light.target.position.set(0, 0, 0);
    light.target.updateMatrixWorld();
    return;
  }
  // The shadow camera's basis: lookAt from +dir toward the origin (three's convention).
  _m.lookAt(dir, _z.set(0, 0, 0), light.shadow.camera.up);
  _m.extractBasis(_x, _y, _z);
  const texel = (2 * SHADOW_HALF_EXTENT_M) / SHADOW_MAP_SIZE;
  const px = centre.dot(_x), py = centre.dot(_y);
  const dx = Math.round(px / texel) * texel - px, dy = Math.round(py / texel) * texel - py;
  light.target.position.copy(centre).addScaledVector(_x, dx).addScaledVector(_y, dy);
  light.position.copy(light.target.position).addScaledVector(dir, SHADOW_DEPTH_M);
  light.target.updateMatrixWorld();
}
