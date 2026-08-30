import * as THREE from "three";
import {
  Fn,
  texture,
  uv,
  normalWorld,
  positionWorld,
  cameraPosition,
  vec4,
  float,
  dot,
  normalize,
  clamp,
  pow,
  sub,
} from "three/tsl";
import { surfaceRadiance } from "@/components/space/photometry";

/**
 * Shared rocky/airless fragment node builder.
 *
 * Hard diffuse (no atmosphere), opposition surge, limb darkening.
 * Used by Io, Europa, Ganymede, and Callisto.
 */
export function buildRockyFragmentNode(
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
  surgeStrength = 0.10,
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
    const surge = pow(NdotH, float(3.0)).mul(surgeStrength).mul(diffuse);

    // Limb darkening
    const viewDotN = dot(viewDir, N).max(0.05);
    const limbDark = pow(viewDotN, float(0.25));

    const col = albedo.mul(diffuse.add(surge)).mul(limbDark);

    // Reflectance → RADIANCE: × sunIlluminance/π (docs/LIGHTING_PLAN.md §3.6).
    // Without this a body's brightness ignores its distance to the star —
    // measured 12.9× too bright on Neptune (defect D02/D03b).
    return vec4(surfaceRadiance(col, uSunIlluminance, albedo, skyAmbient, starVisibility), 1.0);
  })();
}
