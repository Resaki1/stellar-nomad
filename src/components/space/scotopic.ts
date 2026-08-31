// ─────────────────────────────────────────────────────────────────────
// SCOTOPIC / MESOPIC VISION + THE PURKINJE SHIFT — LIGHTING_PLAN.md Phase 7
//
// The one thing in the whole lighting chain that a CAMERA does not have: rods.
// §8 decision 2 settled "eye, not camera", and this is where that stops being a
// slogan. Everything upstream of here is radiometry; this file is the retina.
//
// ── WHAT IS ACTUALLY BEING MODELLED ─────────────────────────────────────────
// Human vision has two receptor systems with DIFFERENT SPECTRAL SENSITIVITIES:
//
//   cones — V(λ),  peak 555 nm — photopic, trichromatic, above ~5 cd/m²
//   rods  — V′(λ), peak 507 nm — scotopic, MONOCHROMATIC, below ~0.005 cd/m²
//
// Two consequences, and it is worth keeping them separate because only one of
// them is derivable:
//
//  (a) **The Purkinje shift is a change of LUMINANCE WEIGHTING.** Because V′ is
//      blue-shifted, a blue object is relatively brighter and a red object
//      relatively darker at night than their photopic luminances say. This is
//      pure colorimetry: it falls out of integrating V′(λ) instead of V(λ), and
//      `SCOTOPIC_RGB` below is that integral. Nothing authored.
//
//  (b) **Loss of colour.** One receptor class cannot carry hue, so a fully
//      scotopic percept is achromatic. This is why the Milky Way is reported as
//      GREY by every observer who has actually seen it dark-adapted, and why
//      naked-eye nebulae have no colour through a telescope.
//
// ── ⚠ THE BLUE TINT IS **NOT** DERIVABLE, AND SAYING SO MATTERS ─────────────
// The plan sketch (§3.9b) has `rodLum · purkinjeTint`, and the obvious move is to
// derive that tint from V′(λ) — V′ peaks at 507 nm, so "scotopic light is blue",
// right? **No.** V′(λ) is a SENSITIVITY curve, not an emission spectrum. A single
// receptor class produces a single scalar; a scalar has no hue. Deriving a tint
// from V′ would be inventing physics.
//
// The blue is nevertheless REAL, and its mechanism is known: at mesopic levels
// the rod signal enters the S-cone (blue) chromatic pathway — rod signals have a
// measured effect on S-cone-mediated chromatic discrimination, so rod activity is
// partially read by the brain AS blue. Khan & Pattanaik, "Modeling blue shift in
// moonlit scenes by rod cone interaction", Journal of Vision 4(8), 2004; Kirk &
// O'Brien, "Perceptually Based Tone Mapping for Low-Light Conditions",
// SIGGRAPH 2011 (which notes subjects report low-light scenes as monochromatic
// but NOT grey).
//
// 🔑 So `PURKINJE_CCT_K` is an **AUTHORED APPEARANCE CONSTANT with a cited
// mechanism**, and it is labelled as one. It is expressed as a colour TEMPERATURE
// rather than three RGB floats so that (i) it is one number to judge, (ii) it
// goes through `blackbodyLinearSrgb`, which is luminance-normalised, so the tint
// can only ever change hue and never brightness — the same discipline
// `Star.tsx`'s colour already follows.
//
// ── WHY PER-PIXEL, NOT THE GLOBAL ADAPTED LUMINANCE ─────────────────────────
// The plan sketch drives the blend from `L_a`, one number for the frame. That is
// wrong, and this repo has already made the mirror-image mistake once and written
// it down: `exposureMeter.ts` records that the eye has BOTH a global term (pupil
// + photochemical, driven by the field average) and a local term (receptor gain
// at ~1°), and that D33 measured a local property and assigned it to the global
// term.
//
// Rod/cone balance is a property of EACH RECEPTOR's own retinal illuminance. On a
// moonlit night you can still see that a tail light is red, while the road stays
// grey — a global blend cannot produce that. A global-only blend here would grey
// out the Moon, every engine plume (197–72,456 cd/m²) and every star bright
// enough to have a real colour, none of which a real eye does.
//
// ⚠⚠ AND A GLOBAL "ROD BLEACHING" TERM WAS BUILT, MEASURED, AND REMOVED. It is
// documented here because the argument for it is genuinely persuasive and will be
// re-invented otherwise. The reasoning was: an eye adapted to a sunlit planet has
// no rod response available, so the dark parts of a bright frame must not go grey
// — implemented as `s = max(s(L_pixel), s(L_adapting))`.
//
// 🔑 THE CONCLUSION DOES NOT FOLLOW, AND THE MEASUREMENT SHOWED IT IMMEDIATELY.
// With the sun in frame the meter reported an adapting luminance of 9,092 cd/m²,
// which drove `s(L_adapting)` to exactly 1 and forced **100% of the frame
// photopic** — including a starfield whose per-pixel split was 92.4% mesopic and
// 5.5% scotopic. That is the marquee case (deep space, sun in view) rendered
// exactly wrong, by a term added to protect a case that did not need protecting.
//
// The error is in what bleaching DOES. It lowers rod SENSITIVITY; it does not turn
// rods into cones. A bleached eye looking at something too dim for cones sees
// **less**, not more colour. So the correct rendering of a dark region under a
// bright adapting field is "dark and colourless", which is what the per-pixel term
// gives on its own — the global term inverts it to "dark and colourful".
//
// And the case it was meant to protect is already handled: a shadow in a sunlit
// scene is ~1/50 of full sun, i.e. tens of cd/m², which the per-pixel term already
// calls photopic. It never reaches 0.005 cd/m². The two cases only looked alike.
//
// ⇒ **`s = s(L_pixel)` alone.** The adapting luminance is still computed and
// reported by `__lum.scotopic()`, because it is the right thing to look at when
// judging the result — it is simply not an input. The TIME course of dark
// adaptation, which is the real global effect, already lives in the exposure
// follower's `TAU_DARKEN_ROD`.
//
// ── WHERE THIS SITS IN THE PIPELINE, AND WHY ────────────────────────────────
//   scene radiance → [eye optics: intraocular scatter] → RETINA (here) → tone curve
//
// The retina is downstream of the ocular media and upstream of any display model,
// so the stage goes AFTER the glare PSF and immediately BEFORE `.toneMapping()`
// (SpaceRenderer.tsx). Putting it after the tone curve would desaturate display
// code values and fight AgX's own Rec.2020 inset/outset chroma path; putting it
// before the glare would let scatter re-introduce colour the rods cannot see.
//
// ✅ THE DRIVER READS THE VEILED IMAGE, as of Phase 8. This note used to say the
// opposite and explain why: *"veiling glare genuinely does raise the retinal light
// floor and SHOULD feed the driver, but today's bloom is a mip chain with an
// authored strength, not a calibrated PSF — feeding an uncalibrated quantity into a
// physically-anchored threshold is how a derived constant quietly becomes a tuned
// one."* `glarePass.ts` is that calibrated PSF, so the coupling is now made and the
// retina sees what the ocular media actually delivered.
//
// ⚠ The consequence is that `__lum.probe()`'s `nits` is no longer bit-identical to
// the driver — probe reads the pre-glare target, the driver reads
// `(1−k)·scene + k·PSF(scene)`. With `k = 0.03` they agree to within a few percent
// away from bright sources and diverge inside a veil, which is exactly where the
// veil is doing its job. Do not treat a small probe/driver mismatch near the sun as
// a bug.
// ─────────────────────────────────────────────────────────────────────

