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
  URANUS_POSITION_KM,
  URANUS_RADIUS_KM,
} from "@/sim/celestialConstants";
import type { CelestialBodyConfig } from "../types";

export { URANUS_POSITION_KM, URANUS_RADIUS_KM };

const URANUS_ALBEDO = new THREE.Color(0.35, 0.65, 0.70);

// ─────────────────────────────────────────────────────────────────────
// Uranus fragment: ice giant with methane atmosphere.
// - Featureless pale blue-green from methane absorption
// - Thick atmosphere -> soft terminator with light-wrap
// - Limb darkening from atmospheric scattering
// - Slight limb brightening on day side (forward scatter through haze)
// ─────────────────────────────────────────────────────────────────────

function buildUranusFragmentNode(
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

    // Subtle atmospheric haze at limb
    const limb = clamp(float(1.0).sub(viewDotN).mul(2.0), 0, 1);
    const limbPow = pow(limb, float(3.0));
    const dayMask = clamp(NdotL.mul(2.0).add(0.5), 0, 1);
    const haze = vec3(0.5, 0.65, 0.75).mul(limbPow).mul(dayMask).mul(0.06);

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
function uranusBillboardFragment({ albedo, uSpR, uSpU, uSpF }: { albedo: THREE.Color; uSpR: any; uSpU: any; uSpF: any }) {
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

export const uranusConfig: CelestialBodyConfig = {
  id: "uranus",
  positionKm: URANUS_POSITION_KM,
  radiusKm: URANUS_RADIUS_KM,

  lod: { near: 600_000, far: 12_000_000 },
  near: { textures: { color: "/textures/uranus/8k_uranus.ktx2" }, segments: 128 },
  mid: { textures: { color: "/textures/uranus/2k_uranus.ktx2" }, segments: 48 },
  far: { albedo: URANUS_ALBEDO, buildFragment: uranusBillboardFragment },
  stellarPoint: { geometricAlbedo: 0.488, color: [0.62, 0.82, 0.88] },

  buildFragmentNode: ({ textures, uSunRel }) =>
    buildUranusFragmentNode(textures.color, uSunRel),
};
