// ─────────────────────────────────────────────────────────────────────
// PHOTOMETRY — the engine's single, documented light scale.
//
// Read docs/LIGHTING_PLAN.md §3.1–§3.4 before changing anything here. This
// module is the ONE place the unit convention is defined; every brightness in
// the renderer is supposed to be expressible in terms of it.
//
// ── THE CONVENTION ───────────────────────────────────────────────────
//
//   1 game unit  ≈  6,038 cd/m²   (for a luminance / radiance quantity)
//   1 game unit  ≈  6,038 lux     (for an illuminance quantity)
//
// This is NOT a new scale. It is the scale the atmosphere pass has used since
// ATMOSPHERE_PLAN.md Phase 1, back-solved from its own anchor:
//
//   Extraterrestrial solar illuminance at 1 AU  ≈ 128,000 lux
//     (1361 W/m² × ~94 lm/W luminous efficacy of the solar spectrum above the
//      atmosphere; sources quote 126,600–128,000, so treat this as ±2%)
//   The derivation drives 1 AU from a 1 L☉ star at SUN_ILLUM_GAME_1AU = 21.2
//     game units.
//   ⇒ 1 game unit = 128,000 / 21.2 ≈ 6,038 lux
//
// Cross-check (independent, via the magnitude system rather than the anchor):
// the Moon's sub-solar nadir radiance comes out at p·E/π = 0.136 × 22.35/π =
// 0.968 units = 5,843 cd/m². Apparent magnitude −12.74 over the Moon's solid
// angle gives a DISC-AVERAGE of ~4,938 cd/m². Sub-solar exceeds disc-average
// for any limb-darkened body, so 18% high in that direction is the expected
// sign, and the two anchors agree to within their own uncertainty. ✅
//
// ── WHAT IS PRE-EXPOSED, AND WHY IT HAS TO BE ────────────────────────
//
// The sun's disc is 1.6e9 cd/m² ⇒ ~265,000 game units, which OVERFLOWS
// RGBA16F (max 65,504). An absolute-luminance pipeline is therefore impossible
// in half-float and pre-exposure is mandatory, not a stylistic choice. See
// LIGHTING_PLAN §3.2. Two consequences that are easy to get wrong:
//
//  1. The exposure CEILING is a numerical requirement, not only the
//     "keep space dark" aesthetic knob.
//  2. Do NOT clamp exposure to keep the sun in range (that would need
//     EV ≳ +1.7, which contradicts EV_MIN). Clamp the WRITTEN radiance
//     instead, and drive the sun's glare from its known flux rather than from
//     reading back a clipped buffer.
//
// PHASE 0 NOTE: exposure is applied ONCE in SpaceRenderer's post chain, not
// per-shader at the source. That is mathematically identical while nothing
// overflows, and today the brightest thing in the scene is Star.tsx's
// CORE_HDR = 4096. Source pre-exposure becomes necessary in Phase 3, when
// CORE_HDR goes to its physical value.
// ─────────────────────────────────────────────────────────────────────

import { float, uniform } from "three/tsl";
import { STAR_TEMP_K } from "@/sim/celestialConstants";

// ── The anchor ───────────────────────────────────────────────────────

/** Extraterrestrial solar illuminance at 1 AU, lux. ±2% (efficacy estimate). */
export const SOLAR_ILLUMINANCE_1AU_LUX = 128_000;

/**
 * Game-luminance units received at 1 AU from a 1 L☉ star.
 *
 * The canonical home of this constant (atmosphereData.ts imports it). Earth's
 * sky was hand-tuned against this value in ATMOSPHERE_PLAN Phase 1, so it is
 * load-bearing for the look — treat it as the definition of the scale rather
 * than a knob.
 */
export const SUN_ILLUM_GAME_1AU = 21.2;

/** lux per game unit ≈ 6,038. Illuminance quantities. */
export const LUX_PER_GAME_UNIT = SOLAR_ILLUMINANCE_1AU_LUX / SUN_ILLUM_GAME_1AU;

/** cd/m² per game unit ≈ 6,038. Luminance/radiance quantities — same number. */
export const NITS_PER_GAME_UNIT = LUX_PER_GAME_UNIT;

