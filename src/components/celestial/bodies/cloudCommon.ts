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

/**
 * ── PERF ABLATION: the primary march loop (`__lum.cloudMarch(false)`) ────────
 * 1 = march, 0 = the loop breaks on iteration 1.
 *
 * ⚠⚠ THIS PRICES THE MARCH LOOP, **NOT** THE CLOUD PIPELINE, and conflating the two is
 * the mistake this dial exists to make impossible. The reconstruction and composite
 * passes have **zero data-dependent control flow** — `cloudReconstructionPass.ts` has no
 * `If`/`Loop`/`Discard` at all, and `buildCompositeFetch` unrolls its (2r+1)² taps at
 * graph-build time — so both run at full cost in the bypass arm. Tap budget at
 * 2438×1816: composite 25 × 4.43 Mpx = **110.7 M**, reconstruction 12 × 1.97 Mpx =
 * **23.6 M**, against the loop's 88–199 M. For the whole pipeline use
 * `CLOUD_ABLATE_DIAGNOSTIC` in SpaceRenderer instead.
 *
 * ✅ MEASURED 2026-09-08, and the tap argument was WRONG IN MAGNITUDE: the surviving
 * passes are only **9–28%** of the pipeline (0.99 / 1.43 / 2.22 ms at horizon_8 / earth_8 /
 * horizon_25), not the majority. The loop is **72–91%**. Keeping both dials was still the
 * right call — it turned the split into a measurement instead of an assumption — but do
 * not re-derive a ranking from tap counts. That has now been wrong three times here.
 * ⚠ Taps are not milliseconds — the loop's are 3D fetches into 128³/64³ volumes with
 * poor locality, the composite's a coherent 2D RGBA16F neighbourhood. The BSM was
 * mis-ranked this way twice, 3× wrong both times. Ablate; do not weigh taps.
 *
 * 🔑 Consumed as `mix(tStart − 1, tExit, uCloudActive)` at the loop's exit test ONLY.
 * `tExit` has three readers (`slabLen`/`lodCap`, the `pFar` coverage tap, and that exit
 * test); leaving the first two on the original keeps `lodCap`, `dtSkip`, all three
 * weather-map taps and the STBN dither BIT-IDENTICAL across arms. It is pure arithmetic
 * on an existing scalar, so it needs no new scope — and a `uniform.and(...)` in the
 * condition would have been WRONG: TSL `and` compiles to WGSL `&&`, which short-circuits,
 * so it would have skipped the hoisted coverage taps and silently changed the baseline.
 */
export const uCloudActive = uniform(1);
// Phase 0b probe radius, in KM OF ARC on the inner shell (CLOUD_SKIP_PLAN §5.6).
// Sets how wide a footprint the conservative topAlt bound is taken over, standing in for
// the mip level a real max-pyramid query would pick. 0 = exact (no offset taps).
export const uEnvProbeKm = uniform(0);
export function setEnvProbeRadiusKm(km: number): void {
  uEnvProbeKm.value = Math.max(0, km);
}
export function cloudEnvProbeKmLive(): number {
  return uEnvProbeKm.value as number;
}

/**
 * Conservative empty-space skip (docs/CLOUD_SKIP_PLAN.md §5). 1 = on, 0 = off.
 * ⚠ A pure PERF dial with a correctness invariant, NOT a quality dial: the skip only
 * advances through space a validated bound proves holds no cloud, so toggling it must
 * leave the image identical. `densePerRay` from `__lum.cloudIters()` is the control
 * (6.84 / 4.05 / 0 at earth_8 / horizon / up_8) — any drop means the bound leaks.
 */
export const uEmptySkip = uniform(1);
export function setCloudEmptySkip(on: boolean): void {
  uEmptySkip.value = on ? 1 : 0;
}
export function cloudEmptySkipLive(): boolean {
  return (uEmptySkip.value as number) > 0.5;
}

/**
 * Fraction of the empty-space skip that gets dithered away, in [0,1].
 * ⚠⚠ LOAD-BEARING FOR IMAGE QUALITY, not perf tuning. MEASURED 2026-09-14: the artifact
 * is the `dtFoot` clamp. Empty space is traversed in ceil(distance·perp / R) capped
 * skips, and `perp` is a function of the view ray's ANGLE alone ⇒ the integer boundaries
 * are SCREEN-FIXED concentric rings (6785 -> 6380 km, worst while moving).
 * 🔑 It must be dithered with a PER-PIXEL, ray-invariant value. Jittering each step with
 * the golden-ratio `stratJitter` FAILED (still visible at j = 1.0) because a
 * low-discrepancy sequence is built to have low variance when summed — the cumulative
 * distance converges to its mean and the boundaries do not move.
 * ✅ Safe by construction: this can only SHORTEN a skip, and a shorter skip is always
 * conservative. It costs ~uSkipJitter/2 of the skip's average reach.
 */
export const uSkipJitter = uniform(0.5);
let _skipJitterOverride = -1;
/** Per-frame altitude lerp (cloudFullscreenPass). Yields to a console override. */
export function setCloudSkipJitterAuto(f: number): void {
  uSkipJitter.value = _skipJitterOverride >= 0 ? _skipJitterOverride : f;
}
/** `__lum.cloudSkipJitter`. Negative restores the altitude lerp. */
export function setCloudSkipJitter(f: number): void {
  _skipJitterOverride = f < 0 ? -1 : Math.max(0, Math.min(1, f));
  if (_skipJitterOverride >= 0) uSkipJitter.value = _skipJitterOverride;
}
export function cloudSkipJitterLive(): number {
  return uSkipJitter.value as number;
}

