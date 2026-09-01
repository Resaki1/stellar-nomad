/**
 * `displayTransform` — Phase 6b/6c: AgX with the display's peak as a PARAMETER.
 *
 * See [`docs/HDR_OUTPUT_PLAN.md`](../../../docs/HDR_OUTPUT_PLAN.md) §4. This replaces
 * `three`'s `agxToneMapping` node for one reason and one reason only:
 *
 *     colortone.assign( clamp( colortone, 0.0, 1.0 ) );     // ← three, twice
 *
 * 🔑 **That clamp is not AgX's, it is three's.** A display transform's job is to map
 * scene-referred light onto a display's range, so every one of them ends at the display's
 * peak; three hardcodes that peak at `1.0` because it only ever targeted SDR. Everything
 * else here — the inset/outset matrices, the sRGB↔Rec2020 hops, the 16.5-stop log window,
 * the `pow(·, 2.2)` tail — is copied from three unchanged. **One constant becomes a
 * uniform.**
 *
 * ── WHY A TONE CURVE IS STILL MANDATORY ON HDR ──────────────────────────────
 * Deep space ~1e-4 cd/m² to the sun disc at 1.6e9 cd/m² is **43.9 stops**. SDR gives ~10
 * usable; the XDR adds `log2(1600/203)` = 2.98. So HDR takes "compress 34 stops away" to
 * "compress 31 stops away". Moving the peak from H=1 to H=8 lifts the white clip from
 * scene-linear 16.3 to ~130 — the sun disc goes from 14.0 stops above it to 11.0. HDR
 * moves the shoulder by 3 stops on a 44-stop scene; it does not remove the need for one.
 *
 * ── THE CURVE ───────────────────────────────────────────────────────────────
 * A two-armed power sigmoid in the same normalised-log domain three uses:
 *
 *     arm(d, s, L, p) = L·q / (1 + q^p)^(1/p),   q = s·max(d,0)/L
 *                       → slope s at d=0, asymptote L as d→∞
 *
 *     y(t) = t < xp ?  yp − arm(xp − t, s, yp,      TOE_POWER)
 *                   :  yp + arm(t − xp, s, Hs − yp, SHOULDER_POWER)
 *
 * with `Hs = H^(1/2.2)` because the sigmoid's output lives in the γ2.2 space three's
 * `pow(·, 2.2)` tail decodes. `H = 1` is SDR, so **one uniform covers both paths — no
 * branch, no shader variant, and nothing to recompile when the peak changes.**
 *
 * 🔑 **THE PIVOT IS MIDDLE GREY, PINNED, NOT FITTED.** `PIVOT_X = t(0.18)` and
 * `PIVOT_Y = agxPoly(PIVOT_X)`. Because both arms pass through the pivot with slope `s`
 * regardless of `L`, **middle grey is invariant in H by construction** — measured
 * identical to 4 decimal places across H ∈ {1,2,4,8}. That is what lets Phase 5's
 * auto-exposure, Phase 7's scotopic driver and `EXPOSURE_BIAS_STOPS` keep their meaning
 * when the peak moves: only the *highlights* change.
 *
 * ⚠ **WHY NOT A C¹ EXTENSION ABOVE WHITE** (which would have made SDR bit-identical):
 * measured, it makes the headroom unreachable. The AgX contrast curve's slope at white is
 * 0.5147 per normalised log unit and one unit is the whole 16.5-stop window — 0.031/stop.
 * A C¹ graft reaches only 1.93 of an available 8.0 at scene-linear 1e5, i.e. **24%**.
 * **The correct invariant is a fixed PIVOT, not a fixed ENDPOINT.**
 *
 * ── THE HONEST COST ─────────────────────────────────────────────────────────
 * The parametric family cannot reproduce three's 6th-order polynomial exactly. Best fit
 * with the pivot pinned: **2.429 of 255 delivered code values (0.95%)** at t = 0.866.
 * ⚠ That number is in **delivered 8-bit sRGB code values**, not in sigmoid units — an
 * earlier draft of this work quoted `|Δy|`, which over-states the error near black by two
 * decades (y = 0.009 there is display-linear 3.2e-5, i.e. **code 0.12**) and under-states
 * it in the mid-tones. Measure what the panel shows.
 *
 * We spend that 0.95% deliberately: **one curve for both outputs**, so toggling HDR is
 * continuous, rather than a bit-identical SDR path and a permanent 2.4-code jump on a
 * user-facing switch. `setDisplayCurve("poly")` restores three's polynomial so the
 * difference can be *seen* rather than argued about.
 *
 * ⚠⚠ **ONLY THE UPPER CLAMP GOES. THE LOWER ONE IS LOAD-BEARING.** AgX's tail is
 * outset-matrix → `pow(max(0,c), 2.2)` → Rec2020→sRGB. Both matrices carry negative
 * off-diagonals, so a bright saturated colour can leave that multiply with a negative
 * channel. Removing `max(0, ·)` would feed `sRGBTransferOETF`'s `pow(negative, 0.41666)`
 * → **NaN** → which then poisons the glare pyramid on the following frame.
 */