export const AU_KM = 1.495979e8;

// ── Unit conversions (for the __lum harness, dev overlays and reasoning) ──

export const gameUnitsToNits = (u: number): number => u * NITS_PER_GAME_UNIT;
export const nitsToGameUnits = (nits: number): number => nits / NITS_PER_GAME_UNIT;

/**
 * EV100 of a luminance, in the standard photographic sense (Filament / Unreal
 * convention: ISO S = 100, reflected-light meter calibration K = 12.5).
 *
 *   EV100 = log2(L · S / K) = log2(L · 8)      with L in cd/m²
 *
 * Reference points for this scene (see LIGHTING_PLAN §3.4): airglow −10.3,
 * Neptune's disc +7.3, full Moon +15.4, Earth sub-solar +17.1, sun disc +33.6.
 * That 44-stop span is the whole reason auto-exposure is hard here — Unreal's
 * default histogram covers 12.
 */
export const evFromNits = (nits: number): number => Math.log2(Math.max(nits, 1e-12) * 8);

export const evFromGameUnits = (u: number): number => evFromNits(gameUnitsToNits(u));

/** The exposure multiplier a physically based camera applies at a given EV100. */
export const exposureFromEV = (ev100: number): number => 1 / (1.2 * Math.pow(2, ev100));

/** Inverse of exposureFromEV. */
export const evFromExposure = (exposure: number): number =>
  Math.log2(1 / (1.2 * Math.max(exposure, 1e-30)));

// ── Sun illuminance: the per-frame, distance-correct driver ───────────

/**
 * Top-of-atmosphere solar illuminance at a body, in game units.
 *
 * THIS MUST BE CALLED PER FRAME, not cached per body. Bodies will orbit
 * (LIGHTING_PLAN §3.0), so `distanceKm` changes continuously and with it every
 * brightness on that body. Caching this is exactly the defect (D17) that the
 * Phase 0 refactor removed: it used to be baked at module load from a static
 * position, which froze Mercury and Neptune at identical illuminance.
 *
 * @param distanceKm      live body→star distance
 * @param luminositySun   star luminosity in solar units
 * @param trim            Unused in practice: the per-body illuminance trims were
 *                        deleted in Phase 2 and `AtmosphereParams` no longer has a
 *                        brightness knob (LIGHTING_PLAN §3.0 forbids per-body art
 *                        constants). Kept only so a future star with a genuinely
 *                        non-grey output has somewhere to go — do NOT reintroduce
 *                        per-planet tuning through it.
 */
export function sunIlluminanceAt(
  distanceKm: number,
  luminositySun = 1,
  trim = 1,
): number {
  const dAU = distanceKm / AU_KM;
  return (
    (SUN_ILLUM_GAME_1AU * luminositySun * trim) / Math.max(1e-12, dAU * dAU)
  );
}

/**
 * Mean disc radiance of a Lambertian-equivalent body at zero phase angle, in
 * game units — the reference the __lum harness asserts against.
 *
 *   L = p · E / π
 *
 * The `1/π` is the Lambertian BRDF normalisation, and dropping it is D02 (a
 * 6.37× error at Earth's orbit). If you are editing a surface shader and there
 * is no `/π` anywhere, that is the bug.
 */
export function discRadianceAtZeroPhase(
  geometricAlbedo: number,
  sunIlluminanceGameUnits: number,
): number {
  return (geometricAlbedo * sunIlluminanceGameUnits) / Math.PI;
}

/**
 * Sub-solar-point / geometric-albedo ratio for a Lambert sphere = **3/2**.
 *
 * ⚠ THIS FACTOR IS EASY TO DROP AND I DROPPED IT. `p·E/π` is a DISC-AVERAGED
 * quantity — geometric albedo is defined by the total flux the disc returns at
 * zero phase. A probe aimed at the SUB-SOLAR POINT samples the brightest point
 * on that disc, not its average.
 *
 * For a Lambert sphere of surface albedo A:
 *   • sub-solar nadir radiance  L = A·E/π   ⇒ reflectance R = A
 *   • geometric albedo          p = (2/3)A
 *   ⇒ R = 1.5·p
 *
 * So a perfectly Lambertian, perfectly calibrated body probed at its sub-solar
 * point reads **ratio 1.5 against `p·E/π`, not 1.0**. Limb-darkened and
 * backscattering surfaces read higher still (Venus' validated Monte Carlo gives
 * 1.15; the Moon's opposition surge pushes its true value well above that).
 */
