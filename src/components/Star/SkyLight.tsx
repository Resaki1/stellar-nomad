"use client";

import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { getPreExposure } from "@/components/space/photometry";
import { getStarLift } from "@/components/space/starVisibility";
import { getSkySh, getSkyShVersion } from "@/components/space/skyIrradiance";
import { getSkyEnvironmentNode } from "@/components/space/skySpecular";

/**
 * THE SKY AS A LIGHT — SH-L2 diffuse irradiance from the panorama + the 8,920-star
 * catalogue (S4, closes D29).
 *
 * Before this, an atmosphere-less umbra was pure black: the key light and its
 * bounce fill both derive from the sun and both vanish in shadow, so nothing lit
 * the hull. Now the hull picks up the real sky — brighter on the side facing the
 * galactic plane, dimmer facing a galactic pole, and correctly coloured, because
 * the coefficients carry each star's blackbody hue.
 *
 * ── WHY A `THREE.LightProbe` RATHER THAN CUSTOM SHADER WORK ──────────────────
 * `LightProbeNode` is registered in three's WebGPU node library
 * (`BasicNodeLibrary`: `addLight( LightProbeNode, LightProbe )`, verified in
 * 0.183.2), and it does exactly the right thing: `getShIrradianceAt(normalWorld, …)`
 * added into `context.irradiance`. So every standard material in the scene — hull,
 * asteroids, debris, modules — gets sky lighting with no per-material change and no
 * duplicated shader graph. Reuse over rebuild, and it is the same low-band diffuse
 * path Unity's ambient probe and Unreal's SkyLight use.
 *
 * ── UNITS: WHY `intensity` CARRIES THE PER-FRAME TERMS ───────────────────────
 * `skyIrradiance` bakes PHYSICAL radiance coefficients, so at `intensity = 1` the
 * probe delivers true irradiance in game units. The two per-frame display terms are
 * applied here instead:
 *
 *   • `uPreExposure` (D25) — mandatory, not cosmetic. The sky's contribution to the
 *     hull is ~5e-9 game units, and RGBA16F's smallest subnormal is 2⁻²⁴ ≈ 5.96e-8.
 *     Without pre-exposure this light would round to EXACTLY ZERO and the umbra
 *     would stay black for a completely different reason than before. A dark frame
 *     carries a pre-exposure of order 1e5, which lifts it into range.
 *   • the display lift (`starVisibility.getStarLift()`, was `SKY_ARTISTIC_GAIN`) —
 *     the hull must be lit by the sky the player can SEE. If the panorama renders
 *     1024× physical and the probe used 1×, a stunning Milky Way would sit above a
 *     hull it visibly fails to illuminate.
 *
 * 🔑 Keeping both OUT of the coefficients is what lets `__lum.skyProbe()` gate the
 * physics — the same discipline as the star gate.
 *
 * ⚠ `LightProbeNode.update()` reads `light.sh.coefficients[i] × light.intensity`
 * every frame, so writing the coefficients once and then only touching `intensity`
 * is sufficient and allocation-free.
 */
const SkyLight = () => {
  const ref = useRef<THREE.LightProbe>(null!);
  const copiedVersion = useRef(-1);
  // `useThree` here resolves to the LOCAL scene — the one holding the hull and the
  // other lit geometry, i.e. the scene whose materials read `environmentNode`.
  const scene = useThree((s) => s.scene) as THREE.Scene & {
    environmentNode?: unknown;
  };
  const envAssigned = useRef(false);

  useFrame(() => {
    // ── S4b: hand the captured sky cube to the materials ──────────────────────
    // Assigned once, when the capture lands. `MeshStandardNodeMaterial` wraps this
    // in an `EnvironmentNode`, which supplies BOTH specular radiance and diffuse
    // irradiance — hence the probe below stays at 0. See skySpecular.ts for why a
    // specular-only environment is not reachable without patching three.
    if (!envAssigned.current) {
      const env = getSkyEnvironmentNode();
      if (env) {
        scene.environmentNode = env;
        envAssigned.current = true;
      }
    }

    const probe = ref.current;
    if (!probe) return;
    const sh = getSkySh();
    if (!sh) {
      probe.intensity = 0;
      return;
    }
    // Copy only when a bake actually changed (load, then once per interstellar
    // jump) — `getSkySh` hands back a reused array, so a version check is enough
    // and the steady state does no per-frame work beyond one scalar write.
    const v = getSkyShVersion();
    if (copiedVersion.current !== v) {
      for (let i = 0; i < 9; i++) probe.sh.coefficients[i].copy(sh[i]);
      copiedVersion.current = v;
    }
    // ⚠ HELD AT ZERO ON PURPOSE (S4b). The environment above already supplies
    // diffuse irradiance; adding the probe as well would double-count it. The probe
    // is kept mounted and its coefficients kept current because it is the
    // REFERENCE `__lum.skyProbe()` compares the capture against — the SH is analytic
    // for point sources, so it is the only way to prove the 8,920 stars carry the
    // right flux through a rasterised cube face.
    //
    // 🔑 To go back to SH-driven diffuse (option B), this is the line to change,
    // together with suppressing `EnvironmentNode`'s `iblIrradiance` write.
    // ⚠⚠ R7b: `getStarLift()`, NOT `SKY_ARTISTIC_GAIN`. This file's own header states
    // the invariant — "the hull must be lit by the sky the player can SEE" — and the
    // band moved to the adaptation-driven lift, so leaving 1024 here would light the
    // hull by a sky 1024× brighter than the one on screen. Keeping them on one
    // symbol also makes `__lum.starLift('legacy')` a true one-switch revert across
    // sprites, band, promoted disc AND hull.
    //
    // ⚠ An earlier revision of this note warned that "auto" would drop the hull's
    // sky fill ~1024× in deep space. It does not any more: `STAR_LIFT_FLOOR` holds
    // the lift at the value `SKY_ARTISTIC_GAIN`'s hull-contrast table measured, so
    // deep space is unchanged from what shipped and the lift only ever ADDS. P7d —
    // whether real starlight alone keeps a hull visible — is now a question you can
    // ask deliberately with `__lum.starLift('off')` rather than one the default
    // answers for you.
    probe.intensity = envAssigned.current ? 0 : getStarLift() * getPreExposure();
  });

  return <lightProbe ref={ref} intensity={0} />;
};

export default SkyLight;