import { Fn, float, max, mix, uniform, vec3, vec4 } from "three/tsl";

/** Loose node type, as elsewhere in this folder — TSL's node types are not exported. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type U = any;

// ── three's AgX constants, copied verbatim ───────────────────────────────────
// From `three/src/nodes/display/ToneMappingFunctions.js`. Byte-identical in r183.2 and
// r185.1 (checked), so there is no version drift to track here.
const AGX_MIN_EV = -12.47393;
const AGX_MAX_EV = 4.026069;
const AGX_SPAN = AGX_MAX_EV - AGX_MIN_EV; // 16.5 stops

/** three's fixed contrast curve. Kept for the A/B and for the CPU gate's reference. */
export function agxPolynomial(x: number): number {
  return (
    15.5 * x ** 6 -
    40.14 * x ** 5 +
    31.96 * x ** 4 -
    6.868 * x ** 3 +
    0.4298 * x ** 2 +
    0.1191 * x -
    0.00232
  );
}

// ── the parametric sigmoid ───────────────────────────────────────────────────

/** `t` of scene-linear middle grey — the pivot's x, by definition not by fit. */
export const PIVOT_X = (Math.log2(0.18) - AGX_MIN_EV) / AGX_SPAN; // 0.60606057
/** The polynomial's own value at middle grey, so the anchor is inherited exactly. */
export const PIVOT_Y = agxPolynomial(PIVOT_X); // 0.49673057

/**
 * Slope through the pivot and the two arm powers.
 *
 * Fitted (Nelder-Mead, 6 starts) to minimise the **maximum delivered code-value error**
 * against `agxPolynomial` over the whole window, with the pivot pinned. Result: 2.429/255.
 * ⚠ These three numbers are a FIT, not physics — they exist to preserve a look that was
 * already judged. Do not re-derive them from first principles; re-fit them if the
 * reference curve ever changes, and re-run `__lum.tonecurve()`.
 */
export const SLOPE = 1.923234;
export const TOE_POWER = 3.223664;
export const SHOULDER_POWER = 5.123080;

/** The measured agreement, asserted by `__lum.tonecurve()` so it cannot rot silently. */
export const MAX_CODE_DELTA_VS_POLY = 2.429;

/**
 * Display peak in **display-LINEAR multiples of reference white**. 1 = SDR.
 *
 * ⚠⚠ A UNIFORM, NEVER A CONSTANT — deliberately. On macOS/EDR the available headroom
 * *shrinks as the brightness slider rises*, so the peak is a runtime quantity that can
 * change while the game is running. Phase 6d's calibration screen writes it; nothing here
 * caches it.
 */
const uDisplayPeak = /*#__PURE__*/ uniform(1);

/** `Hs` — the peak expressed in the sigmoid's γ2.2 space. Updated with the peak. */
const uDisplayPeakSigmoid = /*#__PURE__*/ uniform(1);

let _peak = 1;
let _curve: "parametric" | "poly" = "parametric";

/**
 * One arm of the sigmoid. Slope `s` at `d = 0`, asymptote `L` as `d → ∞`.
 *
 * ⚠ `max(d, 0)` is not defensive tidiness — it is what makes the *unselected* arm finite.
 * Both arms are evaluated for every pixel and one is discarded; without the clamp the
 * discarded one computes `pow(negative, p)` = NaN, and while `mix` with a boolean does
 * compile to `select` (which drops NaN), relying on that is a bet on the code generator.
 */
const sigmoidArm = /*#__PURE__*/ Fn(([d, s, L, p]: U[]) => {
  // Method chaining rather than the free `pow(a, b)`: TSL types the free form as
  // float-only, and every value here is a vec3 (the curve is per channel).
  const q: U = vec3(max(d, 0.0)).mul(s).div(L).toVar();
  const denom: U = float(1.0).add(q.pow(p)).pow(float(1.0).div(p));
  return (L as U).mul(q).div(denom);
});