/**
 * Illuminance a resolved-or-unresolved BODY delivers at the camera, game units.
 * The photometric quantity Phase 4 needs, shared by every impostor tier (D04/D06).
 *
 *     E_cam = p · Φ(α) · E_sun(d_sun) · (R / d_cam)²
 *
 * Derivation, so it can be checked rather than trusted: the disc's radiance is
 * `L = p·Φ·E_sun/π` and its solid angle from the camera is `Ω = π(R/d_cam)²`, so
 * `E_cam = L·Ω` and the two π's cancel. Φ is the phase function the caller already
 * computes (1 at opposition by the definition of geometric albedo).
 *
 * 🔑 WHY THIS EXISTS. `StellarPoint` normalised brightness to an arbitrary Jupiter
 * reference (`(flux / JUPITER_REF_FLUX) × REFERENCE_HDR`) and `useFarLOD` multiplies
 * albedo by `sunDot` with NO illuminance term at all. Two tiers of the same object on
 * two different scales is what makes the billboard→point handoff discontinuous. One
 * function, used by both, is the only way that discontinuity closes.
 *
 * ⚠⚠ MEASURED, AND THIS IS WHY IT IS NOT WIRED UP YET: for Jupiter at the module's own
 * reference geometry (p 0.538, R 69,911 km, 5.2 AU from the sun, 4.2 AU from the
 * camera) this gives **5.222e-9 game units = 3.15e-5 lux**. Converting that to the
 * sprite's radiance — `E_cam / (θ_h² · I)`, where θ_h is the sprite's angular half
 * extent and `I = 0.09315` is the exact flux integral of its `core + halo` profile —
 * yields `uBrightness = 1.156e-2` at 1783p against the shipped **12.0**. The stellar
 * point is **1,038× too bright at 1783p and 2,830× at 1080p**.
 *
 * ⚠ Note the RESOLUTION DEPENDENCE in those two numbers. The correct value scales as
 * 1/θ_h², because the sprite is a fixed 6 PIXELS across, so its solid angle shrinks as
 * resolution rises and its radiance must rise to conserve flux. `REFERENCE_HDR` is a
 * constant, so distant planets' flux currently depends on window size — the same
 * defect class as D31's metering and the star gate's σ bug.
 *
 * ⚠⚠ DO NOT WIRE ONE TIER WITHOUT THE OTHER. Correcting `StellarPoint` alone makes the
 * handoff discontinuity WORSE, because `useFarLOD` is still uncalibrated reflectance.
 * That is the Venus-trim cancellation trap from §5: two errors that cancel in one
 * scene and diverge everywhere else. Both tiers switch to this function in ONE change,
 * with `__lum.disc()` / a probe on a named body as the gate.
 */
export function bodyIlluminanceAtCamera(
  geometricAlbedo: number,
  phase: number,
  radiusKm: number,
  dSunKm: number,
  dCamKm: number,
): number {
  const eSun = SUN_ILLUM_GAME_1AU * (AU_KM / Math.max(dSunKm, 1)) ** 2;
  const rOverD = radiusKm / Math.max(dCamKm, 1);
  return geometricAlbedo * phase * eSun * rOverD * rOverD;
}

/**
 * Exact flux integral of `StellarPoint`'s sprite profile,
 * `core + halo = clamp((0.2−r)/0.2)^1.2 + 0.4·clamp((0.6−r)/0.6)^2.5`, over the disc
 * in units of the quad's half extent: `∫ f(r)·2πr dr`.
 *
 * Computed in closed form from Beta functions — `2π·0.2²·B(2,2.2) + 0.4·2π·0.6²·B(2,3.5)`
 * — rather than measured, so it cannot drift from the shader if either exponent
 * changes. ⚠ If you edit that profile, recompute this.
 */
export const STELLAR_POINT_PROFILE_INTEGRAL = 0.093146;

