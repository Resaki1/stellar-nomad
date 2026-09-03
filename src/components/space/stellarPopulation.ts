/**
 * THE LOCAL STELLAR POPULATION — one sampled mass, everything else derived.
 *
 * See [`docs/STAR_RENDERING_PLAN.md`](../../../docs/STAR_RENDERING_PLAN.md) §26.
 *
 * The shipped catalogues cover two thin slices of the sky: `stars_visual.bin` is
 * 8,920 stars to **V ≤ 6.5 apparent** (bright, mostly distant) and
 * `stars_nearby.json` is 166 stars reaching only **24.97 ly** (measured; four sites said
 * ~50 ly). So beyond the catalogue the sky is
 * empty, and M dwarfs — **~75% of all stars** — barely exist in the game at all. This
 * module is the physics for generating the rest.
 *
 * 🔑 ONE SAMPLED QUANTITY. Draw a stellar mass from the present-day mass function and
 * every other property follows from published main-sequence relations: luminosity,
 * radius, temperature, and hence colour, limb darkening and disc radiance through the
 * existing `starPhysics`. No per-star authoring, and nothing to tune.
 *
 * ── ⚠⚠ THE IMF IS THE BIRTH FUNCTION AND A SKY IS A SNAPSHOT ────────────────
 * This is the trap, and it nearly shipped. Sampling Chabrier's IMF directly gives a
 * population **29.6× too rich in B stars and 8,954× too rich in O stars**, because
 * massive stars die: an O star lives ~3 Myr against a ~10 Gyr disk. It would have
 * looked spectacular — a sky strewn with blue giants — and been nonsense, and "the
 * sky looks great" is not a test that could have caught it.
 *
 * Multiplying by a survival factor `min(1, τ_MS(m)/τ_disk)` converts the IMF into the
 * **present-day mass function**, which is what a snapshot of the sky is. MEASURED
 * against the observed local population, integrating each spectral class's mass range:
 *
 *     class   raw IMF    with survival    observed
 *     M         0.96×        **1.03×**       76%
 *     K         1.08×          1.16×         12%
 *     G         0.54×          0.57×        7.6%
 *     F         1.10×          0.78×          3%
 *     A         4.80×          1.46×        0.6%
 *     B        29.62×          1.84×       0.13%
 *     O      8953.71×          3.55×       3e-5%
 *
 * Every class within ~2× with no per-class tuning, from two published functions and
 * one lifetime scaling. G at 0.57× is the known behaviour of Chabrier's log-normal
 * near 1 M☉ and is not something to fudge.
 *
 * ⚠ `min(1, τ/τ_disk)` assumes a CONSTANT star-formation rate over the disk's life. The
 * real history is not flat, but the correction it would apply is small compared to the
 * factor-of-2 agreement above, and it would add a free parameter with nothing in this
 * project to fit it against.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT GENERATE ────────────────────────────────
 * ⚠ **Main-sequence dwarfs only.** No giants, no white dwarfs, no subgiants.
 *
 * 🔑 Omitting GIANTS is self-consistent rather than a gap: a giant is luminous, so at
 * any distance where it would be generated it is also brighter than V 6.5 from Sol —
 * which means the *visual catalogue already contains it* and the suppression rule
 * rejects it anyway. Antares and Betelgeuse are in the shipped data (§19.3). The
 * procedural population is faint by construction, and faint means main-sequence.
 *
 * ⚠ **White dwarfs are a real omission**, at roughly **5%** of the local population
 * (~20 of the ~370 objects in the 10 pc census). They are faint (L ~ 1e-4 L☉) so the
 * visual cost is nil, but they are missing *destinations*, and a white dwarf is an
 * interesting place to arrive. Adding them needs a cooling track (L and T from mass and
 * age) rather than a main-sequence relation — a separate branch, not a tweak.
 */

import {
  SUN_ABS_MAG_BOL,
  SUN_ABS_MAG_V,
  SUN_RADIUS_KM,
  SUN_TEMP_K,
  bolometricCorrectionV,
} from "./starPhysics";