/**
 * The contrast curve, per channel, in the normalised-log domain.
 *
 * `t` is unclamped on purpose: the toe arm tends to 0 as `t → −∞` and the shoulder arm to
 * `Hs` as `t → +∞`, both monotonically (verified over t ∈ [−0.3, 1.8]). three's polynomial
 * needs `clamp(t, 0, 1)` because a 6th-order polynomial diverges outside its fit range;
 * this form does not, so the clamp goes and with it the hard corner at white.
 */
const contrast = /*#__PURE__*/ Fn(([t]: U[]) => {
  const xp = float(PIVOT_X);
  const yp = float(PIVOT_Y);
  const s = float(SLOPE);
  const toe = yp.sub(sigmoidArm(xp.sub(t), s, yp, float(TOE_POWER)));
  const shoulder = yp.add(
    sigmoidArm(t.sub(xp), s, uDisplayPeakSigmoid.sub(yp), float(SHOULDER_POWER)),
  );
  return mix(shoulder, toe, t.lessThan(xp));
});

/** three's polynomial as a node, for the runtime A/B. Needs its input clamped. */
const contrastPoly = /*#__PURE__*/ Fn(([t]: U[]) => {
  const x = vec3(t).clamp(0.0, 1.0).toVar();
  const x2 = x.mul(x).toVar();
  const x4 = x2.mul(x2).toVar();
  return float(15.5)
    .mul(x4.mul(x2))
    .sub(x4.mul(x).mul(40.14))
    .add(x4.mul(31.96))
    .sub(x2.mul(x).mul(6.868))
    .add(x2.mul(0.4298))
    .add(x.mul(0.1191))
    .sub(0.00232);
});

/**
 * The display transform. Drop-in for `colour.toneMapping(AgXToneMapping)`.
 *
 * Structure follows three's `agxToneMapping` exactly, so a diff against it is short:
 * sRGB→Rec2020 → inset → log2 → normalise to the EV window → **contrast (ours)** →
 * outset → `pow(max(0,·), 2.2)` → Rec2020→sRGB → **lower clamp only**.
 *
 * ⚠ No `exposure` argument. three's node multiplies one in; ours does not, because
 * exposure is already applied upstream (`uPostExposure` × `localExposureNode()` in
 * `SpaceRenderer`) and taking it here as well would double-count it.
 */
export function displayTransformNode(color: U): U {
  // three builds `mat3` from COLUMN vectors, so these are transposed relative to how the
  // matrices are usually written. Copied in three's own column order to keep the diff
  // trivial — do not "fix" the layout.
  const SRGB_TO_REC2020 = [
    vec3(0.6274, 0.0691, 0.0164),
    vec3(0.3293, 0.9195, 0.088),
    vec3(0.0433, 0.0113, 0.8956),
  ];
  const REC2020_TO_SRGB = [
    vec3(1.6605, -0.1246, -0.0182),
    vec3(-0.5876, 1.1329, -0.1006),
    vec3(-0.0728, -0.0083, 1.1187),
  ];
  const INSET = [
    vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859),
  ];
  const OUTSET = [
    vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405),
  ];
  const mul3 = (m: U[], v: U): U =>
    m[0].mul(v.x).add(m[1].mul(v.y)).add(m[2].mul(v.z));

  const rec2020 = mul3(SRGB_TO_REC2020, vec3(color.rgb));
  const inset = mul3(INSET, rec2020);
  // 1e-10 matches three's floor; it only exists so log2 has a finite argument.
  const t = max(inset, 1e-10).log2().sub(AGX_MIN_EV).div(AGX_SPAN);

  const shaped = _curve === "poly" ? contrastPoly(t) : contrast(t);

  const outset = mul3(OUTSET, shaped);
  // ⚠ `max(·, 0)` HERE and the one below are the NaN guards. See the module header.
  const displayLinear: U = max(outset, 0.0).pow(2.2);
  const srgb = max(mul3(REC2020_TO_SRGB, displayLinear), 0.0);

  // ⚠⚠ THE WHOLE POINT: the ceiling is `uDisplayPeak`, not 1.0. At peak 1 this is
  // numerically the same clamp three applies; above 1 it is what lets the extended-range
  // canvas receive anything at all.
  return vec4(srgb.min(uDisplayPeak), color.a);
}

// ── control surface ──────────────────────────────────────────────────────────