/**
 * Sprite radiance that makes a point source carry exactly `illuminanceGame`.
 *
 * `radiance = E / (θ_h² · I)` — the same flux-conservation shape `StarField` uses for
 * stars (`E / (2πσ²·Ω_pixel)`), which is validated to 0.999× on three named stars.
 * A stellar point IS a star-like sub-pixel source, so it should share the machinery
 * rather than carry a second, unvalidated derivation.
 *
 * @param angularHalfExtentRad the sprite's angular half extent, i.e. half of
 *   `(MIN_SCREEN_PX / bufferHeight) · fovRad`.
 */
export function stellarPointRadiance(
  illuminanceGame: number,
  angularHalfExtentRad: number,
): number {
  const t = Math.max(angularHalfExtentRad, 1e-12);
  return illuminanceGame / (t * t * STELLAR_POINT_PROFILE_INTEGRAL);
}

export const LAMBERT_SUBSOLAR_OVER_GEOMETRIC = 1.5;

/** Sub-solar-point radiance of a Lambert sphere — what a centre probe should see. */
export function subSolarRadianceLambert(
  geometricAlbedo: number,
  sunIlluminanceGameUnits: number,
): number {
  return (
    discRadianceAtZeroPhase(geometricAlbedo, sunIlluminanceGameUnits) *
    LAMBERT_SUBSOLAR_OVER_GEOMETRIC
  );
}

// ── The surface radiance helper (TSL) ────────────────────────────────

/**
 * Convert a reflectance (albedo × shading term, on the `[0,1]` scale every body
 * shader already produces) into RADIANCE in game units.
 *
 *   L = reflectance · E / π
 *
 * The `1/π` is the Lambertian BRDF normalisation and is the single most commonly
 * dropped factor in this class of bug. Use this instead of writing the multiply
 * by hand, so there is exactly one place the convention lives.
 *
 * ⚠ Pass the FULL reflectance, i.e. albedo × N·L (or whatever shading term the
 * body uses) — not the bare albedo. `E` is illuminance on a surface facing the
 * sun; the cosine belongs inside the reflectance.
 *
 * Before Phase 2 every body returned the reflectance directly as if it were
 * radiance, which made a body's brightness independent of its distance to the
 * star: measured 12.9× too bright on Neptune, and Mercury vs Neptune wrong by
 * 6,040× in principle. See docs/LIGHTING_PLAN.md §2.2.2.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function surfaceRadiance(reflectance: any, uSunIlluminanceNode: any): any {
  return reflectance.mul(uSunIlluminanceNode).mul(float(1 / Math.PI));
}

// ── Global exposure state ────────────────────────────────────────────
//
// Phase 0: fixed at 1.0, so the whole chain is a bit-exact no-op.
// Phase 1: a manual EV slider writes it.
// Phase 5: GPU histogram auto-exposure writes it, clamped to [EV_MIN, EV_MAX].

/**
 * Floor on metered EV100 — i.e. the MOST SENSITIVE the virtual eye may get.
 * Low EV = high exposure. Derived in LIGHTING_PLAN §3.4 from wanting magnitude-6
 * stars visible to a dark-adapted eye (which is the stated aesthetic goal), NOT
 * guessed. Deep-space background sits ~3 orders below a mag-6 star's per-pixel
 * equivalent luminance, so this does not produce grey mush.
 */
// −16 was derived as "a mag-6 star renders at middle grey" (1.15e-2 cd/m²).
// Lowered to −18 in Phase 5: the star PANORAMA's texels are dimmer than the
// magnitudes they stand for, so at −16 only the brightest few hundred showed
// (measured: brightest sampled texel rendered 0.051). −18 gives 4× more
// headroom → 0.20, and it only ever binds in near-total darkness.
export const EV_MIN = -18;

/** Ceiling on metered EV100 — stops a sub-solar Mercury being crushed. */
export const EV_MAX = 20;

/**
 * The metered EV100 that reproduces `exposure = 1`, i.e. exactly today's image.
 *
 *   exposure = 1/(1.2·2^EV) = 1  ⇒  EV = log2(1/1.2) = −0.263
 *
 * The Phase 0/1 neutral point. Keeping it named (rather than hardcoding −0.263)
 * makes it obvious that the pre-lighting-work look is an arbitrary spot on the
 * exposure axis, not a calibrated one.
 */
