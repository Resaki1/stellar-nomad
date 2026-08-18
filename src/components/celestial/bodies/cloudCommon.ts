import type * as THREE from "three";
import {
  uniform,
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
  // v = 0 at the NORTH pole. Matches `flipGeometryV` in CelestialBody.tsx — our
  // KTX2s are stored top-down (`KTXorientation: rd`) and three's KTX2Loader does
  // not compensate, so row 0 is north. This used to be `dirLocal.y.negate()`,
  // giving v = 1 at north, which sampled the map upside down — and an inverted
  // v on a sphere is a reflection through the equatorial plane, so it rendered
  // as an east-west MIRROR rather than as an upside-down globe. Ground and cloud
  // were mirrored in lockstep, which is why they stayed registered to each other
  // and the bug hid. Both flips must change together.
  const v = acos(clamp(dirLocal.y, -1, 1)).mul(float(1).div(PI));
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
  // Weather Map v2 (CLOUD_TYPES_PLAN Phase 1): the full RGBA control stack from
  // ONE texture sample, swizzled (never re-sampled). coverage/convectivity/
  // topHeight/cirrus = R/G/B/A. Auto-mipped like coverageAt (shell/far use).
  weatherAt: (dirLocal: Node) => WeatherSample;
};

export type WeatherSample = {
  coverage: Node; // R — low+mid cloud coverage 0-1 (raw; caller may lift)
  convectivity: Node; // G — type axis 0 layered … 1 convective
  topHeight: Node; // B — cloud-top altitude, normalized 0-1 over ~0-18 km
  cirrus: Node; // A — high-layer (Ci/Cs) coverage 0-1
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
    // ONE sample, swizzled 4 ways — separate texture() calls per channel would
    // compile to 4 samples (§4.1). Legacy (Blue Marble) maps only carry
    // meaningful .r; convectivity/topHeight/cirrus are only real in the v2 map.
    weatherAt: (dirLocal: Node) => {
      const t = texture(weatherMap, equirectDirToUv(dirLocal, uvOffset)) as Node;
      return { coverage: t.r, convectivity: t.g, topHeight: t.b, cirrus: t.a };
    },
  };
}

// ── Lighting magnitudes — SHARED with the volumetric marcher (earthClouds.ts
// imports these) so near/far brightness + colour agree at the crossfade. ──
// ✅ PHASE 2d CLOSED (2026-08-17): 0.45 → albedo/π = 0.7/π = 0.223, the physical
// anchor a Lambert cloud top wants. Not a look tweak — it MUST accompany
// SHELL_OPTICAL_PATH's correction to 60: that turns covered columns opaque (which
// is how cloud area comes back), and at the old 0.45 the tops then overshot to
// reflectance 0.749 against a real ceiling of ~0.70. MEASURED together on device
// (`__lum.disc`): cloud-top R settles at 0.479 ✅, disc albedo 0.0788 → 0.163,
// contrast 10.8× against the D23-corrected target of 11.4× ✅.
export const CLOUD_SUN_SCALE = 0.223; // = albedo/π. × sunIlluminance × T(cloud alt)
// ── Live override for the Phase-2d re-anchor (`__lum.setCloudSunScale`) ──────
// Physically this wants to be `albedo/π` = 0.7/π ≈ 0.223, i.e. HALF the shipped
// 0.45 (LIGHTING_PLAN Phase 2d). It has to move together with the shell's
// optical path: raising PATH to its physical value turns most covered columns
// opaque — which is how the missing cloud AREA comes back — and at 0.45 the
// cloud tops then overshoot (measured p98 reflectance 0.749 vs a real ~0.70).
// Runtime-only in BOTH consumers (farCloudLit here and the marcher's dense
// branch), nothing baked, so a plain uniform keeps near and far in lockstep.
export const uCloudSunScale = uniform(CLOUD_SUN_SCALE);
export function setCloudSunScale(scale: number): void {
  uCloudSunScale.value = scale;
}
export const getCloudSunScale = (): number => uCloudSunScale.value;
export const CLOUD_SKY_SCALE = 1.0; // × sky tint → ambient fill

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
 * - `sunCos`    : 0..1 Lambert cosine at the deck (lighting Phase 2b, D08).
 *                 Scales the DIRECT term only. A thick cloud deck is close to
 *                 Lambert in μ₀ near nadir: Chandrasekhar's conservative
 *                 semi-infinite reflection R = H(μ)H(μ₀)/(4(μ+μ₀)) gives
 *                 L/F = 1.06 / 0.55 / 0.21 at μ₀ = 1 / 0.5 / 0.2 — proportional
 *                 to μ₀ within ~6%, because H(μ₀)'s growth cancels against the
 *                 (μ+μ₀) denominator. Pass 1 for a deck you want flat-lit.
 * - `daylight`  : 0..1 sun-above-cloud-horizon gate (kills the night side).
 *                 A pure gate — the angular FALLOFF is `sunCos`, not this.
 * - `selfShadow`: 0..1, 1 = fully lit (e.g. 1 − k·cloudShadowMap).
 */
export function farCloudLit({
  sunIlluminance,
  sunT,
  skyColor,
  sunCos,
  daylight,
  selfShadow,
}: {
  sunIlluminance: Node;
  sunT: Node;
  skyColor: Node;
  sunCos: Node;
  daylight: Node;
  selfShadow: Node;
}): Node {
  const shadow = mix(float(FAR_SHADOW_FLOOR), float(1), clamp(selfShadow, 0, 1));
  const direct = sunIlluminance
    .mul(sunT)
    .mul(uCloudSunScale) // uniform, not the const — see setCloudSunScale
    .mul(shadow)
    .mul(clamp(sunCos, 0, 1));
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
