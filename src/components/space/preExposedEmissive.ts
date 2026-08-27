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
 * (`MiningSystem`, `DebrisEffect`, `FlashEffect`, `WreckCollector`), they are
 * created inside factories and effect callbacks, and a site that is added later
 * silently breaks the pre-exposure invariance — showing up as an effect that
 * darkens as the scene gets brighter, which is a miserable thing to debug from
 * the symptom. `__lum.preExposure(8)` is the test that finds them.
 */

import type * as THREE from "three";

import { getPreExposure, HALF_FLOAT_WRITE_MAX } from "./photometry";

/** Which colour property carries the EMITTED radiance. */
type Channel = "color" | "emissive";

type LitMaterial = THREE.Material & {
  color?: THREE.Color;
  emissive?: THREE.Color;
};

type Emissive = {
  mat: LitMaterial;
  channel: Channel;
  /** The authored colour, captured at registration and never mutated. */
  base: THREE.Color;
};

const tracked = new Set<Emissive>();

/**
 * Pick the property that actually EMITS.
 *
 * ⚠⚠ THIS IS NOT A CONVENIENCE — GETTING IT WRONG IS AN ENERGY BUG. On a lit
 * material (`MeshStandardMaterial` and friends) `color` is REFLECTANCE and
 * `emissive` is emission. The light already carries pre-exposure, so scaling
 * `color` there would apply it TWICE to the reflected term while leaving the
 * emissive un-scaled — i.e. exactly inverted. On an unlit material
 * (`MeshBasicMaterial`, `SpriteMaterial`, `LineBasicMaterial`) there is no
 * lighting and no `emissive`, so `color` IS the emitted radiance.
 *
 * 🔑 The discriminator is the PRESENCE of an `emissive` property, not the class
 * name: it is what three.js itself uses to decide whether the emissive term is
 * in the shader, so the two can never disagree.
 */
function pickChannel(mat: LitMaterial): Channel {
  return mat.emissive !== undefined ? "emissive" : "color";
}

/**
 * Track a material's emitted colour so it is pre-exposed every frame.
 *
 * Call right after the material is created. Returns a disposer — call it when
 * the material is disposed, or the registry leaks (and keeps writing to a dead
 * material every frame).
 *
 * `channel` overrides the auto-detection above; pass it only for a material that
 * genuinely emits through `color` despite also having an `emissive` slot.
 */
export function registerPreExposedEmissive(
  mat: LitMaterial,
  channel?: Channel,
): () => void {
  const ch = channel ?? pickChannel(mat);
  const target = mat[ch];
  if (!target) {
    // Nothing to scale. Return a no-op rather than throwing: a caller in an
    // effect callback should not have to guard a material three.js changed.
    return () => {};
  }
  const entry: Emissive = { mat, channel: ch, base: target.clone() };
  tracked.add(entry);
  // Apply immediately so the first frame is correct even if it renders before
  // the next updatePreExposedEmissives().
  apply(entry, getPreExposure());
  return () => {
    tracked.delete(entry);
    // Restore the authored value. Without this, a material that outlives its
    // registration (React strict-mode double-invoke, or a pooled material)
    // stays frozen at whatever pre-exposure was live when it was dropped.
    const t = entry.mat[entry.channel];
    if (t) t.copy(entry.base);
  };
}

/**
 * ⚠⚠ CLAMPED, and the clamp is load-bearing. The scene renders into RGBA16F, so
 * a channel above 65504 becomes Inf and then NaN through the bloom chain — one
 * blown emissive takes out the whole frame.
 *
 * Pre-exposure reaches `1/(1.2·2^EV_MIN)` ≈ 2.2e5 in a fully dark-adapted scene,
 * so ANY emissive above ~0.3 game units can overflow during the ~0.25 s
 * TAU_BRIGHTEN transient after an effect fires in the dark — which is precisely
 * when VFX fire. The calibrated plume is 12 units and the mining glow 0.47, so
 * this is not hypothetical.
 *
 * 🔑 Clamped AFTER the multiply, exactly as `Star.tsx` does for the sun disc: the
 * cap has to be absolute in BUFFER space, and an absolute cap applied before a
 * scale is not a cap at all (the trap D25 records for `SUN_DISC_RADIANCE_GAME`).
 */
function apply(e: Emissive, p: number): void {
  const t = e.mat[e.channel];
  if (!t) return;
  const m = HALF_FLOAT_WRITE_MAX;
  t.setRGB(
    Math.min(e.base.r * p, m),
    Math.min(e.base.g * p, m),
    Math.min(e.base.b * p, m),
  );
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
  tracked.forEach((e) => apply(e, p));
}

/** How many emissive materials are tracked — for the `__lum` diagnostics. */
export const preExposedEmissiveCount = (): number => tracked.size;

/** Per-entry detail for `__lum.emissives()`: authored value and target channel. */
export function preExposedEmissiveRows(): {
  channel: Channel;
  type: string;
  base: [number, number, number];
  /** Rec709 luminance of the authored colour, in game units. */
  baseLuminance: number;
}[] {
  return Array.from(tracked, (e) => ({
    channel: e.channel,
    type: e.mat.type,
    base: [e.base.r, e.base.g, e.base.b] as [number, number, number],
    baseLuminance:
      0.2126 * e.base.r + 0.7152 * e.base.g + 0.0722 * e.base.b,
  }));
}