export const EV_NEUTRAL = evFromExposure(1);

/**
 * The shared exposure scalar, applied once in SpaceRenderer's post chain.
 * Everything that wants to know "what is the current exposure" reads this.
 *
 * ── HOW THE TWO INPUTS COMPOSE ───────────────────────────────────────
 *
 *   effective exposure = exposureFromEV(clamp(meteredEV, EV_MIN, EV_MAX)) · 2^compensation
 *
 * `meteredEV` is what the scene measures — fixed at EV_NEUTRAL in Phases 0–4,
 * written by the histogram in Phase 5. `compensation` is the artist/player knob
 * in STOPS, where +1 means twice as bright, matching the photographic convention
 * and Unreal's `ExposureCompensation`.
 *
 * Splitting them this way matters: a single "set the exposure" setter would be
 * overwritten by auto-exposure the moment Phase 5 lands, and the manual knob
 * would have to be rebuilt. This composes instead.
 */
export const uExposure = uniform(1);

// ── SOURCE PRE-EXPOSURE (§3.2, defect D25) ──────────────────────────────────
// The scene spans 44.6 stops; RGBA16F holds ~40 (smallest subnormal 2⁻²⁴ =
// 5.96e-8 → below that a value stores as EXACTLY zero; largest finite 65,504).
// So NO fixed calibration can seat both ends: the diffuse Milky Way underflowed
// (p50 9.6e-9) at the same time as the sun disc overflowed (265,000, hence the
// HALF_FLOAT_WRITE_MAX clamp). A STATIC scale cannot fix it either — putting the
// sky safely in the normals needs ×1e5, which sends sunlit Mercury (6 units) to
// 6e5 and straight over the ceiling. Measured, not guessed: 44.6 > 40.
//
// The fix is Frostbite's/UE's pre-exposure: multiply radiance by the current
// frame's exposure AT THE SOURCE, so the buffer holds display-referred values
// around [0.01, 100] and half-float precision is spent where the eye is looking.
// It works *because* exposure tracks the scene — a dark frame scales the sky up
// and has no sun in it; a frame with the sun in it has exposure ~0.05, and
// 265,000 × 0.05 = 13,250 sits comfortably inside range.
//
// ── WHY MULTIPLYING THE LIGHT SOURCES IS EQUIVALENT (and much safer) ─────────
// The render is LINEAR in its light sources, so scaling every source scales the
// image — no need to find every shader that writes radiance. The seams are the
// places an absolute photometric value ENTERS: `uSunIlluminance` (planets,
// atmosphere, clouds), the three.js light intensities (local scene), the skybox
// radiance, the star's core radiance, and emissives. That set is small and is
// already the "one authority" list Phases 2a/3 funnelled everything through.
//
// ⚠ Linearity is what makes it safe, so anything NON-linear in radiance must be
// checked. Audited: the atmosphere's spectral-transmittance `powVec3` operates on
// a TRANSMITTANCE (dimensionless, and stored in the AP target's alpha while
// radiance lives in rgb), the Henyey-Greenstein denominator is dimensionless, and
// the cloud shadow gamma is applied to a transmittance. None are radiance. The
// `(L, Tmean)` apply is `scene·a + rgb`, which stays uniformly pre-exposed as
// long as `a` is left alone.
//
// ⚠ THREE CONSUMERS MUST DIVIDE IT BACK OUT or they silently break:
//   1. the exposure meter — it reads the pre-exposed buffer, so without the
//      divide-out it meters its own output and runs away (positive feedback);
//   2. `__lum.probe` and everything built on it — otherwise every absolute
//      measurement in this document becomes meaningless;
//   3. temporal history (the cloud reconstruction) — it holds LAST frame's
//      pre-exposure, so it must be rescaled by preExpNow/preExpPrev on read.
export const uPreExposure = uniform(1);

// What the post chain multiplies by: `exposure / preExposure`. Exactly 1.0 once
// pre-exposure is live and nothing has moved mid-frame — the buffer is already
// display-referred. It is NOT redundant: the meter updates `_exposure` after the
// scaled scene has been rendered, so this carries the residual of that late
// change onto an already-written frame instead of dropping it.
export const uPostExposure = uniform(1);