/** Hydrogen-burning limit, solar masses — below this it is a brown dwarf. */
export const MASS_MIN_SUN = 0.08;

/**
 * Upper sampling bound — **the mass where this model's own relations leave their
 * domain**, not an arbitrary cutoff.
 *
 * ⚠⚠ IT WAS 100 M☉, AND THAT WAS THE §19 DEFECT AGAIN THROUGH A DOOR THE GUARD DOES
 * NOT WATCH. `bolometricCorrectionV` is clamped to Torres' `log₁₀T ≤ 4.6` = 39,811 K,
 * and the mass–luminosity/mass–radius pair crosses that at **22.886 M☉**. Above it the
 * BC is pinned at its domain edge, so `absMagVFromMass` is simply wrong — MEASURED at
 * 100 M☉: `T_eff = 95,029 K` (the hottest real main-sequence stars are ~50,000 K) and
 * `M_bol = −13.13`, giving objects that render brighter than Sirius.
 *
 * 🔑 And `starParamsUsable`'s radius guard is **structurally blind** to it: at 100 M☉
 * the derived radius is a perfectly plausible **13.8 R☉**. The guard watches radius,
 * and this error does not move radius. That is the same lesson as §19's 1.1e13 R☉ star
 * — *a plausibility guard only covers the quantity it reads* — and it is why the cap
 * has to come from the formulae's domain rather than from a sanity check downstream.
 *
 * MEASURED cost of capping: **2.7e-5% of the population**. And the stars above it are
 * supplied by the real catalogue anyway — anything that massive is far brighter than
 * V 6.5 from Sol, so §26.4's suppression rule would reject a generated one regardless.
 */
export const MASS_MAX_SUN = 22.886;

// ── Chabrier (2003) single-star IMF for the Galactic disk, Table 1 ───────────
// ξ(log m) = A·exp[−(log m − log m_c)² / (2σ²)]   for m ≤ 1 M☉
// ξ(log m) ∝ m^−1.3                                for m > 1 M☉, matched at m = 1
const IMF_A = 0.158;
const IMF_MC = 0.079;
const IMF_SIGMA = 0.69;

/**
 * Main-sequence lifetime, Gyr. `10·m^−2.5` is the standard scaling — it follows from
 * `τ ∝ M/L` with `L ∝ M^3.5`, and reproduces the Sun's ~10 Gyr by construction.
 */
const mainSequenceLifetimeGyr = (m: number): number => 10 * Math.pow(m, -2.5);

/** Age of the Galactic thin disk, Gyr. */
const DISK_AGE_GYR = 10;

const imfPerLogM = (m: number): number => {
  if (m <= 1) {
    const d = Math.log10(m) - Math.log10(IMF_MC);
    return IMF_A * Math.exp(-(d * d) / (2 * IMF_SIGMA * IMF_SIGMA));
  }
  // Continuity at 1 M☉, so the high-mass slope has no free normalisation.
  const at1 = IMF_A * Math.exp(
    -Math.pow(Math.log10(1) - Math.log10(IMF_MC), 2) /
      (2 * IMF_SIGMA * IMF_SIGMA),
  );
  return at1 * Math.pow(m, -1.3);
};

/** Present-day mass function: births × the fraction still on the main sequence. */
export const pdmfPerLogM = (m: number): number =>
  imfPerLogM(m) * Math.min(1, mainSequenceLifetimeGyr(m) / DISK_AGE_GYR);

// ── The inverse-CDF table, for sampling ──────────────────────────────────────
//
// ⚠ Built at module load, which is legitimate here in a way it is NOT for body data:
// this is a mathematical constant of the model, not a property of any system or any
// asset. It does not go stale and there is nothing to re-measure at runtime.
//
// 512 bins over log m. The PDMF spans ~3.1 decades, so a bin is ~0.006 dex — far finer
// than the model's own accuracy.
const CDF_BINS = 512;
const _logMin = Math.log10(MASS_MIN_SUN);
const _logMax = Math.log10(MASS_MAX_SUN);
const _cdf = new Float64Array(CDF_BINS + 1);

