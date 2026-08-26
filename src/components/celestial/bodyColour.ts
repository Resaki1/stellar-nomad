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
// 🔑 A RESULT WORTH KNOWING BEFORE JUDGING THE OUTPUT: this makes Neptune noticeably
// PALER than the familiar vivid blue. That is correct — the iconic Voyager 2 images
// were contrast-enhanced, and reprocessing of the same data showed Neptune is a pale
// cyan very close to Uranus. If the derived colours look washed out next to the
// authored ones, compare against calibrated spacecraft imagery rather than memory.
// ─────────────────────────────────────────────────────────────────────

import * as THREE from "three";
import { bodyPhotometry } from "@/data/bodyPhotometry";

/** Rec.709 relative luminance — the same weights `__lum` and the meter use. */
const REC709 = [0.2126, 0.7152, 0.0722] as const;

/** The Sun's Johnson B−V. The zero point every body's colour is measured against. */
const SUN_B_MINUS_V = 0.653;

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

  const measured = phot.measuredReflectanceRgb;
  const base = measured
    ? new THREE.Color(measured[0], measured[1], measured[2])
    : reflectanceFromColourIndex(phot.colorIndexBV);
  if (!base) return null;

  const lum = REC709[0] * base.r + REC709[1] * base.g + REC709[2] * base.b;
  if (lum <= 1e-6) return null;
  return base.multiplyScalar(phot.geometricAlbedo / lum);
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
  source: "measured RGB" | "derived from B−V" | "none";
  bMinusV?: number;
  rgb?: [number, number, number];
} {
  const phot = bodyPhotometry(bodyId);
  const c = bodyReflectanceRgb(bodyId);
  if (!phot || !c) return { source: "none" };
  return {
    source: phot.measuredReflectanceRgb ? "measured RGB" : "derived from B−V",
    bMinusV: phot.colorIndexBV,
    rgb: [c.r, c.g, c.b],
  };
}