let _meteredEV = EV_NEUTRAL;
let _compensationStops = 0;
let _exposure = 1;
let _preExposure = 1;
// ✅ PHASE 5: auto-exposure is now the default. `__lum` / `__bench` still pin it
// via setManualExposure(true) — they MUST, since adaptation is frame-to-frame
// state and an unpinned sweep measures a function of the previous frame.
let _manual = false;

function recompute(): void {
  const ev = Math.min(Math.max(_meteredEV, EV_MIN), EV_MAX);
  _exposure = exposureFromEV(ev) * 2 ** _compensationStops;
  uExposure.value = _exposure;
  uPostExposure.value = _exposure / _preExposure;
}

/** Current effective exposure multiplier. */
export const getExposure = (): number => _exposure;

/**
 * The factor every radiance SOURCE is multiplied by this frame (defect D25).
 * 1.0 means pre-exposure is disabled and buffers hold absolute game units.
 */
export const getPreExposure = (): number => _preExposure;

/**
 * Set this frame's source pre-exposure. Call ONCE per frame, at the top of the
 * frame BEFORE anything renders, so every source site in the frame agrees — a
 * split-brain frame (half the sources at the old value) is an internally
 * inconsistent image, which is the same failure mode as the Venus-trim
 * cancellation trap in §2.2.
 */
export function setPreExposure(preExposure: number): void {
  const next = preExposure > 0 && Number.isFinite(preExposure) ? preExposure : 1;
  uPreExposureRatio.value = next / _preExposure;
  _preExposure = next;
  uPreExposure.value = next;
  uPostExposure.value = _exposure / next;
}

/**
 * thisFrame's preExposure ÷ lastFrame's — the rescale any TEMPORAL buffer must
 * apply when reading its history (defect D25).
 *
 * The cloud reconstruction blends last frame's output with this frame's samples.
 * That history was written at the PREVIOUS pre-exposure, so when exposure moves,
 * the two sides of the blend are on different scales and the result is a flicker
 * that tracks the adaptation follower — worst exactly during the fast 0.25 s
 * brighten. Multiplying the history sample by this puts both sides on this
 * frame's scale. 1.0 whenever pre-exposure is steady or disabled.
 */
export const uPreExposureRatio = uniform(1);

/** Master switch for source pre-exposure. Flip to disable D25 wholesale. */
export const PRE_EXPOSURE_ENABLED = true;

let _preExposureOverride: number | null = null;

/**
 * Force a FIXED pre-exposure, for the invariance test (`__lum.preExposure(8)`).
 *
 * The whole design rests on one invariant: **the final image must not depend on
 * the pre-exposure**, because the post chain divides out exactly what the sources
 * multiplied in. So forcing an arbitrary factor and seeing the picture not move is
 * a complete check — and any site that was MISSED shows up immediately as a
 * region that brightens or darkens by that factor. That is a falsification test,
 * not an enumeration, which is the only way to be sure about a cross-cutting
 * change like this one. Pass null to hand control back to the exposure follower.
 */
export function setPreExposureOverride(factor: number | null): void {
  _preExposureOverride = factor;
}

export const getPreExposureOverride = (): number | null => _preExposureOverride;

/**
 * Pick this frame's pre-exposure. Call ONCE at the top of the frame, before
 * anything renders — see setPreExposure's note on split-brain frames.
 */
export function updatePreExposureForFrame(): void {
  if (!PRE_EXPOSURE_ENABLED) {
    setPreExposure(1);
    return;
  }
  setPreExposure(_preExposureOverride ?? _exposure);
}

/** Current metered EV100 (before compensation). */
export const getMeteredEV = (): number => _meteredEV;

/** Current exposure compensation, in stops (+1 = twice as bright). */
export const getExposureCompensation = (): number => _compensationStops;

/** True while exposure is driven manually (Phases 0–4, and the benchmarks). */
export const isManualExposure = (): boolean => _manual;

/**
 * Set the metered EV100 — the physically based camera's reading of the scene.
 * Phase 5's histogram calls this; `__lum` calls it to pin a known exposure.
 */
