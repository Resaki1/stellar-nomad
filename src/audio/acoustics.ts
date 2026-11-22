// ---------------------------------------------------------------------------
// PLANETARY ACOUSTICS — docs/AUDIO_PLAN.md §12.3.
//
// Derives the acoustic properties of a body's atmosphere from the SAME data the
// Rayleigh/Mie renderer already uses: `AtmosphereDef.surfacePressureBar`,
// `surfaceTemperatureK` and `composition` (mole fractions), plus the molar
// masses in `atmosphereData.ts`'s `GASES` table.
//
// 🔑 THE POINT (§12.4): no shipped game drives acoustics from a real per-body
// atmosphere model. Everyone else uses an authored in-atmosphere/vacuum switch,
// or ignores it. The inputs for the physical version were already sitting in
// this repo, built for the visuals.
//
// ⚠ WHAT THIS IS *NOT*: a level calibration. §12.1 rejects absolute-SPL
// calibration and adaptive master gain for three measured reasons. This module
// computes PROPAGATION — how sound is transformed between a source and the
// listener — and nothing about how loud a thing is authored to be.
// ---------------------------------------------------------------------------

import {
  allAtmosphereModels,
  atmosphereModel,
  densityAtAltitude,
  type AtmosphereModel,
} from "@/sim/atmosphere";

/** Earth sea-level reference density, kg/m³ — the yardstick for audibility. */
export const EARTH_SURFACE_DENSITY = 1.225;

/**
 * A body's acoustic atmosphere. The thermodynamics (molar mass, mixture γ via
 * Cp, hydrostatic H = RT/(Mg), ρ₀, c₀) moved to `src/sim/atmosphere.ts` so the
 * drive, exhaust and wind share one model; this alias keeps the audio API.
 */
export type AcousticAtmosphere = AtmosphereModel;

/** Acoustic properties of a body's atmosphere, or null if it is airless. */
export function acousticsForBody(bodyId: string): AcousticAtmosphere | null {
  return atmosphereModel(bodyId);
}

/** Every body that has an atmosphere. For the dev harness and the doc table. */
export function allAcoustics(): AcousticAtmosphere[] {
  return allAtmosphereModels();
}

export { densityAtAltitude };

/**
 * ACOUSTIC IMPEDANCE COUPLING — the amplitude multiplier for a world sound,
 * relative to the same source on Earth at sea level. 0 in vacuum.
 *
 * 🔑 THE CORRECT QUANTITY IS Z = ρ·c, NOT ρ ALONE. Radiated power from a
 * vibrating source couples through the medium's characteristic acoustic
 * impedance. Amplitude therefore scales with √(Z/Z_earth), i.e. level in dB is
 * `10·log10(Z/Z_earth)`.
 *
 * ⚠ AN EARLIER REVISION USED THE DENSITY RATIO AND WAS WRONG BY 1.7 dB ON MARS
 * (−18.9 vs the correct −20.6), because Mars' sound speed is also lower (228 vs
 * 340 m/s) and that compounds. Published Z values — Earth 407, Mars 4.4, Titan
 * 1186, Venus 26,960 kg/(m²·s) (Petculescu & Lueptow 2007) — are what this
 * reproduces; ours come out Earth 417, Mars 3.6, Venus 27,855 from our own
 * pressures and temperatures.
 *
 * ⚠ Clamped to ≤1. Venus' +18.2 dB is real physics, but §12.1's whole argument
 * is that level is authored for salience rather than derived: the physical model
 * is allowed to take loudness away and not to add it.
 *
 * Safe in vacuum with no epsilon: c stays finite as ρ→0, so the product → 0.
 */
export function impedanceCoupling(
  atm: AcousticAtmosphere | null,
  altitudeKm: number,
): number {
  if (!atm) return 0;
  const rho = densityAtAltitude(atm, altitudeKm);
  const z = rho * atm.surfaceSpeedOfSoundMps;
  const zEarth = EARTH_SURFACE_DENSITY * 340.4;
  return Math.min(1, Math.sqrt(z / zEarth));
}

// ---------------------------------------------------------------------------
// Frequency-dependent absorption
// ---------------------------------------------------------------------------

