/**
 * `starPhysics` — one parameterised star, for Sol and every catalogue star alike.
 *
 * See [`docs/STAR_RENDERING_PLAN.md`](../../../docs/STAR_RENDERING_PLAN.md) §4, §8.
 *
 * 🔑 THE POINT: nothing here is a per-star table. Everything is derived from
 * `(absMagV, B−V)` — which is all `stars_visual.bin` / `stars_nearby.json` carry —
 * or from a system description's `(luminositySun, radiusKm, tempK)`. A procedurally
 * generated primary therefore needs no tuning to render correctly.
 *
 * ⚠⚠ TWO LUMINOSITIES, AND MIXING THEM IS THE TRAP.
 *   • **Radius** needs the BOLOMETRIC luminosity, so it needs a bolometric
 *     correction. Skipping it puts Proxima's radius 6.4× low and Betelgeuse's 2.3×
 *     low (measured — §8.1).
 *   • **Brightness** (lux, cd/m²) needs the VISUAL luminosity, and must NOT use a
 *     bolometric correction: a 3000 K star radiates mostly IR, so its bolometric
 *     output badly over-states what the eye receives. Magnitudes already ARE a
 *     luminous scale, so `absMagV` goes straight in.
 * Keep the two paths separate; that is why there are two functions and not one.
 */

import {
  AU_KM,
  NITS_PER_GAME_UNIT,
  SOLAR_ILLUMINANCE_1AU_LUX,
  planck,
  xFit,
  yFit,
  zFit,
} from "./photometry";

/** Sol's radius, km — the Stefan–Boltzmann reference. */
export const SUN_RADIUS_KM = 696_340;
/** Sol's effective temperature, K. */
export const SUN_TEMP_K = 5772;
/** Sol's absolute V magnitude. */
export const SUN_ABS_MAG_V = 4.83;
/** Sol's absolute bolometric magnitude (IAU 2015 nominal). */
export const SUN_ABS_MAG_BOL = 4.74;

/** Ballesteros (2012): B−V → effective temperature, K. */
export function temperatureFromBV(bv: number): number {
  return 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
}

/**
 * V-band bolometric correction — Flower (1996) with Torres (2010)'s corrected
 * coefficients, a polynomial in log₁₀(T_eff).
 *
 * ✅ Self-check: this returns −0.081 at 5772 K, against the −0.09 implied by
 * `SUN_ABS_MAG_BOL − SUN_ABS_MAG_V`. Torres' paper exists because Flower's
 * original table was published with coefficients that do not reproduce his own
 * figures — do not substitute another copy without re-running `__lum.starPhysics()`.
 */
export function bolometricCorrectionV(teffK: number): number {
  const x = Math.log10(Math.max(teffK, 1));
  const c =
    x < 3.7
      ? [-1.90537291496456e4, 1.55144866764412e4, -4.21278819301717e3, 3.81476328422343e2]
      : x < 3.9
        ? [
            -3.70510203809015e4, 3.85672629965804e4, -1.50651486316025e4,
            2.61724637119416e3, -1.70623810323864e2,
          ]
        : [
            -1.18115450538963e5, 1.37145973583929e5, -6.36233812100225e4,
            1.47412923562646e4, -1.70587278406872e3, 7.8873172180499e1,
          ];
  let sum = 0;
  for (let i = 0; i < c.length; i++) sum += c[i] * Math.pow(x, i);
  return sum;
}

/**
 * Visual luminosity in solar units, from absolute V magnitude. No bolometric
 * correction — this is the quantity that drives illuminance and disc luminance.
 */
export function visualLuminositySun(absMagV: number): number {
  return Math.pow(10, -0.4 * (absMagV - SUN_ABS_MAG_V));
}

/** Bolometric luminosity in solar units. Used only for the radius. */
export function bolometricLuminositySun(absMagV: number, teffK: number): number {
  const mBol = absMagV + bolometricCorrectionV(teffK);
  return Math.pow(10, -0.4 * (mBol - SUN_ABS_MAG_BOL));
}

/** Stefan–Boltzmann: `R = R☉·√(L_bol/L☉)·(T☉/T)²`, km. */
export function radiusKmFromBolometric(
  bolometricLumSun: number,
  teffK: number,
): number {
  return (
    SUN_RADIUS_KM *
    Math.sqrt(Math.max(bolometricLumSun, 0)) *
    Math.pow(SUN_TEMP_K / Math.max(teffK, 1), 2)
  );
}

/** Radius in km straight from what a catalogue row carries. */
export function radiusKmFromCatalogue(absMagV: number, bv: number): number {
  const teffK = temperatureFromBV(bv);
  return radiusKmFromBolometric(bolometricLuminositySun(absMagV, teffK), teffK);
}

/** Absolute V magnitude from apparent magnitude and distance in light-years. */
export function absMagVFromApparent(magV: number, distLy: number): number {
  const distPc = Math.max(distLy, 1e-6) / 3.261563777;
  return magV - 5 * Math.log10(distPc / 10);
}