export function setMeteredEV(ev100: number): void {
  _meteredEV = ev100;
  recompute();
}

/**
 * Set exposure compensation in stops (+1 = twice as bright, −1 = half).
 * This is the Dev slider, and it survives into Phase 5 unchanged.
 */
export function setExposureCompensation(stops: number): void {
  _compensationStops = stops;
  recompute();
}

/** Set the effective exposure directly, via the metered EV. */
export function setExposure(exposure: number): void {
  setMeteredEV(evFromExposure(exposure / 2 ** _compensationStops));
}

/** @deprecated Use `setMeteredEV`. Kept so existing call sites keep working. */
export const setExposureEV = setMeteredEV;

/**
 * Pin exposure manually, or hand it back to auto-exposure (Phase 5).
 *
 * ⚠ `__lum` and `__bench` MUST pin exposure while sweeping. Auto-exposure is
 * frame-to-frame state, so an unpinned sweep measures a function of the
 * previous frame — the same class of mistake as the start-state contamination
 * documented in docs/PERF_MEASUREMENT.md.
 */
export function setManualExposure(manual: boolean): void {
  _manual = manual;
}

// ─────────────────────────────────────────────────────────────────────
// PHASE 3b — the star's own surface, and its colour
// ─────────────────────────────────────────────────────────────────────

/**
 * Mean luminance of the Sun's photosphere, cd/m². Distance-INDEPENDENT: a
 * surface's radiance does not fall off with range (only its solid angle does),
 * so this is the value the disc should carry from Mercury to Neptune alike.
 */
export const SUN_DISC_LUMINANCE_NITS = 1.6e9;

/**
 * The disc's radiance in game units — ≈265,000, i.e. **4.0× over RGBA16F's
 * 65,504 ceiling**. This is why the write clamp below is a NUMERICAL
 * requirement rather than an aesthetic one, and why `Star.tsx`'s old
 * `CORE_HDR = 4096` was 65× short of physical.
 */
export const SUN_DISC_RADIANCE_GAME =
  SUN_DISC_LUMINANCE_NITS / NITS_PER_GAME_UNIT;

/**
 * Largest value safe to WRITE into an RGBA16F target. Half-float's max finite
 * is 65,504; leaving headroom means an additive blend of disc + glow cannot tip
 * to `Inf`, which would poison every filter downstream (bloom's mip chain, TAA,
 * the half-res AP upsample) with NaN — the "one bad texel poisons a whole
 * square" failure mode.
 *
 * ⚠ Clipping here is invisible and that is the point: any exposure that renders
 * 60,000 as anything but flat white also renders 265,000 as flat white. Nothing
 * downstream may INFER the star's flux from this buffer — read
 * `SUN_DISC_RADIANCE_GAME` (or a per-star uniform) instead. Phase 8's glare
 * depends on that distinction.
 */
export const HALF_FLOAT_WRITE_MAX = 60_000;

/**
 * A star's radiance scaled so that a disc rendered at `renderedPx` conserves the
 * flux of a disc that truly subtends `truePx`.
 *
 * Below ~2 px a disc cannot be rasterised honestly: the fragment either samples
 * it or misses, so a physically bright core flickers violently frame to frame
 * (the risk `Star.tsx`'s original comment named when it settled for 4096). The
 * fix is the same one `StellarPoint` already uses — draw at a pixel floor and
 * divide the radiance by the area ratio, so the integrated flux is right even
 * though the shape is not.
 */
export function subPixelFluxScale(truePx: number, renderedPx: number): number {
  if (renderedPx <= 0) return 0;
  if (truePx >= renderedPx) return 1;
  const r = truePx / renderedPx;
  return r * r;
}

// ── Blackbody colour ─────────────────────────────────────────────────
// Planck's law integrated against the CIE 1931 colour-matching functions, then
// XYZ → linear sRGB. Replaces `Star.tsx`'s hardcoded `vec3(1, 0.95, 0.9)`, which
// only ever described a G2V star — a procedurally generated M-dwarf or B-star
// has to get its colour from its temperature or every generated system looks
// like Sol (§3.0). Analytic CMF fits: Wyman, Sloan & Shirley, JCGT 2013.

