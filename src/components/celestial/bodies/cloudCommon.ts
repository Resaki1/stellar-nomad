import type * as THREE from "three";
import {
  float,
  mix,
  clamp,
  smoothstep,
  pow,
  atan,
  acos,
  fract,
  vec2,
  texture,
  PI,
} from "three/tsl";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

// =============================================================================
// Shared cloud helpers — PLANET-AGNOSTIC. The near field (volumetric marcher,
// earthClouds.ts), the far field (the flat 2D overlay today; a dedicated cloud
// shell in Phase 2), and future procedural / gas-giant planets all consume
// these, so the near↔far transition matches BY CONSTRUCTION and only the
// coverage SOURCE (texture vs procedural vs banded flow) changes per planet.
//
// See docs/CLOUD_REVIEW_2026-07.md ISSUE 2. Phase 1 (this file) extracts the
// far-cloud lighting + coverage→opacity mapping and applies them to the Earth
// overlay so its brightness/colour + area line up with the volumetric. Phase 2
// lifts the far field out of the surface shader into a shared cloud shell that
// calls these same functions.
// =============================================================================

// ── Equirect projection — the SINGLE source for direction → cloud-texture UV ──
// The volumetric marcher, the flat overlay, and the cloud shell must project a
// planet-local unit direction to the SAME (u,v) or their cloud features won't
// register with each other. This is the one definition; earthClouds had four
// inline copies. `dirLocal` is a unit vec3 in planet-model ("earth") space;
// `uvOffset` is the drift uniform (uCloudUvOffset). Math is unchanged from the
// old inline copies: u = atan2(z,−x)/2π wrapped, v = acos(−y)/π (equirect).
export function equirectDirToUv(dirLocal: Node, uvOffset: Node): Node {
  const u = fract(
    atan(dirLocal.z, dirLocal.x.negate()).mul(float(1).div(PI.mul(2))),
  );
  const v = acos(clamp(dirLocal.y.negate(), -1, 1)).mul(float(1).div(PI));
  return vec2(u, v).add(uvOffset);
}

// ── Cloud-field provider (per-planet coverage SOURCE seam) ──────────────────
// Decouples "where coverage comes from" (a texture for Earth, procedural noise
// for generated planets, banded flow for gas giants) from "how it's projected
// and lit". Both the far-field shell and (eventually) the marcher call
// coverageAt(dirLocal) → raw coverage in [0,1] (the value texClouds.r yields
// today). `dirLocal` is a UNIT vec3 in planet-model space. Phase 2 implements
// only the Earth texture backing; the config-level seam waits for a 2nd cloudy
// planet. See docs/CLOUD_REVIEW_2026-07.md ISSUE 2 Phase 2.
export type CloudFieldProvider = {
  coverageAt: (dirLocal: Node) => Node;
};

/**
 * Earth (and any equirect-texture planet) cloud-field backing: samples a 2D
 * equirect coverage texture via the shared projection. `uvOffset` is the drift
 * uniform (uCloudUvOffset) so the field animates in lockstep with the marcher.
 */
export function makeEquirectTextureField(
  weatherMap: THREE.Texture,
  uvOffset: Node,
): CloudFieldProvider {
  return {
    // AUTO-MIP (no forced .level(0)): the shell is a normal rasterized mesh with
    // correct UV derivatives, so hardware mipping gives a footprint-appropriate,
    // alias-free, softer sample from orbit — unlike the marcher (which forces
    // mip 0 because the ray-march's per-quad derivatives break auto-mip, case
    // study #2). Requires the cloud KTX2 to carry a mip chain (the convert script
    // generates one). A thin over-blurred line may appear at the equirect
    // anti-meridian seam (derivative discontinuity) — acceptable; fix with
    // analytic-derivative sampling only if visible.
    coverageAt: (dirLocal: Node) =>
      (texture(weatherMap, equirectDirToUv(dirLocal, uvOffset)) as Node).r,
  };
}