/**
 * Set the display peak, in display-linear multiples of reference white (1 = SDR).
 *
 * Clamped to [1, 64]: below 1 would darken the image rather than describe a display, and
 * 64 is 6 stops, past any panel that exists. Writes a uniform, so no recompile.
 */
export function setDisplayPeak(peak: number): void {
  const p = Number.isFinite(peak) ? Math.min(Math.max(peak, 1), 64) : 1;
  _peak = p;
  uDisplayPeak.value = p;
  uDisplayPeakSigmoid.value = Math.pow(p, 1 / 2.2);
}

export const getDisplayPeak = (): number => _peak;

let _onCurveChange: (() => void) | null = null;

/**
 * Let the owner of the post graph rebuild it when the curve is swapped.
 *
 * The curve is baked into the node graph (unlike the peak, which is a uniform), so a swap
 * needs a recompile. Registered by `SpaceRenderer`'s post-graph effect so `__lum` does not
 * have to know about the pipeline.
 */
export function setDisplayCurveRebuildHook(fn: (() => void) | null): void {
  _onCurveChange = fn;
}

/**
 * Swap the contrast curve. ⚠ Recompiles the post graph (WebGPU shader-compilation
 * stutter), so this is a debug/A-B path only — never a per-frame or per-setting call.
 */
export function setDisplayCurve(curve: "parametric" | "poly"): void {
  if (curve === _curve) return;
  _curve = curve;
  _onCurveChange?.();
}

export const getDisplayCurve = (): "parametric" | "poly" => _curve;

/** CPU twin of one channel of the curve, for the gate. */
export function contrastCpu(t: number, peakSigmoid?: number): number {
  const Hs = peakSigmoid ?? uDisplayPeakSigmoid.value;
  const arm = (d: number, L: number, p: number): number => {
    const q = (SLOPE * Math.max(d, 0)) / L;
    return (L * q) / Math.pow(1 + Math.pow(q, p), 1 / p);
  };
  return t < PIVOT_X
    ? PIVOT_Y - arm(PIVOT_X - t, PIVOT_Y, TOE_POWER)
    : PIVOT_Y + arm(t - PIVOT_X, Hs - PIVOT_Y, SHOULDER_POWER);
}

/**
 * CPU twin of the whole transform for a NEUTRAL scene-linear value.
 *
 * ⚠ Reads `uDisplayPeakSigmoid.value` rather than recomputing it from `_peak`. Phase 7's
 * twin diverged on its first run for exactly that reason — a twin that re-derives *any*
 * uniform is a second implementation, and it reported `s = 1.000` where the shader used
 * 0.17. Neutrals only: both matrices are row-sum 1, so they are identity on greys, which
 * is why this can skip them and still be exact.
 */
export function displayTransformNeutralCpu(sceneLinear: number): number {
  const t =
    (Math.log2(Math.max(sceneLinear, 1e-10)) - AGX_MIN_EV) / AGX_SPAN;
  const y =
    _curve === "poly"
      ? agxPolynomial(Math.min(Math.max(t, 0), 1))
      : contrastCpu(t);
  return Math.min(Math.pow(Math.max(y, 0), 2.2), uDisplayPeak.value);
}

/** sRGB OETF, so the gate can quote DELIVERED code values rather than sigmoid units. */
export const srgbEncode = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

export type DisplayTransformStatus = {
  curve: "parametric" | "poly";
  peak: number;
  peakStops: number;
  peakSigmoid: number;
  pivotX: number;
  pivotY: number;
  /** Scene-linear value that maps to middle grey — should be 0.18 by construction. */
  pivotSceneLinear: number;
  slope: number;
  toePower: number;
  shoulderPower: number;
  /** Where AgX's own window ends, in scene-linear. */
  windowWhiteClip: number;
  windowStops: number;
};

export function displayTransformStatus(): DisplayTransformStatus {
  return {
    curve: _curve,
    peak: _peak,
    peakStops: Math.log2(_peak),
    peakSigmoid: uDisplayPeakSigmoid.value,
    pivotX: PIVOT_X,
    pivotY: PIVOT_Y,
    pivotSceneLinear: Math.pow(2, PIVOT_X * AGX_SPAN + AGX_MIN_EV),
    slope: SLOPE,
    toePower: TOE_POWER,
    shoulderPower: SHOULDER_POWER,
    windowWhiteClip: Math.pow(2, AGX_MAX_EV),
    windowStops: AGX_SPAN,
  };
}