/** nepers/m → dB/m. Mixing these conventions is an invisible 8.686× error. */
const NP_TO_DB = 8.685889638;

/**
 * How much a body's absorption model is to be trusted. Logged by the dev
 * harness so a number's provenance is never guessed at.
 */
export type AbsorptionTier =
  /** ISO 9613-1 verbatim, inside its validated envelope. */
  | "standard"
  /** Fitted to published in-situ MEASUREMENTS of that body. */
  | "measured"
  /** Gas-agnostic classical (Stokes–Kirchhoff) physics only. */
  | "classical"
  /** No atmosphere. */
  | "vacuum";

/**
 * ISO 9613-1 / ANSI S1.26 absorption for EARTH AIR, dB/m.
 *
 * ⚠ VALID ONLY FOR AIR, 50 Hz–10 kHz, −20…+50 °C, 10–100% RH, ≈1 atm. Its two
 * relaxation terms are specifically the vibrational relaxation of O₂ and N₂
 * *catalysed by water vapour* — Mars has essentially none of those three, so
 * this must never be applied off Earth. That is the whole reason
 * `absorptionDbPerM` dispatches on composition.
 */
function iso9613(fHz: number, tempK: number, pressurePa: number, rhPercent: number): number {
  const T0 = 293.15;
  const T01 = 273.16;
  const prPa = 101325;
  const p = Math.max(1, pressurePa);
  const T = Math.max(1, tempK);

  const C = 4.6151 - 6.8346 * Math.pow(T01 / T, 1.261);
  const psat = prPa * Math.pow(10, C);
  const h = (rhPercent * psat) / p;

  const frO = (p / prPa) * (24 + (4.04e4 * h * (0.02 + h)) / (0.391 + h));
  const frN =
    (p / prPa) *
    Math.pow(T / T0, -0.5) *
    (9 + 280 * h * Math.exp(-4.17 * (Math.pow(T / T0, -1 / 3) - 1)));

  const f2 = fHz * fHz;
  const classical = 1.84e-11 * (prPa / p) * Math.pow(T / T0, 0.5);
  const relax =
    Math.pow(T / T0, -2.5) *
    (0.01275 * Math.exp(-2239.1 / T) * (frO / (frO * frO + f2)) +
      0.1068 * Math.exp(-3352.0 / T) * (frN / (frN * frN + f2)));
  return 8.686 * f2 * (classical + relax);
}

/**
 * Mars, fitted to IN-SITU MEASUREMENTS. nepers/m.
 *
 * 🔑 Maurice et al. 2022, *Nature* 605, "In situ recording of Mars soundscape"
 * — Perseverance's SuperCam used its own laser sparks as a known source at
 * 2–5 m and measured band-averaged α: **0.21±0.04 (3–6 kHz), 0.34±0.05
 * (6–11 kHz), 0.43±0.05 m⁻¹ (11–15 kHz)**.
 *
 * Model: `α(f) = C·f² + A·f_r·f²/(f_r² + f²)` — a classical f² term plus one
 * relaxation term at **f_r = 240 Hz**, the CO₂ vibrational relaxation frequency
 * that is *also* the direct cause of Mars having TWO sound speeds (γ falls from
 * 1.4 to 9/7 below f_r, so c drops from ~250 to ~240 m/s).
 *
 * ✅ **VALIDATED AGAINST A VALUE IT WAS NOT FITTED TO.** Least-squares on the
 * three measured bands alone gives C = 1.4061e-9, A = 8.5161e-4, fitting all
 * three within 0.68σ. Evaluated at 100 Hz that predicts **0.03025**, against
 * Petculescu & Lueptow's independent first-principles model (Icarus 186,
 * 2007) value of **0.030** — agreement to **0.8%** between an in-situ
 * measurement at 4.5–13 kHz and a theoretical model at 100 Hz, through two
 * fitted parameters. It also reproduces the paper's reported ~8 m audible range:
 * 20 dB of absorption alone arrives at **9.9 m** (Earth: 866 m).
 *
 * ⚠ Anchored at Mars' surface p,T. Scaling to other CO₂ worlds or to altitude
 * is NOT validated — see `absorptionDbPerM`.
 */
const MARS_C = 1.4061e-9;
const MARS_A = 8.5161e-4;
const MARS_FR_HZ = 240;

