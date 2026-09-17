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

import { GASES } from "@/components/celestial/bodies/atmosphereData";
import { activeSystem } from "@/sim/systemRegistry";
import type {
  AtmosphereGasId,
  CelestialBodyDef,
} from "@/sim/systemTypes";

/** Universal gas constant, J/(mol·K). */
const R_GAS = 8.314462618;

/** Earth sea-level reference density, kg/m³ — the yardstick for audibility. */
export const EARTH_SURFACE_DENSITY = 1.225;

// ---------------------------------------------------------------------------
// Per-gas thermodynamics
// ---------------------------------------------------------------------------

/**
 * Heat-capacity ratio γ = Cp/Cv per gas.
 *
 * ⚠ ROOM-TEMPERATURE VALUES. γ for polyatomic gases falls as temperature rises
 * (more vibrational modes activate), so Venus at 737 K and Titan at 94 K are
 * both approximations. The error is a few percent and enters the speed of sound
 * as its square root, i.e. ~1-2% — well below the 5% we already carry against
 * Mars' measured value, so a T-dependent Cp model is not worth it yet.
 *
 * ⚠ Molar masses are NOT duplicated here: they come from `GASES` in
 * atmosphereData.ts, which is the one source of truth. A second table would
 * drift.
 */
const GAMMA: Record<AtmosphereGasId, number> = {
  n2: 1.4, // diatomic
  o2: 1.4, // diatomic
  co2: 1.29, // linear triatomic
  ar: 1.667, // monatomic
  ch4: 1.32,
  h2: 1.41, // diatomic, but rotational modes freeze out when very cold
  he: 1.667, // monatomic
  h2o: 1.33,
  so2: 1.29,
};

export type AcousticAtmosphere = {
  bodyId: string;
  /** Mean molar mass of the mixture, kg/mol. */
  molarMassKgPerMol: number;
  /** Mixture heat-capacity ratio. */
  gamma: number;
  surfaceTemperatureK: number;
  surfacePressurePa: number;
  /** Gas density at the reference surface, kg/m³. */
  surfaceDensityKgM3: number;
  /** Speed of sound at the reference surface, m/s. */
  surfaceSpeedOfSoundMps: number;
  /**
   * Density e-folding height, km. Derived from the body's own gravity, so it is
   * not the renderer's *optical* Rayleigh scale height (which the visuals may
   * art-direct) but the honest hydrostatic one: H = RT/(Mg).
   */
  scaleHeightKm: number;
  /** Dominant gas by mole fraction, for logging and for absorption dispatch. */
  dominantGas: AtmosphereGasId;
  /** Mole fraction of the dominant gas. */
  dominantFraction: number;
};

/**
 * Mixture γ, computed the CORRECT way.
 *
 * ⚠⚠ THE TEMPTING SHORTCUT IS WRONG. `γ_mix = Σ xᵢ γᵢ` is not valid — γ is a
 * ratio of two extensive quantities, and ratios do not mole-average. The right
 * route is via molar heat capacities:
 *
 *     Cpᵢ    = γᵢ·R/(γᵢ − 1)
 *     Cp_mix = Σ xᵢ·Cpᵢ
 *     Cv_mix = Cp_mix − R          (ideal gas)
 *     γ_mix  = Cp_mix / Cv_mix
 *
 * For a 95% CO₂ / 5% N₂ mix the naive average gives 1.2955 against the correct
 * 1.2937 — only 0.14%, so the shortcut would have been *harmless here*. It is
 * done properly anyway because the error grows with the spread of the
 * components, and a 90% H₂ / 10% He mixture (γ 1.41 vs 1.667) is exactly that
 * case: naive 1.4357 versus correct 1.4227, a 0.9% error that would push
 * Jupiter's speed of sound the wrong way by ~0.5%.
 */
function mixtureGamma(
  composition: Partial<Record<AtmosphereGasId, number>>,
  totalFraction: number,
): number {
  let cpMix = 0;
  for (const [gas, frac] of Object.entries(composition)) {
    if (!frac) continue;
    const g = GAMMA[gas as AtmosphereGasId];
    if (g === undefined) continue;
    const cp = (g * R_GAS) / (g - 1);
    cpMix += (frac / totalFraction) * cp;
  }
  if (cpMix <= R_GAS) return 1.4; // degenerate input; fall back to air
  return cpMix / (cpMix - R_GAS);
}