/**
 * Mean photosphere luminance, cd/m² — **derived, not stated**.
 *
 *     E(d) = L·π(R/d)²  and  E(d) = E☉(1 AU)·Lv·(AU/d)²
 *     ⇒  L = E☉(1 AU)·Lv·AU² / (π R²)          (d cancels, as it must)
 *
 * 🐛 THIS REPLACED A HARDCODED `SUN_DISC_LUMINANCE_NITS = 1.6e9`, which was
 * **0.851× (0.233 stops) too dim**: the anchor plus the Sun's own solid angle
 * imply 1.880e9. Two independent numbers for one quantity, and the disc lost.
 * Deriving it makes the identity hold by construction at every temperature.
 */
export function discLuminanceNits(
  visualLumSun: number,
  radiusKm: number,
): number {
  const r = Math.max(radiusKm, 1e-6);
  return (
    (SOLAR_ILLUMINANCE_1AU_LUX * visualLumSun * AU_KM * AU_KM) /
    (Math.PI * r * r)
  );
}

/** Disc radiance in game units. Distance-independent — radiance does not fall off. */
export function discRadianceGame(
  visualLumSun: number,
  radiusKm: number,
): number {
  return discLuminanceNits(visualLumSun, radiusKm) / NITS_PER_GAME_UNIT;
}

/** Illuminance at a distance, game units — the T0 (catalogue-sprite) quantity. */
export function illuminanceGameAt(
  visualLumSun: number,
  distKm: number,
): number {
  const d = Math.max(distKm, 1e-6);
  const lux = SOLAR_ILLUMINANCE_1AU_LUX * visualLumSun * ((AU_KM * AU_KM) / (d * d));
  return lux / NITS_PER_GAME_UNIT;
}

/** Solid angle of a disc of radius `radiusKm` seen from `distKm`, steradians. */
export function discSolidAngle(radiusKm: number, distKm: number): number {
  const s = Math.min(radiusKm / Math.max(distKm, 1e-6), 1);
  return Math.PI * s * s;
}

/** Everything a renderer needs for one star. */
export type StarParams = {
  radiusKm: number;
  tempK: number;
  visualLumSun: number;
  /** Disc radiance, game units. */
  discRadianceGame: number;
};

/** From a system description (the primary). */
export function starParamsFromSystem(
  radiusKm: number,
  tempK: number,
  luminositySun: number,
): StarParams {
  return {
    radiusKm,
    tempK,
    visualLumSun: luminositySun,
    discRadianceGame: discRadianceGame(luminositySun, radiusKm),
  };
}

/** From a catalogue row — the same struct, so one renderer serves both. */
export function starParamsFromCatalogue(
  absMagV: number,
  bv: number,
): StarParams {
  const tempK = temperatureFromBV(bv);
  const radiusKm = radiusKmFromCatalogue(absMagV, bv);
  const visualLumSun = visualLuminositySun(absMagV);
  return {
    radiusKm,
    tempK,
    visualLumSun,
    discRadianceGame: discRadianceGame(visualLumSun, radiusKm),
  };
}

// ── Limb darkening (R4) ──────────────────────────────────────────────────────

/**
 * Quadratic limb-darkening coefficients per linear-sRGB channel, derived from
 * `T_eff` alone — **no table, no fitted constants, no per-star tuning**.
 *
 * ── THE DERIVATION ─────────────────────────────────────────────────────────
 * Eddington grey atmosphere: `T(τ)⁴ = ¾·T_eff⁴·(τ + ⅔)`. The emergent intensity
 * at direction μ = cos θ is then
 *
 *     I_λ(μ) = ∫₀^∞ B_λ(T(τ))·e^(−τ/μ)·dτ/μ
 *
 * evaluated per wavelength and integrated against the CIE CMFs — the SAME
 * `planck`/`xFit`/`yFit`/`zFit` kernel `blackbodyLinearSrgb` uses, so the colour of
 * the disc and the colour of its limb cannot drift apart. Substituting τ = μ·s
 * turns the integral into `∫B(T(μs))e^(−s)ds`, which is well-behaved at every μ
 * including 0 (a first draft integrated in τ and returned 0 at the limb — a pure
 * step-size artefact that looked like infinitely strong limb darkening).
 *
 * ✅ VALIDATED against published solar limb darkening, with nothing fitted:
 * `u = 1 − I(0)/I(1)` comes out **0.790 at 400 nm, 0.662 at 550 nm, 0.569 at
 * 700 nm** against measured ~0.90 / ~0.70 / ~0.55 — within 5% in the visible, 12%
 * in the blue. The frequency-integrated limit is exactly 0.600, the classic
 * Eddington result, which is an independent check on the algebra.
 *
 * 🔑 IT GENERALISES BECAUSE THE WAVELENGTH DEPENDENCE IS PHYSICAL. Limb darkening
 * is set by how sensitive `B_λ` is to temperature at that wavelength, so it is
 * automatically stronger for cool stars and in the blue: `I(limb)/I(centre)` in G
 * runs **0.082 at 3000 K → 0.333 at 5772 K → 0.737 at 30000 K**, and the R/B ratio
 * at the limb (limb *reddening*) runs 3.8× → 1.6× → 1.05×. A hot star is nearly a
 * flat disc; an M dwarf has a dramatic edge. None of that is authored.
 *
 * ⚠ Grey-atmosphere limits: real stars deviate through convection, molecular
 * opacity (worst for M dwarfs) and NLTE. Accept it — the alternative is Claret-style
 * per-(T_eff, log g, band) tables, which is exactly the baked per-star data this
 * project forbids, for a few percent in the visible.
 *
 * ⚠⚠ EXPENSIVE — ~70k `exp` calls. Call ONCE per star, memoised on `tempK`. Never
 * per frame.
 */
