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
  smoothstep,
  length,
  Discard,
} from "three/tsl";
import {
  MARS_POSITION_KM,
  MARS_RADIUS_KM,
} from "@/sim/celestialConstants";
import type { CelestialBodyConfig } from "../types";

export { MARS_POSITION_KM, MARS_RADIUS_KM };

const MARS_ROTATION = new THREE.Euler(0.0, 0.3 * Math.PI, 0.44 * Math.PI);
const MARS_ALBEDO = new THREE.Color(0.6, 0.3, 0.15);

// ─────────────────────────────────────────────────────────────────────
// Mars fragment node builder
//
// Physical considerations:
// - No oceans -> no specular water highlights
// - Extremely thin atmosphere (~1% of Earth) -> minimal Rayleigh scattering
// - Iron oxide dust gives warm reddish atmospheric haze at the limb
// - No night lights, no significant cloud layer
// - Subtle opposition surge (slight brightening at low phase angles)
// - Oren-Nayar-like diffuse for dusty rough surfaces
// ─────────────────────────────────────────────────────────────────────

function buildMarsFragmentNode(
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

    // Oren-Nayar approximation for dusty surface
    const diffuse = clamp(NdotL.mul(0.85).add(0.15), 0, 1);

    // Warm terminator band
    const terminatorMask = smoothstep(float(-0.05), float(0.3), NdotL)
      .mul(smoothstep(float(0.5), float(0.15), NdotL));
    const warmTint = vec3(1.0, 0.7, 0.45);

    // Atmospheric limb haze (warm dusty)
    const viewDir = normalize(sub(cameraPosition, positionWorld));
    const viewDotN = dot(viewDir, N).max(0.05);
    const limb = clamp(float(1.0).sub(viewDotN).mul(2.0), 0, 1);
    const limbPow = pow(limb, float(2.5));
    const hazeColor = vec3(0.75, 0.4, 0.2);
    const hazeDayMask = clamp(NdotL.mul(2.0).add(0.3), 0, 1);

    // Opposition surge
    const halfVec = normalize(sunDir.add(viewDir));
    const NdotH = dot(N, halfVec).max(0);
    const surge = pow(NdotH, float(4.0)).mul(0.08).mul(diffuse);

    // Compose
    const col = albedo.mul(diffuse).add(albedo.mul(surge)).toVar();

    // Terminator warmth
    col.assign(mix(col, col.mul(warmTint), terminatorMask.mul(0.2)));

    // Atmospheric limb haze (additive on lit side)
    col.addAssign(hazeColor.mul(limbPow).mul(hazeDayMask).mul(0.08));

    // Slight desaturation at extreme limb (dust extinction)
    const lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    const desatAmount = limbPow.mul(0.15).mul(hazeDayMask);
    col.assign(mix(col, vec3(lum, lum, lum), desatAmount));

    return vec4(col, 1.0);
  })();
}

// ── Custom billboard fragment (warm reddish-brown disc with dusty rim) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function marsBillboardFragment({ albedo, uSpR, uSpU, uSpF }: { albedo: THREE.Color; uSpR: any; uSpU: any; uSpF: any }) {
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

    const a = vec3(albedo.r, albedo.g, albedo.b);
    const col = a.mul(sunDot).toVar();

    // Warm dusty atmosphere rim on lit side
    const rimFactor = clamp(float(1.0).sub(domeZ).mul(2.5), 0, 1);
    const hazeColor = vec3(12.0, 0.1, 0.05);
    col.addAssign(hazeColor.mul(rimFactor).mul(sunDot).mul(0.2));

    return vec4(col, edge);
  })();
}

// ─────────────────────────────────────────────────────────────────────

export const marsConfig: CelestialBodyConfig = {
  id: "mars",
  positionKm: MARS_POSITION_KM,
  radiusKm: MARS_RADIUS_KM,
  rotation: MARS_ROTATION,

  lod: { near: 36_000, far: 800_000 },
  near: { textures: { color: "/textures/mars/8k_mars.ktx2" }, segments: 128 },
  mid: { textures: { color: "/textures/mars/2k_mars.ktx2" }, segments: 48 },
  far: { albedo: MARS_ALBEDO, buildFragment: marsBillboardFragment },
  stellarPoint: { geometricAlbedo: 0.170, color: [1.0, 0.36, 0.20] },

  buildFragmentNode: ({ textures, uSunRel }) =>
    buildMarsFragmentNode(textures.color, uSunRel),
};
