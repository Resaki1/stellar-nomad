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
  VENUS_POSITION_KM,
  VENUS_RADIUS_KM,
} from "@/sim/celestialConstants";
import type { CelestialBodyConfig } from "../types";

export { VENUS_POSITION_KM, VENUS_RADIUS_KM };

const VENUS_ALBEDO = new THREE.Color(0.70, 0.52, 0.28);

// ─────────────────────────────────────────────────────────────────────
// Venus fragment: thick sulfuric acid cloud blanket.
// - Visible "surface" is opaque cloud tops -- no terrain visible
// - Very high albedo (~0.77) -- brightest planet
// - Thick atmosphere -> very soft terminator with deep light-wrap
// - Pronounced limb brightening from forward-scattered sunlight
//   through the cloud deck (opposite of rocky planet limb darkening)
// - Warm yellowish-white palette from sulfuric acid clouds
// ─────────────────────────────────────────────────────────────────────

function buildVenusFragmentNode(
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

    // Soft diffuse with deep atmospheric light-wrap.
    // Venus's thick clouds scatter light well past the terminator.
    const diffuse = clamp(NdotL.mul(0.75).add(0.25), 0, 1);

    // Limb brightening: thick clouds forward-scatter sunlight at the limb,
    // making edges appear brighter on the lit side (opposite of airless bodies).
    const viewDir = normalize(sub(cameraPosition, positionWorld));
    const viewDotN = dot(viewDir, N).max(0.05);
    const limb = clamp(float(1.0).sub(viewDotN).mul(2.0), 0, 1);
    const limbPow = pow(limb, float(2.5));
    const limbDayMask = clamp(NdotL.mul(2.0).add(0.5), 0, 1);
    const limbBright = limbPow.mul(limbDayMask).mul(0.15);

    // Slight desaturation at limb (atmospheric scattering washes out color)
    const col = albedo.mul(diffuse).toVar();
    col.addAssign(vec3(0.72, 0.65, 0.50).mul(limbBright));

    const lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    const desatAmount = limbPow.mul(0.15).mul(limbDayMask);
    col.assign(mix(col, vec3(lum, lum, lum), desatAmount));

    return vec4(col, 1.0);
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

  lod: { near: 50_000, far: 350_000 },
  near: { textures: { color: "/textures/venus/4k_venus.ktx2" }, segments: 128 },
  mid: { textures: { color: "/textures/venus/2k_venus.ktx2" }, segments: 48 },
  far: { albedo: VENUS_ALBEDO, buildFragment: venusBillboardFragment },
  stellarPoint: { geometricAlbedo: 0.689, color: [1.0, 0.97, 0.85] },

  buildFragmentNode: ({ textures, uSunRel }) =>
    buildVenusFragmentNode(textures.color, uSunRel),
};
