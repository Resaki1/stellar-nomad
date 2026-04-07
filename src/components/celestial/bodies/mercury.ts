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
} from "three/tsl";
import {
  MERCURY_POSITION_KM,
  MERCURY_RADIUS_KM,
} from "@/sim/celestialConstants";
import type { CelestialBodyConfig } from "../types";

export { MERCURY_POSITION_KM, MERCURY_RADIUS_KM };

// ─────────────────────────────────────────────────────────────────────
// Rocky/airless fragment node builder
//
// Hard diffuse (no atmosphere), opposition surge, limb darkening.
// ─────────────────────────────────────────────────────────────────────

function buildMercuryFragmentNode(
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

    // Hard diffuse -- no atmospheric scattering
    const diffuse = clamp(NdotL, 0, 1);

    // Opposition surge (Heiligenschein)
    const viewDir = normalize(sub(cameraPosition, positionWorld));
    const H = normalize(viewDir.add(sunDir));
    const NdotH = dot(N, H).max(0);
    const surge = pow(NdotH, float(3.0)).mul(0.12).mul(diffuse);

    // Limb darkening
    const viewDotN = dot(viewDir, N).max(0.05);
    const limbDark = pow(viewDotN, float(0.25));

    const col = albedo.mul(diffuse.add(surge)).mul(limbDark);

    return vec4(col, 1.0);
  })();
}

// ─────────────────────────────────────────────────────────────────────

export const mercuryConfig: CelestialBodyConfig = {
  id: "mercury",
  positionKm: MERCURY_POSITION_KM,
  radiusKm: MERCURY_RADIUS_KM,

  lod: { near: 50_000, far: 350_000 },
  near: { textures: { color: "/textures/mercury/8k_mercury.ktx2" }, segments: 128 },
  mid: { textures: { color: "/textures/mercury/2k_mercury.ktx2" }, segments: 48 },
  far: { albedo: new THREE.Color(0.35, 0.33, 0.30) },
  stellarPoint: { geometricAlbedo: 0.142, color: [0.78, 0.74, 0.70] },

  buildFragmentNode: ({ textures, uSunRel }) =>
    buildMercuryFragmentNode(textures.color, uSunRel),
};
