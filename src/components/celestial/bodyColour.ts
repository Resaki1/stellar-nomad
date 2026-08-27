// ─────────────────────────────────────────────────────────────────────
// A BODY'S REFLECTANCE COLOUR, DERIVED FROM ITS MEASURED COLOUR INDEX
//
// Both places a body's colour is written down as an RGB triple — the far
// billboard's `albedo` and `stellarPoint.color` — were AUTHORED BY EYE. This
// derives them instead, from `bodyPhotometry`'s `colorIndexBV`, which is a
// published photometric measurement and has been sitting in that table unused
// with the comment "used to derive a defensible tint".
//
// ⚠ Hue is NOT an artistic choice. A body's colour is measured, so a hand-picked
// triple is an uncontrolled second opinion about a number we already have — and
// exactly the kind of authored constant that made the far tier's BRIGHTNESS drift
// 8.7× (D09). Same defect class, same remedy: derive it.
//
// ── The derivation ──────────────────────────────────────────────────────────
// B−V is a magnitude difference, so `(B−V) = −2.5·log₁₀(F_B/F_V) + const`. A body
// is illuminated by the star, so its observed flux ratio is the star's times its own
// REFLECTANCE ratio, and the star's colour cancels out of the comparison:
//
//     Δ(B−V) = (B−V)_body − (B−V)_sun  = −2.5·log₁₀(R_B / R_V)
//     ⇒  R_B / R_V = 10^(−0.4·Δ(B−V))
//
// Larger B−V ⇒ fainter in blue ⇒ redder. Sanity: Mars (1.36) gives R_B/R_V = 0.52,
// Neptune (0.41) gives 1.25. Both the right sign.
//
// ⚠⚠ ONE COLOUR INDEX IS ONE DEGREE OF FREEDOM, AND RGB NEEDS TWO. B−V constrains
// blue-versus-green and says NOTHING about red. Closing that needs a model, and the
// one used here is the standard planetary-science description of a reflectance
// spectrum: a **linear spectral slope**, fitted through the two band centres and
// evaluated at the sRGB primaries' dominant wavelengths.
//
// ⚠ WHERE THAT MODEL IS KNOWN TO BE WEAK: bodies with strong, narrow absorption
// bands — above all the ICE GIANTS, whose colour comes from methane absorbing in the
// RED, which is the opposite of smooth. A linear slope extrapolated from B and V will
// UNDER-remove that red, so Uranus and Neptune come out paler and less saturated than
// a real spectrum would give. The honest fix is a second measured index (V−R or B−R)
// per body; until then `measuredReflectanceRgb` is the override hook, and anything
// put there must be a published measurement, not a preference.
//
// ── ✅ SUPERSEDED FOR THE EIGHT PLANETS (2026-08-26) ────────────────────────
// The linear-slope model above is now only a FALLBACK. Every planet has real
// per-band geometric albedos in `bodyPhotometry.bandAlbedo` — Mallama, Krobusek &
// Pavlov (2017) Table 7 — so its colour comes from integrating an actual measured
// spectrum against the CIE colour-matching functions instead of extrapolating a
// straight line off two points.
//
// 🔑🔑 THE SAME TABLE `geometricAlbedo` ALREADY CAME FROM. All eight V-column
// values match this repo's existing albedos to every digit, which is what makes
// this an extension of one measurement rather than a collision between two.
//
// ⚠⚠ AND IT CONFIRMS THE MODEL'S PREDICTED FAILURE, WITH NUMBERS. Measured R/B vs
// the slope model's:
//
//     Uranus   0.360 measured   vs 0.875 modelled   → model 1.8× too RED
//     Neptune  0.322            vs 0.686           → model 1.6× too RED
//     Mars     3.27             vs 2.13            → model 1.5× too PALE
//     Earth    0.816            vs 0.448           → model 1.8× too BLUE
//     Jupiter / Venus / Saturn / Mercury           → within 0.89–1.15×
//
// The four smooth-spectrum bodies barely move and the four with real spectral
// structure move a lot. That is the model failing exactly where D09b said it
// would (narrow absorption: methane in the red) and holding up everywhere else —
// so it stays as the fallback for bodies with no band data, rather than being
// deleted.
//
// ⚠ STILL OPEN: Io and the other moons. They need a second index, and the
// obvious compilation's V−R column fails a plausibility check (it makes Ganymede
// redder than Io and Callisto bluer than the Sun) — see `colorIndexVR`'s note.
// Those bodies remain on the slope model and remain a worklist entry.
//
// 🔑 A RESULT WORTH KNOWING BEFORE JUDGING THE OUTPUT: this makes Neptune noticeably
// PALER than the familiar vivid blue. That is correct — the iconic Voyager 2 images
// were contrast-enhanced, and reprocessing of the same data showed Neptune is a pale
// cyan very close to Uranus. If the derived colours look washed out next to the
// authored ones, compare against calibrated spacecraft imagery rather than memory.
// ─────────────────────────────────────────────────────────────────────

