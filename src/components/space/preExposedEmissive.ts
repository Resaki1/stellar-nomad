/**
 * Pre-exposure for EMISSIVE materials that are plain three.js materials rather
 * than TSL node graphs (defect D25).
 *
 * ── WHY A REGISTRY RATHER THAN A MULTIPLY AT EACH SITE ──────────────────────
 * The uniform-driven sites pre-expose themselves: a TSL graph just multiplies by
 * `uPreExposure`, and a per-frame JS uniform write multiplies by
 * `getPreExposure()`. Neither can go stale. But a `MeshBasicMaterial`'s `color`
 * is a plain CPU value set once at construction, so pre-exposing it means
 * REWRITING it every frame — and rewriting in place destroys the base value, so
 * the second frame would compound the scale (base × p × p × …).
 *
 * So each material has to keep its authored colour separately. Doing that inline
 * at every VFX site is where this drifts: there are half a dozen of them
 * (`MiningSystem`, `DebrisEffect`, `FlashEffect`, `AsteroidVFX`,
 * `WreckCollector`), they are created inside factories and effect callbacks, and
 * a site that is added later silently breaks the pre-exposure invariance —
 * showing up as an effect that darkens as the scene gets brighter, which is a
 * miserable thing to debug from the symptom.
 *
 * ⚠ These effects' ABSOLUTE levels are still the old uncalibrated ones (0.4,
 * 0.5, 0.6 — the same class as D26's hull emissive). Pre-exposure and calibration
 * are orthogonal: this file makes them scale-INVARIANT, which is all D25 needs.
 * Putting them on the photometric scale is separate work.
 */

import type * as THREE from "three";
import { getPreExposure } from "./photometry";

type Emissive = {
  mat: THREE.Material & { color: THREE.Color };
  /** The authored colour, captured at registration and never mutated. */
  base: THREE.Color;
};

const tracked = new Set<Emissive>();

/**
 * Track a material's `color` so it is pre-exposed every frame.
 *
 * Call right after the material is created. Returns a disposer — call it when the
 * material is disposed, or the registry leaks (and keeps writing to a dead
 * material every frame).
 */
export function registerPreExposedEmissive(
  mat: THREE.Material & { color: THREE.Color },
): () => void {
  const entry: Emissive = { mat, base: mat.color.clone() };
  tracked.add(entry);
  // Apply immediately so the first frame is correct even if it renders before
  // the next updatePreExposedEmissives().
  mat.color.copy(entry.base).multiplyScalar(getPreExposure());
  return () => {
    tracked.delete(entry);
  };
}

/**
 * Rescale every tracked emissive to this frame's pre-exposure. Call once per
 * frame from SpaceRenderer, AFTER updatePreExposureForFrame().
 *
 * Always written from `base`, never accumulated onto the current value — see the
 * compounding note above.
 */
export function updatePreExposedEmissives(): void {
  if (tracked.size === 0) return;
  const p = getPreExposure();
  tracked.forEach((e) => {
    e.mat.color.copy(e.base).multiplyScalar(p);
  });
}

/** How many emissive materials are tracked — for the `__lum` diagnostics. */
export const preExposedEmissiveCount = (): number => tracked.size;
