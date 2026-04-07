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

    return vec4(col, 1.0);
  })();
}
