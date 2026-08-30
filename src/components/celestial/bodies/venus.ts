import * as THREE from "three";
import {
  Fn,
  texture,
  uv,
  normalWorld,
  vec3,
  vec4,
  float,
  dot,
  normalize,
  clamp,
  length,
  smoothstep,
  Discard,
} from "three/tsl";
import {
  VENUS_POSITION_KM,
  VENUS_RADIUS_KM,
} from "@/sim/celestialConstants";
import { VENUS_ATMOSPHERE } from "./atmosphereData";
import { surfaceRadiance } from "@/components/space/photometry";
import type { CelestialBodyConfig } from "../types";

export { VENUS_POSITION_KM, VENUS_RADIUS_KM };

const VENUS_ALBEDO = new THREE.Color(0.70, 0.52, 0.28);

// ─────────────────────────────────────────────────────────────────────
// Venus fragment: thick sulfuric acid cloud blanket.
// - Visible "surface" is opaque cloud tops -- no terrain visible
// - Very high albedo (~0.77) -- brightest planet
// - Thick atmosphere -> very soft terminator with deep light-wrap
// - Warm yellowish-white palette from sulfuric acid clouds
// - Limb brightening/haze comes from the REAL atmosphere pass (Phase 5:
//   venusConfig.atmosphere) — the old shader fake was removed to avoid
//   double-counting. The billboard tier keeps its own look (the pass only
//   runs while the sphere LOD is visible).
// ─────────────────────────────────────────────────────────────────────

function buildVenusFragmentNode(
  colorTex: THREE.Texture,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunIlluminance: any,
  /** Pre-exposed sky irradiance at this fragment — the night-side term (Phase 9). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  skyAmbient: any,
  /** D34 star-disc visibility — scales the DIRECT term only (Phase 9). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  starVisibility: any,
) {
  return Fn(() => {
    const uvCoord = uv();
    const sunDir = normalize(uSunRel);
    const albedo = texture(colorTex, uvCoord).rgb;

    const N = normalize(normalWorld);
    const NdotL = dot(N, sunDir);

    // Soft diffuse with deep atmospheric light-wrap.
    // Venus's thick clouds scatter light well past the terminator.
    const diffuse = clamp(NdotL.mul(0.75).add(0.25), 0, 1);

    // Reflectance → RADIANCE: × sunIlluminance/π (docs/LIGHTING_PLAN.md §3.6).
    // Without this a body's brightness ignores its distance to the star —
    // measured 12.9× too bright on Neptune (defect D02/D03b).
    return vec4(surfaceRadiance(albedo.mul(diffuse), uSunIlluminance, albedo, skyAmbient, starVisibility), 1.0);
  })();
}

// ── Custom billboard fragment (Venus: soft diffuse, no limb darkening) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function venusBillboardFragment({ albedo, uSpR, uSpU, uSpF }: { albedo: THREE.Color; uSpR: any; uSpU: any; uSpF: any }) {
  return Fn(() => {
    const p = uv().mul(2).sub(1);
    const dist = length(p);

    const edge = smoothstep(float(1.0), float(0.92), dist);
    Discard(edge.lessThan(0.01));

    const domeZ = float(1.0).sub(dist.mul(dist)).max(0).sqrt();

    const sunDot = clamp(
      uSpR.mul(p.x).add(uSpU.mul(p.y)).add(uSpF.mul(domeZ)),
      -1, 1,
    );
    const diffuse = clamp(sunDot.mul(0.75).add(0.25), 0, 1);

    const a = vec3(albedo.r, albedo.g, albedo.b);
    const col = a.mul(diffuse);

    return vec4(col, edge);
  })();
}

// ─────────────────────────────────────────────────────────────────────

export const venusConfig: CelestialBodyConfig = {
  id: "venus",
  positionKm: VENUS_POSITION_KM,
  radiusKm: VENUS_RADIUS_KM,

  // Derived from the physical description in sol.json (Phase 5).
  atmosphere: VENUS_ATMOSPHERE,

  lod: { near: 50_000, far: 350_000 },
  near: { textures: { color: "/textures/venus/4k_venus.ktx2" }, segments: 128 },
  mid: { textures: { color: "/textures/venus/2k_venus.ktx2" }, segments: 48 },
  far: { albedo: VENUS_ALBEDO, buildFragment: venusBillboardFragment },
  stellarPoint: { geometricAlbedo: 0.689, color: [1.0, 0.97, 0.85] },

  buildFragmentNode: ({ textures, uSunRel, uSunIlluminance, skyAmbient, starVisibility }) =>
    buildVenusFragmentNode(textures.color, uSunRel, uSunIlluminance, skyAmbient, starVisibility),
};