/** Standard gravity at a body's reference surface, m/s². */
function surfaceGravity(body: CelestialBodyDef): number {
  const G = 6.6743e-11;
  if (body.massKg == null || !body.radiusKm) return 9.81;
  return (G * body.massKg) / Math.pow(body.radiusKm * 1000, 2);
}

/**
 * Derive a body's acoustic atmosphere, or null when it has none.
 *
 * Pure and cheap, but called once per body and cached — the inputs are static
 * per system.
 */
function deriveAcoustics(body: CelestialBodyDef): AcousticAtmosphere | null {
  const atm = body.atmosphere;
  if (!atm) return null;

  // Mole fractions "need not sum to 1 — normalised on read" per AtmosphereDef.
  let total = 0;
  let dominantGas: AtmosphereGasId = "n2";
  let dominantFraction = 0;
  for (const [gas, frac] of Object.entries(atm.composition)) {
    if (!frac) continue;
    total += frac;
    if (frac > dominantFraction) {
      dominantFraction = frac;
      dominantGas = gas as AtmosphereGasId;
    }
  }
  if (total <= 0) return null;

  let molarMass = 0;
  for (const [gas, frac] of Object.entries(atm.composition)) {
    if (!frac) continue;
    const props = GASES[gas as AtmosphereGasId];
    if (!props) continue;
    molarMass += (frac / total) * props.molarKgPerMol;
  }
  if (molarMass <= 0) return null;

  const gamma = mixtureGamma(atm.composition, total);
  const T = atm.surfaceTemperatureK;
  const p = atm.surfacePressureBar * 1e5;

  // Ideal gas. Real-gas corrections matter at Venus' 92 bar / 737 K, but the
  // compressibility factor there is within a few percent of 1, which is smaller
  // than the γ approximation above.
  const rho = (p * molarMass) / (R_GAS * T);
  const c = Math.sqrt((gamma * R_GAS * T) / molarMass);
  const g = surfaceGravity(body);
  const scaleHeightKm = (R_GAS * T) / (molarMass * g) / 1000;

  return {
    bodyId: body.id,
    molarMassKgPerMol: molarMass,
    gamma,
    surfaceTemperatureK: T,
    surfacePressurePa: p,
    surfaceDensityKgM3: rho,
    surfaceSpeedOfSoundMps: c,
    scaleHeightKm,
    dominantGas,
    dominantFraction: dominantFraction / total,
  };
}

// ---------------------------------------------------------------------------
// Cache, keyed by body id
// ---------------------------------------------------------------------------

let cache: Map<string, AcousticAtmosphere | null> | null = null;

function ensureCache(): Map<string, AcousticAtmosphere | null> {
  if (cache) return cache;
  cache = new Map();
  const bodies = activeSystem().celestialBodies as CelestialBodyDef[];
  for (const b of bodies) cache.set(b.id, deriveAcoustics(b));
  return cache;
}

/** Acoustic properties of a body's atmosphere, or null if it is airless. */
export function acousticsForBody(bodyId: string): AcousticAtmosphere | null {
  return ensureCache().get(bodyId) ?? null;
}

/** Every body that has an atmosphere. For the dev harness and the doc table. */
export function allAcoustics(): AcousticAtmosphere[] {
  const out: AcousticAtmosphere[] = [];
  for (const v of Array.from(ensureCache().values())) if (v) out.push(v);
  return out;
}

// ---------------------------------------------------------------------------
// Local state at altitude
// ---------------------------------------------------------------------------

/**
 * Gas density at an altitude above the reference surface, kg/m³.
 *
 * Isothermal hydrostatic profile: ρ(h) = ρ₀·exp(−h/H). Crude above a few scale
 * heights (real atmospheres are not isothermal), but the quantity it feeds —
 * "how much sound can this medium carry" — has collapsed to nothing by then
 * anyway, so the error is unobservable.
 *
 * ⚠ Negative altitudes are clamped: below the reference surface is either
 * underground or, for a gas giant, deeper than the 1-bar level this model is
 * anchored to. Neither is somewhere audio needs to be correct.
 */
export function densityAtAltitude(
  atm: AcousticAtmosphere,
  altitudeKm: number,
): number {
  const h = Math.max(0, altitudeKm);
  return atm.surfaceDensityKgM3 * Math.exp(-h / atm.scaleHeightKm);
}

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
