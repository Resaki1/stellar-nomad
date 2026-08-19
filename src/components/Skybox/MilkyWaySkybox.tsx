"use client";

import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useKTX2 } from "@/hooks/useKTX2";
import {
  NITS_PER_GAME_UNIT,
  getPreExposure,
} from "@/components/space/photometry";

// Whole-sky mean this panorama should emit, cd/m² — zodiacal light + integrated
// starlight seen from interplanetary space, no airglow.
const SKY_TARGET_NITS = 1e-4;
// Solid-angle-weighted mean linear luminance of 8k_stars_nasa.ktx2, measured.
// ⚠ Re-measure if the panorama is ever replaced; this is a property of the asset.
const SKY_TEXTURE_MEAN_LINEAR = 0.003137;
const SKY_RADIANCE_SCALE =
  SKY_TARGET_NITS / NITS_PER_GAME_UNIT / SKY_TEXTURE_MEAN_LINEAR;

type Props = {
  url?: string;
};

/**
 * Renders the star panorama as a large inverted sphere instead of scene.background.
 * This avoids issues with the WebGPU renderer's internal background caching
 * when using a cloned camera in a portal scene.
 */
export default function MilkyWaySkybox({
  url = "/assets/8k_stars_nasa.ktx2",
}: Props) {
  const tex = useKTX2(url);

  const [geometry, material] = useMemo(() => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;

    tex.needsUpdate = true;

    const geo = new THREE.SphereGeometry(1, 64, 32);
    // Flip faces inward so the texture is visible from inside
    geo.scale(-1, 1, 1);

    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      side: THREE.FrontSide,
      depthWrite: false,
      toneMapped: false,
    });
    // ── Absolute luminance (LIGHTING_PLAN Phase 5) ────────────────────────────
    // `map` alone means the texture's sRGB-decoded value WAS the radiance in game
    // units, i.e. the panorama was emitting a whole-sky mean of 0.0031 units =
    // **19 cd/m²**, when the real interplanetary background (zodiacal light +
    // integrated starlight) is ~1e-4 cd/m². That is ~189,000× too bright, and it
    // sat ~1,600× ABOVE a mag-6 star's per-pixel equivalent — so NO exposure
    // could ever show stars against it. This blocked §8's "stars brightly visible
    // unless something bright is in frame" outright, which is why the rescale was
    // promoted out of Phase 7 into Phase 5.
    //
    // DERIVED, not eyeballed: the scale is (target / NITS_PER_GAME_UNIT) ÷ the
    // texture's own SOLID-ANGLE-WEIGHTED mean linear luminance, measured off the
    // shipped KTX2 at 0.003137 (the sin θ weight matters — equirect rows shrink
    // toward the poles). It cross-checks against the independent in-engine probe
    // that measured 17.3 cd/m².
    //
    // ✅ Stars SURVIVE it. Measured on mip 1 (4096×2048), post-rescale: median sky
    // 5.8e-5 cd/m², p99.9 1.5e-3, brightest texel 3.1e-2 — a 530× contrast over
    // the background, with the brightest stars landing near a naked-eye mag 4–5.
    // (An earlier read off mip 4 suggested they would vanish; that was pure
    // mip-averaging of point sources. Measure point features at full resolution.)
    mat.color.setScalar(SKY_RADIANCE_SCALE);
    // ⚠⚠ KNOWN LIMITATION — the diffuse band currently stores as EXACTLY ZERO.
    // MEASURED: `__lum.probe()` on empty sky returns units [0,0,0]. Not dim —
    // zero. RGBA16F's smallest subnormal is 2^-24 = 5.96e-8, and the correctly
    // calibrated sky is p50 9.6e-9 / p90 2.8e-8 game units, i.e. BELOW it. The
    // panorama's stars (5.1e-6) survive; its nebulosity flushes to zero.
    //
    // This is the SAME defect as the sun disc overflowing the TOP of half-float
    // (Phase 3b's write clamp), now at the bottom: the buffer gives ~40 stops and
    // the scene spans 44.6. **Do NOT "fix" it by raising SKY_TARGET_NITS** — that
    // re-creates the original 189,000× error and turns deep space grey. The fix is
    // source PRE-EXPOSURE (§3.2): scale radiance by the adapted exposure at write
    // time and divide it out in the post chain, which works precisely because
    // exposure tracks the scene, so both ends of the range fit at any one time.
    // Until then: stars yes, Milky Way nebulosity no.

    return [geo, mat];
  }, [tex]);

  // ── D25: pre-expose the panorama every frame ──────────────────────────────
  // This is THE site the half-float floor bit: at the physically correct
  // SKY_RADIANCE_SCALE the diffuse band is 9.6e-9 game units against a smallest
  // subnormal of 5.96e-8, so it stored as exactly zero and the Milky Way had no
  // nebulosity at all — only the stars, which are 500× brighter, survived.
  //
  // A MeshBasicMaterial's colour is a CPU value set once at material creation,
  // so unlike the uniform-driven sites this one has to be re-written per frame.
  // It is a single scalar write; the material is not rebuilt.
  useFrame(() => {
    material.color.setScalar(SKY_RADIANCE_SCALE * getPreExposure());
  });

  // Render at a large radius within the scaled camera's far plane.
  // depthWrite=false ensures it never occludes other scaled objects.
  return (
    <mesh
      geometry={geometry}
      material={material}
      scale={[1_000_000, 1_000_000, 1_000_000]}
      frustumCulled={false}
      renderOrder={-1000}
    />
  );
}