function marsAbsorptionNp(fHz: number): number {
  const f2 = fHz * fHz;
  return MARS_C * f2 + MARS_A * ((MARS_FR_HZ * f2) / (MARS_FR_HZ * MARS_FR_HZ + f2));
}

/**
 * Classical (Stokes–Kirchhoff) absorption, dB/m — the ONE term that is genuinely
 * gas-agnostic: `α = [2π²f²/(ρc³)]·[(4/3)η + (γ−1)κ/c_p]` nepers/m.
 *
 * ⚠ SIMPLIFIED. Rather than carrying per-gas viscosity and thermal conductivity
 * (which we would be extrapolating to 76 K and 737 K from room-temperature
 * handbook values anyway), this anchors on Earth air's measured classical term
 * and scales by the leading `1/(ρc³)` dependence. That captures the dominant
 * behaviour — and the dominant behaviour is counter-intuitive and worth stating:
 * **a thinner atmosphere ABSORBS MORE**, because α ∝ 1/ρ. Mars is the most
 * absorptive of the four modelled bodies partly for this reason alone, before
 * CO₂ relaxation is considered at all.
 *
 * ⚠ TIER: "classical". Not validated against planetary-acoustics literature for
 * H₂/He giants — no such literature was found. Treated as physics-shaped
 * extrapolation, not as a citation.
 */
function classicalAbsorptionNp(
  fHz: number,
  atm: AcousticAtmosphere,
  altitudeKm: number,
): number {
  const rho = Math.max(1e-12, densityAtAltitude(atm, altitudeKm));
  const c = atm.surfaceSpeedOfSoundMps;
  // Earth air reference: the classical part of ISO 9613-1 at 1 atm, 293 K.
  const refRhoC3 = EARTH_SURFACE_DENSITY * Math.pow(340.4, 3);
  const EARTH_CLASSICAL_NP = 1.84e-11 / NP_TO_DB;
  return EARTH_CLASSICAL_NP * fHz * fHz * (refRhoC3 / (rho * c * c * c));
}

export type AbsorptionResult = { dbPerM: number; tier: AbsorptionTier };

/**
 * Absorption at a frequency, for a body, at an altitude. dB per metre.
 *
 * Dispatches on composition, because no single model covers all of these:
 *
 * | Atmosphere | Model | Tier |
 * |---|---|---|
 * | O₂-bearing (Earth-like) | ISO 9613-1 verbatim | `standard` |
 * | CO₂-dominated (Mars, Venus) | measured Mars fit, pressure-scaled | `measured` |
 * | anything else (H₂/He, N₂/CH₄) | classical only | `classical` |
 * | none | — | `vacuum` |
 *
 * ⚠ THE CO₂ PRESSURE SCALING IS INTERPOLATION, NOT PHYSICS. The relaxation
 * frequency scales linearly with pressure (standard for collision-induced
 * relaxation), but the amplitude is anchored at Mars' 636 Pa / 210 K and applied
 * to Venus' 9.2 MPa / 737 K — a 14,000× pressure and 3.5× temperature
 * extrapolation. Venus' true absorption is genuinely different in character (its
 * relaxation bump sits up in the MHz range because it is so hot). Marked
 * `measured` only for Mars-like conditions; treat Venus as indicative.
 */
export function absorptionDbPerM(
  atm: AcousticAtmosphere | null,
  fHz: number,
  altitudeKm: number,
): AbsorptionResult {
  if (!atm) return { dbPerM: 0, tier: "vacuum" };

  const rhoRatio = densityAtAltitude(atm, altitudeKm) / atm.surfaceDensityKgM3;
  const localPa = atm.surfacePressurePa * rhoRatio;

  // Earth-like: O2 present in quantity means ISO's chemistry actually applies.
  const o2 = atm.dominantGas === "n2" ? 1 : 0;
  if (o2 && localPa > 1e3) {
    // RH is not in the composition data, so it is a fixed assumption. 50% sits
    // mid-range of ISO's 10-100% validity window; 0% would push frN into a
    // physically odd corner.
    return {
      dbPerM: iso9613(fHz, atm.surfaceTemperatureK, localPa, 50),
      tier: "standard",
    };
  }

  if (atm.dominantGas === "co2") {
    // Relaxation frequency scales with pressure; amplitude with density.
    const np = marsAbsorptionNp(fHz) * rhoRatio;
    return { dbPerM: np * NP_TO_DB, tier: "measured" };
  }

  return {
    dbPerM: classicalAbsorptionNp(fHz, atm, altitudeKm) * NP_TO_DB,
    tier: "classical",
  };
}