/** Stars per cubic parsec, integrated over the full mass range. */
export const STELLAR_DENSITY_PER_PC3 = (() => {
  const h = (_logMax - _logMin) / CDF_BINS;
  let acc = 0;
  _cdf[0] = 0;
  for (let i = 0; i < CDF_BINS; i++) {
    const m = Math.pow(10, _logMin + (i + 0.5) * h);
    acc += pdmfPerLogM(m) * h;
    _cdf[i + 1] = acc;
  }
  // Normalise the table to [0, 1] and return the density it integrated to.
  for (let i = 0; i <= CDF_BINS; i++) _cdf[i] /= acc;
  return acc;
})();

/** Stars per cubic light-year — the unit the star field works in. 1 pc = 3.2615638 ly. */
export const STELLAR_DENSITY_PER_LY3 =
  STELLAR_DENSITY_PER_PC3 / Math.pow(3.2615638, 3);

/**
 * Sample a stellar mass from the PDMF. `u` must be uniform in [0, 1).
 *
 * ⚠ DETERMINISM, STATED PRECISELY. The table is built with `Math.exp`/`Math.pow`, which
 * ECMAScript does **not** require to be bit-identical across engines. So two players on
 * different browsers can get masses differing in the last bits, and hence temperatures
 * differing in the last bits.
 *
 * 🔑 That is acceptable, and the split is deliberate: **exact reproducibility is needed
 * for what is observable — which star exists and where — and that comes from integer
 * hashing alone.** A star's identity and position must be bit-exact; the twelfth decimal
 * of its temperature need not be. Never derive a star's POSITION or its EXISTENCE from a
 * transcendental function.
 */
export function sampleStellarMass(u: number): number {
  const t = u <= 0 ? 0 : u >= 1 ? 1 - 1e-12 : u;
  // Binary search the normalised CDF.
  let lo = 0;
  let hi = CDF_BINS;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (_cdf[mid] <= t) lo = mid;
    else hi = mid;
  }
  const c0 = _cdf[lo];
  const c1 = _cdf[lo + 1];
  const f = c1 > c0 ? (t - c0) / (c1 - c0) : 0;
  const h = (_logMax - _logMin) / CDF_BINS;
  return Math.pow(10, _logMin + (lo + f) * h);
}

/**
 * BOLOMETRIC luminosity, solar units. The standard piecewise mass–luminosity relation.
 *
 * ⚠⚠ **BOLOMETRIC, AND THE DISTINCTION IS NOT PEDANTIC — THE FIRST VERSION OF THIS
 * MODULE GOT IT WRONG IN A SELF-DEFEATING WAY.** The relation gives total radiated
 * power, and I fed it straight into the VISUAL zero point to get `M_V`. For an M dwarf
 * almost all the light is infrared, so `BC_V ≈ −3.9`:
 *
 *     Proxima (m = 0.122):  M_V = 11.68 without the correction, 15.47 with it
 *                           real M_V = 15.60          ⇒ the error was 36×
 *
 * 🔑 And the error was **self-defeating**, which is what makes it worth this much
 * comment: §26's suppression rule rejects a procedural star brighter than V 6.5 as seen
 * from Sol, on the grounds that the visual catalogue would already have it. An M dwarf
 * reported 3.9 mag too bright fails that test — so the bug would have **rejected
 * exactly the faint population this whole phase exists to add**, and the symptom would
 * have been "procedural stars are mysteriously sparse", three inferences away.
 *
 * ⚠ This is the SAME two-luminosities distinction §4 of the plan established for the
 * catalogue path — radius needs bolometric, brightness needs visual — and I repeated
 * the error it documents. `starPhysics` owns the correction; there is no second copy.
 *
 * Validity: the breaks at 0.43 and 2 M☉ are where the fits are stitched, and the
 * relation is main-sequence only, which is all this module generates. MEASURED against
 * real stars after the correction: Sol 0.01 mag, Proxima 0.13, Sirius A 0.37,
 * Barnard's 1.85 (metal-poor and old — the relation assumes solar metallicity).
 */