import * as THREE from "three";
import { bodyPhotometry } from "@/data/bodyPhotometry";
import { reflectanceSpectrumToLinearSrgb } from "@/components/space/photometry";

/** Rec.709 relative luminance — the same weights `__lum` and the meter use. */
const REC709 = [0.2126, 0.7152, 0.0722] as const;

/**
 * The Sun's Johnson–Cousins colours — the zero point every body is measured
 * against. **Ramírez, Michel, Sengupta et al. (2012), ApJ 752, 5, "The UBV(RI)c
 * colors of the Sun"**: (B−V)☉ = 0.653 ± 0.005, (V−R)☉ = 0.352 ± 0.007.
 *
 * ⚠ Worth knowing before touching these: the literature genuinely disagrees on
 * the solar B−V — Ramírez & Meléndez (2005) give a "blue" 0.619 against
 * Casagrande et al. (2006)'s 0.651 — and this zero point enters every body's
 * colour, so a 0.03 shift here tints the entire solar system. The 2012 value was
 * already the constant in this file; the citation is what was missing.
 */
const SUN_B_MINUS_V = 0.653;
const SUN_V_MINUS_R = 0.352;

/** Johnson band centres, nm (Bessell). The two points the slope is fitted through. */
const LAMBDA_B = 442;
const LAMBDA_V = 540;

/**
 * Dominant wavelengths of the sRGB primaries, nm, from their xy chromaticities
 * (R 0.640/0.330 → 611, G 0.300/0.600 → 549, B 0.150/0.060 → 465).
 * ⚠ Real primaries are broad, so these are representative rather than exact — which
 * is well within the linear-slope model's own error.
 */
const LAMBDA_RGB = [611, 549, 465] as const;

/**
 * Reflectance RGB for a body: hue derived from its measured B−V, scaled so its
 * Rec.709 luminance is exactly the published geometric albedo.
 *
 * Returns `null` when the body has no photometry row, so callers can fall back to
 * whatever they had rather than silently rendering something wrong.
 */
export function bodyReflectanceRgb(bodyId: string): THREE.Color | null {
  const phot = bodyPhotometry(bodyId);
  if (!phot || phot.geometricAlbedo <= 0) return null;

  const base =
    // Precedence, most-measured first. Each step adds a real degree of freedom;
    // none of them is a preference.
    reflectanceFromOverride(phot.measuredReflectanceRgb) ??
    reflectanceFromBands(phot.bandAlbedo) ??
    reflectanceFromTwoIndices(phot.colorIndexBV, phot.colorIndexVR) ??
    reflectanceFromColourIndex(phot.colorIndexBV);
  if (!base) return null;

  const lum = REC709[0] * base.r + REC709[1] * base.g + REC709[2] * base.b;
  if (lum <= 1e-6) return null;
  return base.multiplyScalar(phot.geometricAlbedo / lum);
}

function reflectanceFromOverride(
  rgb: readonly [number, number, number] | undefined,
): THREE.Color | null {
  return rgb ? new THREE.Color(rgb[0], rgb[1], rgb[2]) : null;
}

/**
 * Johnson–Cousins band effective wavelengths, nm. The abscissae the measured
 * albedos are interpolated between.
 *
 * ⚠ Distinct from `LAMBDA_B`/`LAMBDA_V` above (442/540) on purpose: those are the
 * Bessell band CENTRES the two-point slope model was fitted with, and this path
 * is a different model with a different citation. The ~5 nm disagreement is far
 * inside either model's own error; what matters is that each set stays internally
 * consistent, so they are not shared.
 */
const BAND_LAMBDA = { U: 365, B: 445, V: 551, R: 658, I: 806 } as const;

/**
 * Reflectance from measured per-band geometric albedos: piecewise-linear in
 * wavelength between the bands present, held flat outside them, integrated
 * against the CIE CMFs under the star's own spectrum.
 *
 * ⚠ Needs at least TWO bands — one band is a magnitude, not a colour, and the
 * caller already gets magnitude from `geometricAlbedo`.
 *
 * ⚠ Piecewise-LINEAR is the honest choice here rather than a smooth fit. A band
 * albedo is already an average over a wide filter, so the deep CH₄ features
 * inside the R and I bands are smoothed out before this function ever sees them;
 * a spline would invent structure between the samples without recovering the
 * structure lost inside them.
 */