/**
 * Speed of sound at altitude, m/s.
 *
 * Isothermal, so this is currently constant with altitude — c depends on
 * temperature, not pressure, and the model has one temperature per body. Real
 * atmospheres cool with height (Earth: 340 m/s at sea level, ~295 m/s in the
 * stratosphere), so this is a known simplification rather than an oversight. It
 * matters for flash-to-bang delay over tens of kilometres and not much else.
 */
export function speedOfSoundAtAltitude(atm: AcousticAtmosphere | null): number {
  return atm ? atm.surfaceSpeedOfSoundMps : 0;
}

// ---------------------------------------------------------------------------
// The runtime entry point
// ---------------------------------------------------------------------------

/** Cumulative absorption at which a band is considered gone. */
const CUTOFF_LOSS_DB = 12;

/** No filtering above this — beyond hearing anyway. */
const MAX_CUTOFF_HZ = 20000;
/** Fully muffled floor. Below this the sound is a rumble and the filter stops mattering. */
const MIN_CUTOFF_HZ = 120;

export type Propagation = {
  /** Amplitude multiplier from impedance coupling. 0 in vacuum. */
  gain: number;
  /** Lowpass corner, Hz. MAX_CUTOFF_HZ means "no meaningful absorption". */
  cutoffHz: number;
  tier: AbsorptionTier;
};

const VACUUM: Propagation = { gain: 0, cutoffHz: MIN_CUTOFF_HZ, tier: "vacuum" };

/**
 * Everything the voice layer needs for one AIR-COUPLED world emitter: how much
 * quieter, and how much duller.
 *
 * ⚠⚠ ONLY FOR `coupling: "air"` EVENTS. A contact-coupled sound (you hit the
 * rock; your laser is cutting it) arrives through the hull and must NOT be
 * touched by any of this — see the `coupling` field in `audioEvents.ts`.
 * Applying it to everything is how a physically-correct game becomes a silent,
 * dull one (§12.4's Elite Dangerous lesson).
 *
 * The cutoff is found by bisection on "where does cumulative absorption over
 * this distance reach CUTOFF_LOSS_DB". Monotonic in f, so ~11 iterations is
 * exact to well under a semitone — and it runs at 15 Hz, not per sample.
 */
export function propagationFor(
  atm: AcousticAtmosphere | null,
  altitudeKm: number,
  distanceM: number,
): Propagation {
  if (!atm) return VACUUM;

  const gain = impedanceCoupling(atm, altitudeKm);
  if (gain <= 0) return VACUUM;

  const d = Math.max(0, distanceM);
  const tier = absorptionDbPerM(atm, 1000, altitudeKm).tier;
  if (d < 0.5) return { gain, cutoffHz: MAX_CUTOFF_HZ, tier };

  // Cheap rejects before bisecting.
  if (absorptionDbPerM(atm, MAX_CUTOFF_HZ, altitudeKm).dbPerM * d <= CUTOFF_LOSS_DB)
    return { gain, cutoffHz: MAX_CUTOFF_HZ, tier };
  if (absorptionDbPerM(atm, MIN_CUTOFF_HZ, altitudeKm).dbPerM * d >= CUTOFF_LOSS_DB)
    return { gain, cutoffHz: MIN_CUTOFF_HZ, tier };

  let lo = MIN_CUTOFF_HZ;
  let hi = MAX_CUTOFF_HZ;
  for (let i = 0; i < 11; i++) {
    const mid = Math.sqrt(lo * hi); // geometric — frequency is perceived in octaves
    if (absorptionDbPerM(atm, mid, altitudeKm).dbPerM * d < CUTOFF_LOSS_DB) lo = mid;
    else hi = mid;
  }
  return { gain, cutoffHz: lo, tier };
}