import * as THREE from "three";
import {
  clamp,
  dot,
  float,
  log2,
  max,
  mix,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import {
  NITS_PER_GAME_UNIT,
  blackbodyLinearSrgb,
  planck,
  uPreExposure,
  xFit,
  yFit,
  zFit,
} from "./photometry";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** TSL node. The repo-local alias — see `bodyEclipse.ts` / `planetshine.ts`. */
type U = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Photopic luminance weights (Rec.709 / BT.709 D65). The reference to beat. */
export const PHOTOPIC_RGB: readonly [number, number, number] = [
  0.2126, 0.7152, 0.0722,
];

// ── SCOTOPIC LUMINANCE WEIGHTS ──────────────────────────────────────────────
//
// The V′(λ) analogue of Rec.709. **DERIVED**, three ways, and the three agree.
//
// ⚠⚠ FIRST, THE HONEST CAVEAT, because it bounds everything below: linear sRGB →
// scotopic luminance is **NOT DETERMINED BY COLORIMETRY**. Scotopic luminance is
// ∫L(λ)V′(λ)dλ, and an RGB triple does not carry L(λ). Rods are effectively a
// FOURTH receptor and the renderer only ever carries three numbers. So any weight
// vector is a REGRESSION OVER AN ASSUMED SPECTRAL POPULATION, not a physical
// constant like `NITS_PER_GAME_UNIT`. Quantified: projecting V′(λ) onto
// span{x̄,ȳ,z̄} leaves a 45.6% relative L2 residual.
//
// ⚠ AND THE TEXTBOOK DERIVATION IS THE WRONG ONE. Least-squares-fitting V′(λ)
// against the CMFs directly and pushing that through the sRGB matrix gives
// **R = −0.070** — a negative luminance weight, i.e. a red thruster plume would
// produce NEGATIVE rod luminance. Measured here, not assumed (R² = 0.689). The
// fit is unconstrained and buys its accuracy in the deep red, where V′ is ~0 and
// x̄ is not, by subtracting. Correct-looking, unusable.
//
// WHAT WAS DONE INSTEAD: non-negative least squares minimising FRACTIONAL error
// over an ensemble of physically plausible SCENE spectra — stellar blackbodies
// (2,600–22,000 K, i.e. the procedural range, not Sol) × smooth reflectances
// spanning the sRGB gamut. Non-negativity is not a cosmetic constraint: combined
// with the renderer's non-negative RGB it makes `rodLum ≥ 0` unconditional.
//
// ✅ THREE INDEPENDENT DERIVATIONS, different ensembles and different fitting
// objectives, converge — which is the real evidence, not any single fit:
//
//     stellar BB × gaussian reflectances, NNLS log-error  [0.0000, 0.5671, 0.4329]
//     CIE daylight × measured ColorChecker, NNLS frac.    [0.0270, 0.5339, 0.4391]
//     56 blackbody × reflectance, plain least squares     [0.0104, 0.5535, 0.4362]
//     ───────────────────────────────────────────────────────────────────────────
//     shipped (midpoint)                                  [0.0125, 0.5514, 0.4361]
//
// Blue agrees to ±0.7%, green to ±3%. Red is poorly determined (0–0.027) and
// immaterial either way — which is itself the Purkinje shift stating itself: the
// rods barely see red at all. ⚠ The midpoint is used rather than any one fit
// because a hard R = 0 is a boundary artefact of one optimiser, and V′(610 nm) =
// 0.016 is small but not zero.
//
// ✅ HOLD-OUT VALIDATION on three published S/P ratios the fit never saw:
//     incandescent CIE A 2856 K → 1.401  (published ≈1.4)
//     daylight D65      6504 K → 2.462  (published 2.4–2.5)
//     Sol               5772 K → 2.321  (published ≈2.3)
//
// ── NORMALISATION: SUM TO 1, AND THAT IS A DECISION, NOT A DERIVATION ───────
// The raw fit sums to **2.4477** — the true D65 S/P ratio, i.e. a dark-adapted eye
// really does collect ~2.45× more "luminance" from daylight-coloured light than a
// photopic one. Shipping that would brighten every night surface by 1.29 stops.
//
// It is normalised to 1 instead, so a NEUTRAL surface has exactly its photopic
// luminance and the only visible effect of this file is desaturation + Purkinje.
// Two reasons, one practical and one structural:
//
//  • The exposure meter is PHOTOPIC. A constant gain in the rod path is chased and
//    cancelled by auto-exposure anyway, leaving a 2–6 s transient and nothing else.
//  • The 44-stop calibration behind it was validated in photopic units. Silently
//    rescaling the night side by 2.45× would invalidate the Phase 9 measurements
//    (moonlit Earth at 0.069 cd/m²) that this feature is being judged against.
//
// ⚠ IF THE METER IS EVER UPGRADED to meter mesopic luminance per CIE 191, switch
// to the absolute vector (× 2.4477) and the factor cancels EXACTLY on both sides —
// which means it must be done in ONE commit. This is the Venus-trim cancellation
// trap from §2.2, and it will look like a 2.45× brightness bug if it is half-done.
export const SCOTOPIC_RGB: readonly [number, number, number] = [
  0.0125, 0.5514, 0.4361,
];

/** D65 scotopic/photopic ratio implied by the unnormalised fit. Diagnostic only. */
export const SCOTOPIC_D65_SP_RATIO = 2.4477;

// ── THE MESOPIC BAND ────────────────────────────────────────────────────────
//
// **CIE 191:2010**, the international mesopic photometry system: rods alone below
// 0.005 cd/m², cones alone above 5.0 cd/m². Cited, not chosen.
//
// ⚠ The plan sketch says `smoothstep(0.03, 3.0, L_a)`. Both ends are moved and one
// of them is a real correction:
//  • 0.005 rather than 0.03 — 0.03 cd/m² is the point at which ROD ADAPTATION
//    SETS THE RATE (`MESOPIC_EV` in exposureMeter.ts), which is a different
//    quantity from the point at which rods stop being the only receptor. They sit
//    inside the same band and are not in conflict; they are not interchangeable.
//  • The band is 9.97 stops wide, so **the smoothstep must be taken in LOG
//    luminance.** In linear L a smoothstep puts ~90% of the transition inside the
//    top decade, collapsing a ten-stop perceptual ramp into a hard edge just below
//    5 cd/m². This is the single most visible way to get the feature wrong.
export const MESOPIC_LO_NITS = 0.005;
export const MESOPIC_HI_NITS = 5.0;

const LOG2_LO = Math.log2(MESOPIC_LO_NITS);
const LOG2_HI = Math.log2(MESOPIC_HI_NITS);
const LOG2_SPAN = LOG2_HI - LOG2_LO;

// ── THE PURKINJE TINT ───────────────────────────────────────────────────────
//
// ⚠ THE ONE AUTHORED NUMBER IN THIS FILE. See the header: rods carry no hue, so
// this cannot be derived from V′(λ). It is the appearance constant for rod signal
// entering the S-cone chromatic pathway (Khan & Pattanaik 2004).
//
// Expressed as a CCT and routed through `blackbodyLinearSrgb`, which normalises on
// luminance — so this can only rotate hue, never add brightness, and cannot
// interact with the exposure calibration no matter what value is chosen.
//
// ⚠⚠ THE FIRST DEFAULT WAS 10,000 K AND IT WAS MEASURABLY WRONG. `__lum.scotopic()`
// reports the frame's mean chroma, and in deep space it went **0.073 → 0.357** —
// the stage built to REMOVE colour was adding almost five times as much as it
// removed. The cause is arithmetic, not taste: space is already nearly achromatic
// (0.073), so the desaturation term has almost nothing to take away, while the
// tint multiplies a grey rod image by a strongly coloured vector. Whatever chroma
// the tint itself has IS the delivered chroma of a scotopic region.
//
// So the knob is calibrated against that number rather than by eye. Chroma of a
// fully scotopic pixel, computed from the tint vector:
//
//    6504 K  [1.042, 0.984, 1.035]  0.055   D65 — effectively achromatic
//    7000 K  [1.005, 0.988, 1.108]  0.109   ← default: just above the scene's own
//    7500 K  [0.974, 0.990, 1.176]  0.172
//    8000 K  [0.947, 0.992, 1.237]  0.234
//   10000 K  [0.873, 0.994, 1.430]  0.389   ≈ a SUNLIT EARTH DISC. Not a night sky.
//
// 7,000 K puts the delivered blue just above the frame's own natural 0.073, which
// reads as blue-GREY. 🔑 The measurement is the reason, and it is repeatable: if
// this is ever re-tuned, re-run the gate and quote the chroma, not an impression.
//
// 🔑 Set 6504 K for the strictly-achromatic model with no crosstalk at all — the
// physically most conservative choice, one number away, deliberately, because
// "should night be blue at all" is a judgement the author should make by A/B.
export const PURKINJE_CCT_K = 7000;

/** Luminance-normalised linear-sRGB tint for the rod signal. */
export function purkinjeTint(cctK: number = PURKINJE_CCT_K): [number, number, number] {
  return blackbodyLinearSrgb(cctK);
}

// ── Uniforms ────────────────────────────────────────────────────────────────
//
// 🔑 Gated on a UNIFORM, not on a `settings.*` flag. The post graph's rebuild
// `useEffect` would recompile every shader on toggle, and WebGPU shader-
// compilation stutter is a known problem in this project. At strength 0 the stage
// returns its input BIT-EXACTLY, so wiring it up is a no-op until it is asked for.
// This is the same contract `uLocalStrength` already has.
// ⚠ DEFAULT ON (strength 1). The no-op contract still holds — `__lum.scotopic(false)`
// makes it bit-exact passthrough with no recompile — but the default is ON because a
// LOOK feature that is off by default never gets judged: it would have to be re-enabled
// by hand every reload. `localExposure` defaults off for the opposite reason; it was
// measured to misbehave, and this has not been.
const uScotopicStrength = /*#__PURE__*/ uniform(1);
const uScotopicW = /*#__PURE__*/ uniform(
  new THREE.Vector3(SCOTOPIC_RGB[0], SCOTOPIC_RGB[1], SCOTOPIC_RGB[2]),
);
const uPurkinjeTint = /*#__PURE__*/ uniform(new THREE.Vector3(1, 1, 1));
let _enabled = true;
let _cctK = PURKINJE_CCT_K;
let _adaptNits = 0;
let _weights: [number, number, number] = [...SCOTOPIC_RGB] as [
  number,
  number,
  number,
];

function applyTint(): void {
  const t = purkinjeTint(_cctK);
  uPurkinjeTint.value.set(t[0], t[1], t[2]);
}
applyTint();

/**
 * The rod↔cone blend for one luminance, in cd/m². 1 = photopic, 0 = scotopic.
 *
 * ⚠⚠ THIS IS THE CPU TWIN OF THE TSL BELOW AND THE TWO MUST STAY LINE-FOR-LINE.
 * `__lum.scotopic()` needs to predict `s` at luminances the camera is not
 * currently pointed at (a ladder), which no readback can supply. The defence
 * against the self-agreement trap is that both sides read the SAME constants and
 * the same three lines — not that the gate re-derives the formula from theory.
 */
export function rodConeBlend(nits: number): number {
  const t = Math.min(
    Math.max((Math.log2(Math.max(nits, 1e-9)) - LOG2_LO) / LOG2_SPAN, 0),
    1,
  );
  return t * t * (3 - 2 * t);
}

/** TSL: the same three lines as `rodConeBlend`. */
function rodConeBlendNode(nits: U): U {
  const t = clamp(log2(max(nits, float(1e-9))).sub(LOG2_LO).div(LOG2_SPAN), 0, 1);
  return t.mul(t).mul(float(3).sub(t.mul(2)));
}

/**
 * The retina stage.
 *
 * @param hdr      post-glare, post-exposure colour (vec4) — what the eye receives
 * @param sceneRad the RAW composited scene texture (vec4), still carrying the
 *                 frame's pre-exposure. Used ONLY to recover absolute cd/m² for
 *                 the threshold, in absolute game units.
 *
 * Returns vec4 — `.toneMapping()` returns `vec4(fn(rgb), a)` and everything
 * downstream (dither, sRGB encode, 8-bit write) is vec4, so dropping alpha here
 * would not error, it would just be wrong somewhere later.
 */
export function scotopicNode(hdr: U, sceneRad: U): U {
  // Absolute photopic luminance at this pixel, cd/m². `buffer / preExposure` is
  // exactly what `decodeRgb` does on the CPU side (D25).
  const absNits = dot(
    sceneRad.rgb.div(uPreExposure),
    vec3(PHOTOPIC_RGB[0], PHOTOPIC_RGB[1], PHOTOPIC_RGB[2]),
  ).mul(NITS_PER_GAME_UNIT);

  // Per-receptor rod↔cone balance. Per-pixel ONLY — see the header on why the
  // global bleaching term was built, measured, and removed.
  const s = rodConeBlendNode(absNits);

  // The rod image: achromatic, V′-weighted, tinted by the S-cone crosstalk.
  const rod = dot(hdr.rgb, uScotopicW);
  const scotopic = rod.mul(uPurkinjeTint);

  const retina = mix(scotopic, hdr.rgb, s);
  // Strength 0 ⇒ bit-exact passthrough.
  return vec4(mix(hdr.rgb, retina, uScotopicStrength), hdr.a);
}

/**
 * The CPU twin of `scotopicNode`, for the gate. Same constants, same order.
 * `rgb` is any linear colour; `driverNits` is the ABSOLUTE luminance the shader
 * would threshold on.
 */
export function scotopicMixCpu(
  rgb: readonly [number, number, number],
  driverNits: number,
): { out: [number, number, number]; s: number; rod: number } {
  const s = rodConeBlend(driverNits);
  const rod =
    _weights[0] * rgb[0] + _weights[1] * rgb[1] + _weights[2] * rgb[2];
  const tint = purkinjeTint(_cctK);
  const str = uScotopicStrength.value as number;
  const out = [0, 0, 0] as [number, number, number];
  for (let i = 0; i < 3; i++) {
    const retina = rod * tint[i] * (1 - s) + rgb[i] * s;
    out[i] = rgb[i] * (1 - str) + retina * str;
  }
  return { out, s, rod };
}

/**
 * Per-frame. `adaptNits` is the SMOOTHED ADAPTING luminance in cd/m² — the real
 * one, not the partially-adapted display EV.
 *
 * ⚠ DIAGNOSTIC ONLY — it is reported by `__lum.scotopic()` and feeds no uniform.
 * See the header: it was an input once, and forcing the frame photopic whenever
 * anything bright was visible is exactly what it did. It is kept because it is the
 * number to look at when judging the result, and because deleting it would make
 * the gate unable to explain a scene that "should" be scotopic and is not.
 *
 * ⚠ Still called ABOVE `updateExposureMeter`'s `if (isManualExposure()) return`,
 * for the reason recorded there: every gate written to validate this feature pins
 * exposure, and a value frozen below that return would report the previous pose's.
 */
export function updateScotopicUniforms(adaptNits: number): void {
  _adaptNits = adaptNits;
}

/**
 * Runtime A/B, in the `setLocalExposure` idiom — no reload, no shader recompile.
 * `strength` is the 0..1 blend of the whole stage (1 = the model as designed);
 * it exists to make "is this thing doing anything" answerable, not as a look knob.
 */
export function setScotopic(
  enabled: boolean,
  opts?: { strength?: number; cctK?: number; weights?: [number, number, number] },
): void {
  _enabled = enabled;
  uScotopicStrength.value = enabled ? (opts?.strength ?? 1) : 0;
  if (opts?.cctK !== undefined) {
    _cctK = opts.cctK;
    applyTint();
  }
  if (opts?.weights) {
    _weights = [...opts.weights];
    uScotopicW.value.set(_weights[0], _weights[1], _weights[2]);
  }
}

/** Live uniform state, for `__lum.scotopic()`. Never recompute — read this. */
export function scotopicStatus() {
  return {
    enabled: _enabled,
    strength: uScotopicStrength.value as number,
    weights: [..._weights] as [number, number, number],
    shippedWeights: [...SCOTOPIC_RGB] as [number, number, number],
    photopicWeights: [...PHOTOPIC_RGB] as [number, number, number],
    purkinjeCctK: _cctK,
    purkinjeTint: purkinjeTint(_cctK),
    adaptNits: _adaptNits,
    /** What the removed global bleaching term WOULD have forced. Diagnostic. */
    adaptBlendIfGlobal: rodConeBlend(_adaptNits),
    mesopicLoNits: MESOPIC_LO_NITS,
    mesopicHiNits: MESOPIC_HI_NITS,
    d65SpRatio: SCOTOPIC_D65_SP_RATIO,
  };
}

// ── The derivation, executable ──────────────────────────────────────────────
//
// CIE 1951 scotopic luminous efficiency V′(λ), 10 nm, peak 1.000 at 507 nm.
// ✅ Self-check on two published values the table is not fitted to: V′(555) =
// 0.405 (published 0.402, and it is the 1700/683 lm/W anchor), V′(507) = 1.000.
const V_PRIME: readonly number[] = [
  0.000589, 0.002209, 0.00929, 0.03484, 0.0966, 0.1998, 0.3281, 0.455, 0.567,
  0.676, 0.793, 0.904, 0.982, 0.997, 0.935, 0.811, 0.65, 0.481, 0.3288, 0.2076,
  0.1212, 0.0655, 0.03315, 0.01593, 0.00737, 0.003335, 0.001497, 0.000677,
  0.0003129, 0.000148, 0.0000715, 0.00003533, 0.0000178, 0.00000914, 0.00000478,
  0.000002546, 0.000001379, 0.00000076, 0.000000425, 0.000000241, 0.000000139,
];

/** V′(λ), the CIE 1951 scotopic observer. The rod analogue of `yFit`. */
export function scotopicV(nm: number): number {
  if (nm <= 380) return V_PRIME[0];
  if (nm >= 780) return V_PRIME[V_PRIME.length - 1];
  const i = Math.floor((nm - 380) / 10);
  const t = (nm - 380) / 10 - i;
  return V_PRIME[i] * (1 - t) + V_PRIME[i + 1] * t;
}

/**
 * The true S/P ratio of a spectrum: `(1700·∫L·V′) / (683·∫L·V)`.
 *
 * 🔑 THIS IS THE GROUND TRUTH `SCOTOPIC_RGB` IS AN APPROXIMATION OF, and it is
 * spectral — no RGB involved. The gate uses it to state the approximation's error
 * on the star the player is actually under, which is the only honest way to
 * report a regression constant in a procedurally generated system.
 */
export function spectralSpRatio(spd: (nm: number) => number): number {
  let p = 0;
  let s = 0;
  for (let nm = 380; nm <= 780; nm++) {
    const e = spd(nm);
    p += e * yFit(nm);
    s += e * scotopicV(nm);
  }
  return p > 0 ? (1700 * s) / (683 * p) : 0;
}

/**
 * Re-derive the shipped weights from the repo's own CMFs, so the gate can assert
 * the pasted constant rather than trusting it. Non-negative, fractional-error,
 * over stellar blackbodies × smooth reflectances. Returns weights summing to 1
 * plus the implied D65 S/P.
 *
 * ⚠ Costs ~10 ms. Called from `__lum.scotopic({ derive: true })` only — never at
 * module load, and never per frame.
 */
export function deriveScotopicWeights(): {
  weights: [number, number, number];
  d65SpRatio: number;
  rmsStops: number;
  samples: number;
} {
  const refls: Array<(nm: number) => number> = [
    () => 1,
    () => 0.5,
    () => 0.08,
  ];
  const lobes: Array<[number, number]> = [
    [640, 60], [605, 60], [578, 60], [558, 55],
    [535, 55], [505, 55], [487, 55], [462, 50], [440, 45],
  ];
  for (const [mu, sg] of lobes)
    for (const sat of [0.35, 0.7, 1.0])
      refls.push((nm) => 1 - sat + sat * Math.exp(-0.5 * ((nm - mu) / sg) ** 2));

  const data: Array<{ rgb: [number, number, number]; y: number; sp: number }> = [];
  for (const T of [2600, 3000, 3400, 3800, 4300, 5000, 5772, 6504, 7500, 9000, 12000, 16000, 22000]) {
    for (const R of refls) {
      const spd = (nm: number) => planck(nm, T) * R(nm);
      let X = 0;
      let Y = 0;
      let Z = 0;
      for (let nm = 380; nm <= 780; nm++) {
        const e = spd(nm);
        X += e * xFit(nm);
        Y += e * yFit(nm);
        Z += e * zFit(nm);
      }
      const rgb: [number, number, number] = [
        3.2406 * X - 1.5372 * Y - 0.4986 * Z,
        -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
        0.0557 * X - 0.204 * Y + 1.057 * Z,
      ];
      if (rgb.some((v) => v < 0)) continue; // out of sRGB gamut
      const y = PHOTOPIC_RGB[0] * rgb[0] + PHOTOPIC_RGB[1] * rgb[1] + PHOTOPIC_RGB[2] * rgb[2];
      if (y <= 0) continue;
      data.push({ rgb, y, sp: spectralSpRatio(spd) });
    }
  }

  const err = (w: number[]): number => {
    let acc = 0;
    for (const d of data) {
      const p = (w[0] * d.rgb[0] + w[1] * d.rgb[1] + w[2] * d.rgb[2]) / d.y;
      if (p <= 0) return 1e9;
      acc += Math.log2(p / d.sp) ** 2;
    }
    return Math.sqrt(acc / data.length);
  };
  let w = [0.05, 1.3, 1.0];
  let e = err(w);
  let step = [0.04, 0.12, 0.12];
  for (let it = 0; it < 4000; it++) {
    let moved = false;
    for (let i = 0; i < 3; i++)
      for (const sg of [1, -1]) {
        const t = [...w];
        t[i] = Math.max(0, t[i] + sg * step[i]);
        const te = err(t);
        if (te < e - 1e-12) {
          e = te;
          w = t;
          moved = true;
        }
      }
    if (!moved) {
      step = step.map((s) => s * 0.6);
      if (step[0] < 1e-7) break;
    }
  }
  const sum = w[0] + w[1] + w[2];
  return {
    weights: [w[0] / sum, w[1] / sum, w[2] / sum],
    d65SpRatio: sum,
    rmsStops: e,
    samples: data.length,
  };
}
