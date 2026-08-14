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

import { uniform } from "three/tsl";

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
 * @param trim            ⚠ TEMPORARY migration scaffold — see AtmosphereParams
 *                        .illuminanceTrim. Phase 2 deletes every non-1 value.
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
export const EV_MIN = -16;

/** Ceiling on metered EV100 — stops a sub-solar Mercury being crushed. */
export const EV_MAX = 20;

/**
 * The shared exposure scalar, applied once in SpaceRenderer's post chain.
 * Everything that wants to know "what is the current exposure" reads this.
 */
export const uExposure = uniform(1);

let _exposure = 1;
let _manual = true;

/** Current exposure multiplier. */
export const getExposure = (): number => _exposure;

/** True while exposure is driven manually (Phase 0/1, and the benchmarks). */
export const isManualExposure = (): boolean => _manual;

/** Set exposure directly. Clamped to the [EV_MAX, EV_MIN] exposure range. */
export function setExposure(exposure: number): void {
  const lo = exposureFromEV(EV_MAX);
  const hi = exposureFromEV(EV_MIN);
  _exposure = Math.min(Math.max(exposure, lo), hi);
  uExposure.value = _exposure;
}

/** Set exposure from a metered EV100 (the physically based camera model). */
export function setExposureEV(ev100: number): void {
  setExposure(exposureFromEV(ev100));
}

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
