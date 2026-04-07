import * as THREE from "three";
import {
  Fn,
  texture,
  uv,
  normalWorld,
  positionWorld,
  cameraPosition,
  vec3,
  vec4,
  float,
  dot,
  normalize,
  clamp,
  pow,
  sub,
  mix,
  length,
  smoothstep,
  Discard,
} from "three/tsl";
import {
  NEPTUNE_POSITION_KM,
  NEPTUNE_RADIUS_KM,
} from "@/sim/celestialConstants";
import type { CelestialBodyConfig } from "../types";

export { NEPTUNE_POSITION_KM, NEPTUNE_RADIUS_KM };

const NEPTUNE_ALBEDO = new THREE.Color(0.05, 0.12, 0.85);

// ─────────────────────────────────────────────────────────────────────
// Neptune fragment: ice giant with vivid blue from methane absorption.
// - Deepest blue of any planet -- strong methane red absorption
// - Dynamic atmosphere with visible bands and storms
// - Thick atmosphere -> soft terminator with light-wrap
// - Limb darkening + subtle haze brightening
// ─────────────────────────────────────────────────────────────────────

function buildNeptuneFragmentNode(
  colorTex: THREE.Texture,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any,
) {
  return Fn(() => {
    const uvCoord = uv();
    const sunDir = normalize(uSunRel);
    const albedo = texture(colorTex, uvCoord).rgb;

    const N = normalize(normalWorld);
    const NdotL = dot(N, sunDir);

    // Soft diffuse with atmospheric light-wrap (ice giant)
    const diffuse = clamp(NdotL.mul(0.8).add(0.2), 0, 1);

    // Limb darkening
    const viewDir = normalize(sub(cameraPosition, positionWorld));
    const viewDotN = dot(viewDir, N).max(0.05);
    const limbDark = pow(viewDotN, float(0.35));

    // Subtle atmospheric haze at limb (blue-tinted)
    const limb = clamp(float(1.0).sub(viewDotN).mul(2.0), 0, 1);
    const limbPow = pow(limb, float(3.0));
    const dayMask = clamp(NdotL.mul(2.0).add(0.5), 0, 1);
    const haze = vec3(0.3, 0.45, 0.75).mul(limbPow).mul(dayMask).mul(0.08);

    // Limb desaturation
    const col = albedo.mul(diffuse).mul(limbDark).add(haze).toVar();
    const lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    const desatAmount = limbPow.mul(0.15).mul(dayMask);
    col.assign(mix(col, vec3(lum, lum, lum), desatAmount));

    return vec4(col, 1.0);
  })();
}

// ── Custom billboard fragment (ice giant with limb darkening) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function neptuneBillboardFragment({ albedo, uSpR, uSpU, uSpF }: { albedo: THREE.Color; uSpR: any; uSpU: any; uSpF: any }) {
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
    const diffuse = clamp(sunDot.mul(0.8).add(0.2), 0, 1);
    const limbDark = pow(domeZ, float(0.35));

    const a = vec3(albedo.r, albedo.g, albedo.b);
    const col = a.mul(diffuse).mul(limbDark);

    return vec4(col, edge);
  })();
}

// ─────────────────────────────────────────────────────────────────────

export const neptuneConfig: CelestialBodyConfig = {
  id: "neptune",
  positionKm: NEPTUNE_POSITION_KM,
  radiusKm: NEPTUNE_RADIUS_KM,

  lod: { far: 12_000_000 },
  near: undefined,
  mid: { textures: { color: "/textures/neptune/2k_neptune.ktx2" }, segments: 64 },
  far: { albedo: NEPTUNE_ALBEDO, buildFragment: neptuneBillboardFragment },
  stellarPoint: { geometricAlbedo: 0.442, color: [0.42, 0.52, 0.90] },

  buildFragmentNode: ({ textures, uSunRel }) =>
    buildNeptuneFragmentNode(textures.color, uSunRel),
};
