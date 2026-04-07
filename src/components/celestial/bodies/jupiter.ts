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
  JUPITER_POSITION_KM,
  JUPITER_RADIUS_KM,
} from "@/sim/celestialConstants";
import type { CelestialBodyConfig } from "../types";

export { JUPITER_POSITION_KM, JUPITER_RADIUS_KM };

const JUPITER_ROTATION = new THREE.Euler(0.0, 0.4 * Math.PI, 0.055 * Math.PI);
const JUPITER_ALBEDO = new THREE.Color(0.65, 0.55, 0.40);

// ─────────────────────────────────────────────────────────────────────
// Jupiter fragment node builder
//
// Gas giant: deep thick atmosphere, pronounced limb darkening,
// warm tan/ochre ammonia clouds, soft terminator, subtle warm haze.
// ─────────────────────────────────────────────────────────────────────

function buildJupiterFragmentNode(
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

    // Soft diffuse with atmospheric light-wrap
    const diffuse = clamp(NdotL.mul(0.9).add(0.1), 0, 1);

    // Limb darkening
    const viewDir = normalize(sub(cameraPosition, positionWorld));
    const viewDotN = dot(viewDir, N).max(0.05);
    const limbDarkening = pow(viewDotN, float(0.4));

    // Warm atmospheric limb haze
    const limb = clamp(float(1.0).sub(viewDotN).mul(2.0), 0, 1);
    const limbPow = pow(limb, float(3.0));
    const hazeColor = vec3(0.7, 0.55, 0.35);
    const hazeDayMask = clamp(NdotL.mul(2.0).add(0.3), 0, 1);

    const col = albedo.mul(diffuse).mul(limbDarkening).toVar();

    // Atmospheric limb haze (additive on lit side)
    col.addAssign(hazeColor.mul(limbPow).mul(hazeDayMask).mul(0.06));

    // Slight desaturation at extreme limb
    const lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    const desatAmount = limbPow.mul(0.2).mul(hazeDayMask);
    col.assign(mix(col, vec3(lum, lum, lum), desatAmount));

    return vec4(col, 1.0);
  })();
}

// ── Custom billboard fragment (gas giant with limb darkening + haze) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jupiterBillboardFragment({ albedo, uSpR, uSpU, uSpF }: { albedo: THREE.Color; uSpR: any; uSpU: any; uSpF: any }) {
  return Fn(() => {
    const p = uv().mul(2).sub(1);
    const dist = length(p);

    const edge = smoothstep(float(1.0), float(0.92), dist);
    Discard(edge.lessThan(0.01));

    const domeZ = float(1.0).sub(dist.mul(dist)).max(0).sqrt();

    const sunDot = clamp(
      uSpR.mul(p.x).add(uSpU.mul(p.y)).add(uSpF.mul(domeZ)),
      0, 1,
    );

    // Limb darkening for the billboard
    const limbDark = pow(domeZ, float(0.4));

    const a = vec3(albedo.r, albedo.g, albedo.b);
    const col = a.mul(sunDot).mul(limbDark).toVar();

    // Subtle warm atmospheric rim on lit side
    const rimFactor = clamp(float(1.0).sub(domeZ).mul(2.5), 0, 1);
    const hazeColor = vec3(0.7, 0.55, 0.35);
    col.addAssign(hazeColor.mul(rimFactor).mul(sunDot).mul(0.06));

    return vec4(col, edge);
  })();
}

// ─────────────────────────────────────────────────────────────────────

export const jupiterConfig: CelestialBodyConfig = {
  id: "jupiter",
  positionKm: JUPITER_POSITION_KM,
  radiusKm: JUPITER_RADIUS_KM,
  rotation: JUPITER_ROTATION,

  lod: { near: 700_000, far: 16_000_000 },
  near: { textures: { color: "/textures/jupiter/8k_jupiter.ktx2" }, segments: 128 },
  mid: { textures: { color: "/textures/jupiter/2k_jupiter.ktx2" }, segments: 48 },
  far: { albedo: JUPITER_ALBEDO, buildFragment: jupiterBillboardFragment },
  stellarPoint: { geometricAlbedo: 0.538, color: [0.90, 0.83, 0.65] },

  buildFragmentNode: ({ textures, uSunRel }) =>
    buildJupiterFragmentNode(textures.color, uSunRel),
};