// ── Lighting magnitudes — SHARED with the volumetric marcher (earthClouds.ts
// imports these) so near/far brightness + colour agree at the crossfade. ──
export const CLOUD_SUN_SCALE = 0.6; // × sunIlluminance × T(cloud alt) ≈ 12 HDR sunlit
export const CLOUD_SKY_SCALE = 2.0; // × sky tint → ambient fill

// Cool-blue ambient sky tint (matches the marcher's fallback skyColor). A planet
// may pass its own; this is the default. Plain tuple (not a TSL node) so it can
// be reused across independent material graphs without node-ownership issues.
export const CLOUD_SKY_AMBIENT: readonly [number, number, number] = [0.3, 0.5, 1.0];

// Far-field lighting shape. A far cloud sheet has no per-voxel self-shadow or
// view-dependent phase (it's not a marched volume), so the marcher's
// `L = sun×(direct+ms) + sky×ambient` collapses to a single sun term (albedo-
// anchored by CLOUD_SUN_SCALE) modulated by a coarse self-shadow proxy, plus the
// sky ambient fill — same magnitudes as the marcher.
const FAR_SHADOW_FLOOR = 0.45; // darkest a self-shadowed far cloud base gets (× sun)
const FAR_AMBIENT_FRAC = 0.3; // fraction of the sky term that fills the far field

/**
 * Physically-consistent far-cloud lit colour (HDR, pre-tonemap). Planet-agnostic:
 * pass the body's sun illuminance + sky tint.
 * - `sunT`      : sun transmittance at cloud altitude (vec3; reddens at sunset —
 *                 the SAME LUT the marcher + sky sample, so the terminator matches).
 * - `daylight`  : 0..1 sun-above-cloud-horizon gate (kills the night side).
 * - `selfShadow`: 0..1, 1 = fully lit (e.g. 1 − k·cloudShadowMap).
 */
export function farCloudLit({
  sunIlluminance,
  sunT,
  skyColor,
  daylight,
  selfShadow,
}: {
  sunIlluminance: Node;
  sunT: Node;
  skyColor: Node;
  daylight: Node;
  selfShadow: Node;
}): Node {
  const shadow = mix(float(FAR_SHADOW_FLOOR), float(1), clamp(selfShadow, 0, 1));
  const direct = sunIlluminance.mul(sunT).mul(float(CLOUD_SUN_SCALE)).mul(shadow);
  const ambient = skyColor.mul(float(CLOUD_SKY_SCALE)).mul(float(FAR_AMBIENT_FRAC));
  return direct.add(ambient).mul(clamp(daylight, 0, 1));
}

// ── Coverage → apparent opacity ──
// The marcher lifts raw coverage with pow(COVERAGE_GAMMA) then Nubis-remap-erodes
// it by 3D noise; the far field reproduces the lifted-coverage curve so both
// render the SAME cloud AREA — no "the near clouds cover less than the far
// overlay" step through the crossfade band.
//
// The DEFAULT is deliberately GENTLE (near-identity: it keeps the generous orbit
// coverage the overlay shows today, only fading the very thinnest wisps). It is
// THE knob for the area match: raise LO/HI to tighten the far field toward the
// volumetric's more-eroded footprint, OR lower the marcher's erosion
// (earthClouds BASE_EROSION_K) to grow the volumetric toward the far field —
// see the ISSUE 2 note about which representation is the reference look.
export const COVERAGE_GAMMA = 0.6; // matches earthClouds `coverage = pow(raw, 0.6)`
export const COVERAGE_OPACITY_LO = 0.0;
export const COVERAGE_OPACITY_HI = 0.35;
export function coverageToOpacity(rawCoverage: Node): Node {
  const lifted = pow(clamp(rawCoverage, 0, 1), float(COVERAGE_GAMMA));
  return smoothstep(
    float(COVERAGE_OPACITY_LO),
    float(COVERAGE_OPACITY_HI),
    lifted,
  );
}
