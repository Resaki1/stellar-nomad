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