function reflectanceFromBands(
  bands:
    | { U?: number; B?: number; V?: number; R?: number; I?: number }
    | undefined,
): THREE.Color | null {
  if (!bands) return null;
  const pts: [number, number][] = [];
  for (const key of ["U", "B", "V", "R", "I"] as const) {
    const v = bands[key];
    if (v !== undefined && v >= 0) pts.push([BAND_LAMBDA[key], v]);
  }
  if (pts.length < 2) return null;
  pts.sort((a, b) => a[0] - b[0]);
  const rho = (nm: number): number => {
    if (nm <= pts[0][0]) return pts[0][1];
    const last = pts[pts.length - 1];
    if (nm >= last[0]) return last[1];
    for (let i = 0; i < pts.length - 1; i++) {
      const [l0, r0] = pts[i];
      const [l1, r1] = pts[i + 1];
      if (nm <= l1) return r0 + ((nm - l0) / (l1 - l0)) * (r1 - r0);
    }
    return last[1];
  };
  const [r, g, b] = reflectanceSpectrumToLinearSrgb(rho);
  if (r + g + b <= 1e-9) return null;
  return new THREE.Color(r, g, b);
}

/**
 * Reflectance from TWO measured colour indices — the second degree of freedom
 * D09b said RGB needs. B−V pins blue against green, V−R pins red against green,
 * so a three-band spectrum follows with no slope assumption at all:
 *
 *     ρ_B/ρ_V = 10^(−0.4·[(B−V) − (B−V)☉])
 *     ρ_R/ρ_V = 10^(+0.4·[(V−R) − (V−R)☉])
 *
 * ⚠ Note the SIGN FLIP between the two. V−R is `m_V − m_R`, so the band being
 * compared moves from the first slot to the second and the exponent's sign goes
 * with it. Getting this backwards would turn every red body blue and still look
 * like a plausible spectrum, which is why the sanity check is written out: Io at
 * V−R 0.72 must come out REDDER than the Sun, i.e. ρ_R/ρ_V > 1.
 *
 * Then handed to the same band integrator, so both paths share one colour model.
 */
function reflectanceFromTwoIndices(
  bMinusV: number | undefined,
  vMinusR: number | undefined,
): THREE.Color | null {
  if (bMinusV === undefined || vMinusR === undefined) return null;
  return reflectanceFromBands({
    B: Math.pow(10, -0.4 * (bMinusV - SUN_B_MINUS_V)),
    V: 1,
    R: Math.pow(10, 0.4 * (vMinusR - SUN_V_MINUS_R)),
  });
}

/**
 * Relative (unnormalised) reflectance at the sRGB primaries from a B−V index.
 * Returns `null` if the body has no measured index — better to keep the authored
 * value than to invent a colour for a body whose colour nobody measured.
 */
function reflectanceFromColourIndex(bMinusV: number | undefined): THREE.Color | null {
  if (bMinusV === undefined) return null;
  const ratioBoverV = Math.pow(10, -0.4 * (bMinusV - SUN_B_MINUS_V));
  // Linear spectral slope through (λ_B, R_B/R_V) and (λ_V, 1), per nm.
  const slope = (ratioBoverV - 1) / (LAMBDA_B - LAMBDA_V);
  const at = (lambda: number): number =>
    // ⚠ Clamped at 0. Nothing in the solar system's measured range of B−V comes
    // close to a negative extrapolation (the widest, Mars at 1.36, still leaves
    // blue at 0.63), but a procedurally generated body could, and a negative
    // reflectance would be an energy violation rather than a dark colour.
    Math.max(0, 1 + slope * (lambda - LAMBDA_V));
  return new THREE.Color(at(LAMBDA_RGB[0]), at(LAMBDA_RGB[1]), at(LAMBDA_RGB[2]));
}

/** Diagnostics for `__lum.albedo()`: what each body's colour resolves to and how. */
export function bodyColourStatus(bodyId: string): {
  source:
    | "measured RGB"
    | "band spectrum"
    | "B−V + V−R"
    | "derived from B−V"
    | "none";
  bMinusV?: number;
  /** Which bands the spectrum was built from, e.g. "U B V R I". */
  bands?: string;
  rgb?: [number, number, number];
} {
  const phot = bodyPhotometry(bodyId);
  const c = bodyReflectanceRgb(bodyId);
  if (!phot || !c) return { source: "none" };
  const bandKeys = phot.bandAlbedo
    ? (["U", "B", "V", "R", "I"] as const)
        .filter((k) => phot.bandAlbedo?.[k] !== undefined)
        .join(" ")
    : undefined;
  const source = phot.measuredReflectanceRgb
    ? "measured RGB"
    : bandKeys && bandKeys.length > 1
      ? "band spectrum"
      : phot.colorIndexBV !== undefined && phot.colorIndexVR !== undefined
        ? "B−V + V−R"
        : "derived from B−V";
  return {
    source,
    bMinusV: phot.colorIndexBV,
    bands: bandKeys,
    rgb: [c.r, c.g, c.b],
  };
}