/**
 * Scales the empty-space skip's FOOTPRINT cap, in (0,1]. Default 1.
 * 🔑 A DISCRIMINATOR, not a tuning knob, and deliberately one-sided: values below 1 make
 * `dtFoot` bind HARDER, which is always MORE conservative, so the test can never produce
 * an unsound skip. If the ring artifact intensifies as this shrinks and fades as it
 * approaches 1, then `dtFoot` owns the rings — it is the only term in the skip that is a
 * pure function of VIEW-RAY ANGLE, i.e. of screen position, which is the one thing that
 * can produce a screen-FIXED pattern while the clouds move past it.
 */
export const uSkipFootScale = uniform(1);
export function setCloudSkipFootScale(f: number): void {
  uSkipFootScale.value = Math.max(0.01, Math.min(1, f));
}
export function cloudSkipFootScaleLive(): number {
  return uSkipFootScale.value as number;
}

/**
 * 1 = dither ONLY the final skip of a ray (the one where `dtDescend < dtFoot`, i.e. the
 * one that actually lands near the possible-cloud region). 0 = dither every skip.
 *
 * 🔑 WHY THIS MIGHT RECOVER THE HORIZON. The ring dither must be RAY-INVARIANT to break
 * the banding, and a constant per-ray scale `s` makes crossing a gap take `D/(s·dtFoot)`
 * skips — E[1/s] > 1/E[s] by Jensen, so the cost compounds over EVERY skip. But the
 * intermediate skips run through provably empty space where the landing point cannot
 * alias anything; only the last one, which sets where stepping resumes before the cloud,
 * can. Dithering just that one pays Jensen ONCE per ray.
 * ❌ MEASURED 2026-09-14 AND REFUTED ON QUALITY — keep this 0. It IS faster (+0.35 /
 * +0.91 / +0.49 ms at earth_8 / horizon / up_8) and the rings come back clearly.
 * 🔑 The hypothesis was wrong in a specific way: intermediate skips traverse provably
 * empty space, so their landing points cannot alias DENSITY — but the rings are the COUNT
 * of capped segments, `ceil(distance·perp/R)`, and leaving intermediates deterministic
 * leaves that count deterministic. Dithering the last skip randomizes where stepping
 * RESUMES, not how many boundaries the ray crossed getting there.
 * ✅ Kept because it prices the ring fix: **0.91 ms at the worst pose** is what a
 * STRUCTURAL fix (removing the quantization) could claim. More dither never will.
 */
export const uSkipJitterFinalOnly = uniform(0);
export function setCloudSkipJitterFinalOnly(on: boolean): void {
  uSkipJitterFinalOnly.value = on ? 1 : 0;
}
export function cloudSkipJitterFinalOnlyLive(): boolean {
  return (uSkipJitterFinalOnly.value as number) > 0.5;
}
export function setCloudMarchActive(on: boolean): void {
  uCloudActive.value = on ? 1 : 0;
}
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
  skyIrradiance,
}: {
  sunIlluminance: Node;
  sunT: Node;
  skyColor: Node;
  sunCos: Node;
  daylight: Node;
  selfShadow: Node;
  /**
   * Phase 9: real sky IRRADIANCE at the cloud top, game units, pre-exposed —
   * starlight + the Milky Way, from the shared SH probe. `null` to omit.
   *
   * ⚠⚠ NOT the same thing as `skyColor`. `skyColor` is a DAYTIME blue-sky proxy
   * and is correctly gated to zero by `daylight`; this one must NOT be, because at
   * night it is the only light there is.
   */
  skyIrradiance?: Node | null;
}): Node {
  const shadow = mix(float(FAR_SHADOW_FLOOR), float(1), clamp(selfShadow, 0, 1));
  const direct = sunIlluminance
    .mul(sunT)
    .mul(uCloudSunScale) // uniform, not the const — see setCloudSunScale
    .mul(shadow)
    .mul(clamp(sunCos, 0, 1));
  const ambient = skyColor.mul(float(CLOUD_SKY_SCALE)).mul(float(FAR_AMBIENT_FRAC));
  const day = direct.add(ambient).mul(clamp(daylight, 0, 1));
  if (!skyIrradiance) return day;
  // ── Phase 9: the NIGHT term, deliberately OUTSIDE the `daylight` gate ──────
  // 🔑🔑 `clamp(daylight, 0, 1)` — a smoothstep on the sun's elevation — multiplied
  // EVERYTHING here to exactly zero on the night side. So the cloud shell drew
  // `vec4(0, alpha)` over the ground and, being `transparent`, ATTENUATED the
  // sky-lit surface behind it by (1 − alpha): a thick deck is alpha ≈ 0.998, i.e.
  // it removed ~600× of the only light the night side had. Clouds cover ~67% of
  // Earth, so "the night side is completely black" was mostly this.
  //
  // ⚠ Starlight does not switch off at night — it IS the night. Gating this by
  // `daylight` would reproduce the bug exactly.
  //
  // Convention matched to `CLOUD_SUN_SCALE = albedo/π = 0.223` (measured, above),
  // NOT to `surfaceRadiance`'s `×3/2/π`: a cloud's 0.70 is already a Lambert
  // reflectance, not a geometric albedo, so the 3/2 would double-count it.
  //
  // No meaningful double count with `ambient`: that term is the daytime sky and is
  // zero wherever this one matters. On the DAY side this adds ~1.2e-8 game units
  // to a cloud at ~0.5 — 2.4e-8 relative, i.e. nothing.
  return day.add(skyIrradiance.mul(uCloudSunScale));
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