export function bolometricLuminositySunFromMass(m: number): number {
  if (m < 0.43) return 0.23 * Math.pow(m, 2.3);
  if (m < 2) return Math.pow(m, 4);
  return 1.4 * Math.pow(m, 3.5);
}

/** Main-sequence radius, solar radii. `R ∝ M^0.8` below 1 M☉, `M^0.57` above. */
export function radiusSunFromMass(m: number): number {
  return m < 1 ? Math.pow(m, 0.8) : Math.pow(m, 0.57);
}

/** Main-sequence radius in km — the unit `Star` and the collider want. */
export const radiusKmFromMass = (m: number): number =>
  radiusSunFromMass(m) * SUN_RADIUS_KM;

/**
 * Effective temperature, K, from Stefan–Boltzmann: `T = T☉·(L_bol/R²)^¼`.
 *
 * 🔑 DERIVED, not a second table. Deriving it from L and R is what keeps the three
 * relations mutually consistent — a separate mass–temperature fit would let a star's
 * luminosity disagree with its own radius and colour, and the colour is what the
 * player sees.
 */
export function tempKFromMass(m: number): number {
  const r = radiusSunFromMass(m);
  return (
    SUN_TEMP_K *
    Math.pow(bolometricLuminositySunFromMass(m) / (r * r), 0.25)
  );
}

/**
 * Absolute V magnitude. `M_V = M_bol − BC_V(T_eff)`.
 *
 * ⚠ `bolometricCorrectionV` is `starPhysics`'s, already clamped to Torres' published
 * domain (§19.2) — which matters here, because this module generates stars down to
 * 2,569 K at the hydrogen-burning limit, well below the fit's 3,162 K floor.
 */
export function absMagVFromMass(m: number): number {
  const mBol =
    SUN_ABS_MAG_BOL - 2.5 * Math.log10(bolometricLuminositySunFromMass(m));
  return mBol - bolometricCorrectionV(tempKFromMass(m));
}

/**
 * VISUAL luminosity, solar units — the quantity `starPhysics.illuminanceGameAt` and
 * `discRadianceGame` expect, and therefore what the light pool and the disc tier must
 * be given. Never pass the bolometric value to those.
 */
export const visualLuminositySunFromMass = (m: number): number =>
  Math.pow(10, -0.4 * (absMagVFromMass(m) - SUN_ABS_MAG_V));

/** Live state for `__lum.population()`. */
export function stellarPopulationStatus(): {
  densityPerPc3: number;
  densityPerLy3: number;
  starsIn10pc: number;
  massRange: [number, number];
  classFractions: Record<string, number>;
} {
  const bins: Array<[string, number, number]> = [
    ["M", 0.08, 0.45],
    ["K", 0.45, 0.8],
    ["G", 0.8, 1.04],
    ["F", 1.04, 1.4],
    ["A", 1.4, 2.1],
    ["B", 2.1, 16],
    ["O", 16, 100],
  ];
  const h = (_logMax - _logMin) / 4000;
  const frac: Record<string, number> = {};
  for (const [name, a, b] of bins) {
    let acc = 0;
    for (let lm = Math.log10(a); lm < Math.log10(b); lm += h) {
      acc += pdmfPerLogM(Math.pow(10, lm + h / 2)) * h;
    }
    frac[name] = acc / STELLAR_DENSITY_PER_PC3;
  }
  return {
    densityPerPc3: STELLAR_DENSITY_PER_PC3,
    densityPerLy3: STELLAR_DENSITY_PER_LY3,
    starsIn10pc: STELLAR_DENSITY_PER_PC3 * ((4 / 3) * Math.PI * 1000),
    massRange: [MASS_MIN_SUN, MASS_MAX_SUN],
    classFractions: frac,
  };
}