export type LimbDarkening = {
  /** Linear term per channel. */
  a: [number, number, number];
  /** Quadratic term per channel. */
  b: [number, number, number];
  /**
   * Disc-mean of the profile, `1 − a/3 − b/6`, per channel.
   *
   * 🔑 Dividing by this is what keeps FLUX CONSERVED: `discLuminanceNits` derives
   * the disc-MEAN radiance from the star's total flux, so the profile must average
   * to exactly 1 over the projected disc or limb darkening would change the star's
   * luminosity. ✅ The closed form matches a numeric integration of the exact
   * profile to 0.03% (R 1.00031, G 0.99987, B 0.99904).
   */
  discMeanNorm: [number, number, number];
  /** `I(limb)/I(centre)` per channel — the diagnostic number. */
  limbRatio: [number, number, number];
};

/** `I_λ(μ)` for the Eddington profile, via the τ = μ·s substitution. */
function eddingtonIntensity(nm: number, mu: number, teffK: number): number {
  const N = 128;
  const S = 30;
  const ds = S / N;
  let acc = 0;
  for (let i = 0; i < N; i++) {
    const sv = (i + 0.5) * ds;
    const tau = mu * sv;
    const t = teffK * Math.pow(0.75 * (tau + 2 / 3), 0.25);
    acc += planck(nm, t) * Math.exp(-sv) * ds;
  }
  return acc;
}

/** Linear-sRGB triple of the emergent intensity at μ (unnormalised). */
function limbRgbAt(mu: number, teffK: number): [number, number, number] {
  let X = 0;
  let Y = 0;
  let Z = 0;
  for (let nm = 380; nm <= 780; nm += 10) {
    const v = eddingtonIntensity(nm, mu, teffK);
    X += v * xFit(nm);
    Y += v * yFit(nm);
    Z += v * zFit(nm);
  }
  return [
    Math.max(0, 3.2406 * X - 1.5372 * Y - 0.4986 * Z),
    Math.max(0, -0.9689 * X + 1.8758 * Y + 0.0415 * Z),
    Math.max(0, 0.0557 * X - 0.204 * Y + 1.057 * Z),
  ];
}

export function limbDarkeningRgb(teffK: number): LimbDarkening {
  const T = Math.max(teffK, 100);
  const MU = 13;
  const centre = limbRgbAt(1, T);
  const a: [number, number, number] = [0, 0, 0];
  const b: [number, number, number] = [0, 0, 0];
  const norm: [number, number, number] = [1, 1, 1];
  const ratio: [number, number, number] = [1, 1, 1];
  // Sample once, reuse across channels — limbRgbAt is the expensive part.
  const samples: { mu: number; rgb: [number, number, number] }[] = [];
  for (let i = 0; i < MU; i++) {
    const mu = i / (MU - 1);
    samples.push({ mu, rgb: limbRgbAt(mu, T) });
  }
  for (let ch = 0; ch < 3; ch++) {
    const c1 = centre[ch] > 0 ? centre[ch] : 1;
    // Least squares on I/I(1) − 1 = −a(1−μ) − b(1−μ)².
    let s11 = 0;
    let s12 = 0;
    let s22 = 0;
    let y1 = 0;
    let y2 = 0;
    for (const { mu, rgb } of samples) {
      const y = rgb[ch] / c1 - 1;
      const x1 = -(1 - mu);
      const x2 = -((1 - mu) * (1 - mu));
      s11 += x1 * x1;
      s12 += x1 * x2;
      s22 += x2 * x2;
      y1 += x1 * y;
      y2 += x2 * y;
    }
    const det = s11 * s22 - s12 * s12;
    const av = det !== 0 ? (y1 * s22 - y2 * s12) / det : 0;
    const bv = det !== 0 ? (y2 * s11 - y1 * s12) / det : 0;
    a[ch] = av;
    b[ch] = bv;
    // ⚠ Floor the normaliser: a pathological fit could drive it to ~0 and blow the
    // radiance up. 0.1 is far below any physical value (30000 K gives 0.93,
    // 3000 K gives 0.62).
    norm[ch] = Math.max(0.1, 1 - av / 3 - bv / 6);
    ratio[ch] = Math.max(0, 1 - av - bv);
  }
  return { a, b, discMeanNorm: norm, limbRatio: ratio };
}