const xFit = (w: number) =>
  1.056 * g(w, 599.8, 37.9, 31.0) +
  0.362 * g(w, 442.0, 16.0, 26.7) -
  0.065 * g(w, 501.1, 20.4, 26.2);
const yFit = (w: number) =>
  0.821 * g(w, 568.8, 46.9, 40.5) + 0.286 * g(w, 530.9, 16.3, 31.1);
const zFit = (w: number) =>
  1.217 * g(w, 437.0, 11.8, 36.0) + 0.681 * g(w, 459.0, 26.0, 13.8);

/** Piecewise-Gaussian lobe: different falloff either side of the peak. */
function g(x: number, mu: number, s1: number, s2: number): number {
  const t = (x - mu) * (x < mu ? 1 / s1 : 1 / s2);
  return Math.exp(-0.5 * t * t);
}

/** Spectral radiance of a blackbody at wavelength `nm`, arbitrary scale. */
function planck(nm: number, tempK: number): number {
  const l = nm * 1e-9;
  const c1 = 3.7418e-16; // 2πhc²
  const c2 = 1.4388e-2; // hc/k
  return c1 / (Math.pow(l, 5) * (Math.exp(c2 / (l * tempK)) - 1));
}

/**
 * Blackbody temperature → linear sRGB, normalised so the **luminance is 1**.
 * That normalisation matters: the star's brightness comes from
 * `SUN_DISC_RADIANCE_GAME`, so this must contribute hue only, never magnitude.
 * Sol (5772 K) lands very close to the old hand-picked (1, 0.95, 0.9).
 */
export function blackbodyLinearSrgb(tempK: number): [number, number, number] {
  let X = 0;
  let Y = 0;
  let Z = 0;
  for (let nm = 380; nm <= 780; nm += 5) {
    const p = planck(nm, tempK);
    X += p * xFit(nm);
    Y += p * yFit(nm);
    Z += p * zFit(nm);
  }
  // Normalise on Y (luminance) so only chromaticity survives.
  if (Y <= 0) return [1, 1, 1];
  X /= Y;
  Z /= Y;
  Y = 1;
  // CIE XYZ (D65) → linear sRGB.
  const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const gg = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const b = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  // Clamp the out-of-gamut negatives a very hot/cool blackbody produces, then
  // re-normalise luminance (clamping changes it).
  const c: [number, number, number] = [
    Math.max(0, r),
    Math.max(0, gg),
    Math.max(0, b),
  ];
  const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return lum > 0 ? [c[0] / lum, c[1] / lum, c[2] / lum] : [1, 1, 1];
}

/**
 * The primary's colour as luminance-normalised linear sRGB — the ONE definition
 * every consumer of "sunlight" should multiply by (defect D18).
 *
 * ⚠ LUMINANCE-NORMALISED IS THE LOAD-BEARING PART. `blackbodyLinearSrgb` divides
 * out luminance, so this changes HUE ONLY: an illuminance of 21.2 game units
 * stays 21.2 after tinting, and the whole photometric calibration (§3.1) is
 * untouched. Multiplying by a non-normalised blackbody would silently rescale
 * every surface in the system.
 *
 * For Sol this is a ±10% warm nudge — (1.110, 0.976, 0.912), because 5772 K is
 * warmer than linear sRGB's D65 white point. It matters far more for generated
 * systems: a 3500 K M-dwarf is (1.553, 0.896, 0.405), and leaving the illuminant
 * grey there would light an orange star's planets stark white (§3.0).
 *
 * ⚠ KNOWN TENSION, deliberately resolved this way: the body textures are
 * PHOTOGRAPHS, so they are closer to "reflectance already white-balanced under
 * daylight" than to raw spectral reflectance — meaning a physical illuminant
 * arguably double-counts the sun's warmth. The choice here is to keep the
 * ILLUMINANT physical and leave viewer chromatic adaptation to the eye model
 * (Phase 7), which is where the real eye does it. Do NOT "fix" a warm cast by
 * greying this out; that would break every generated system.
 */
export const STAR_COLOR_LINEAR: readonly [number, number, number] =
  blackbodyLinearSrgb(STAR_TEMP_K);
