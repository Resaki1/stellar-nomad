/**
 * `hdrCalibration` — Phase 6d: the test pattern that measures the display's HDR headroom.
 *
 * See [`docs/HDR_OUTPUT_PLAN.md`](../../../docs/HDR_OUTPUT_PLAN.md) §6.2.
 *
 * ── WHY THIS CANNOT BE AN HTML OVERLAY ──────────────────────────────────────
 * 🔑🔑 **The HUD is HTML, and HTML cannot exceed reference white.** A CSS colour tops out
 * at `#fff` = 1.0 = HDR reference white, so a patch drawn in the DOM can never test
 * headroom — it would measure nothing at all and *look* like it worked. The pattern has to
 * be emitted through the WebGPU canvas, which is why this is a node and not a component.
 *
 * ── AND WHY IT BYPASSES THE DISPLAY TRANSFORM ───────────────────────────────
 * ⚠ This replaces `pipeline.outputNode` wholesale. It does **not** run through
 * `displayTransform` — deliberately. We are measuring the **display**, not our tone curve;
 * routing the pattern through a sigmoid would fold the curve's shoulder into the answer
 * and the "where does it stop getting brighter" reading would be about AgX, not the panel.
 *
 * So the values here are **display-linear multiples of reference white**, the same units as
 * `Settings.hdrPeakStops` and `setDisplayPeak`. The pipeline's `renderOutput` still applies
 * the sRGB encode on the way to the canvas, which is exactly what the normal path does, so
 * the encode is not being skipped — only the tone curve is.
 *
 * ── WHAT IT MEASURES ────────────────────────────────────────────────────────
 * A **field with a patch in it**, both driven by the slider: the field sits at `2^stops`
 * and the patch at `2^(stops + 0.25)`. While the display can still show the difference the
 * patch is visible; once the slider passes the display's peak both values clip to the same
 * thing and **the patch disappears into its surround**. The lowest slider position where it
 * vanishes is the headroom.
 *
 * ⚠⚠ **THIS REPLACED A 17-PATCH STEP WEDGE, ON AUTHOR FEEDBACK, AND THE REASON GENERALISES.**
 * The wedge showed a fixed ladder of patches and moved only a marker; the author's report was
 * *"the slider does not seem to do anything on that page… the whiteness does not seem to
 * update"*. It was working as designed — and the design was wrong.
 * 🔑 **A step wedge asks "are these two bright patches different?", which is simultaneous
 * discrimination between large bright fields — the hardest form of the question.** What the
 * author had already done successfully by hand was far easier: *change one thing and watch
 * whether it changes.* Change detection while dragging beats static discrimination, and it is
 * also the pattern every console/OS calibration screen uses ("raise until the test pattern is
 * no longer visible"). The slider must drive the **brightness**, not a cursor.
 *
 * 🔑 This is not a guess at a procedure — the author already performed it by hand on the
 * sun and got a consistent answer: 2 stops made an obvious difference, 3 stops *"a small
 * difference too but not much"*, implying ~2–2.5 stops. `log2(1600/203)` = 2.98 is the
 * XDR's theoretical maximum at minimum SDR brightness and EDR headroom falls as brightness
 * rises, so that reading matches the model. This screen just makes it repeatable, puts a
 * number on it, and works on a panel with no sun in frame.
 *
 * ⚠⚠ **A calibrated value is only valid at the screen brightness it was taken at.** On
 * macOS/EDR the headroom *shrinks as the brightness slider rises*. The UI says so; there is
 * nothing this module can do about it beyond being re-runnable.
 *
 * ── THE SECOND WEDGE ────────────────────────────────────────────────────────
 * A log-spaced black-floor ramp from 1e-5 to 1e-3 display-linear. Informational — it writes
 * nothing — but it straddles **1.758e-4, the display-linear value AgX crushes below**, and
 * `LIGHTING_PLAN` records that the night-side floor sits only 0.4 stops above it. So "how
 * far down can this panel actually go" is a number the night-side work wants, and this is
 * the only place it can be read.
 */

import { Fn, float, screenUV, uniform, vec4 } from "three/tsl";

/** Loose node type, as elsewhere in this folder. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type U = any;

/** Widest headroom the slider reaches, in stops. 4 = 16× reference white. */
export const CAL_MAX_STOPS = 4;
/**
 * How far above the field the inner patch sits, in stops. 0.25 ≈ a **19% luminance step** —
 * comfortably above threshold while unclipped, so the point where it vanishes is sharp.
 */
export const CAL_STEP_STOPS = 0.25;

/** Display-linear value of middle grey as our transform delivers it — the surround. */
const SURROUND = 0.2145;
/**
 * Black-floor wedge, expressed in **8-bit code values** rather than display-linear.
 *
 * ⚠ A first draft ran the ramp log-spaced from 1e-5 to 1e-3 display-linear, which sounded
 * principled and rendered as **solid black**: 1e-3 display-linear encodes to 1.1 of 255, so
 * the entire ramp lived inside the first code value. Code values are the unit the question
 * is actually asked in — "the darkest step you can still separate from black is N/255" —
 * and they make the readout directly interpretable.
 *
 * Below code 10 the sRGB transfer is its linear segment, so display-linear = (n/255)/12.92.
 * For reference, AgX crushes below display-linear 1.758e-4, which is **code 0.58** — i.e.
 * the tone curve's black floor is finer than one code value, so what limits the night side
 * is this panel, not the curve.
 */
const FLOOR_STEPS = 12;

// Layout in `screenUV`. Kept in one place so the marker and the wedge cannot drift apart.
// ⚠ `screenUV.y` increases DOWNWARD here (verified on device — a first draft put the
// headroom band at y 0.56-0.72 and it rendered *below* the black-floor band at 0.30-0.42,
// contradicting the on-screen copy). Small y = top.
// ⚠ Everything must stay above y ≈ 0.50: the controls panel is bottom-anchored and would
// otherwise cover the thing being measured.
const FLOOR_X0 = 0.24;
const FLOOR_X1 = 0.76;
const FLOOR_Y0 = 0.06;
const FLOOR_Y1 = 0.11;
const FIELD_X0 = 0.24;
const FIELD_X1 = 0.76;
const FIELD_Y0 = 0.17;
const FIELD_Y1 = 0.45;
const PATCH_X0 = 0.44;
const PATCH_X1 = 0.56;
const PATCH_Y0 = 0.25;
const PATCH_Y1 = 0.37;
/**
 * Corner marks just outside the patch, drawn at the surround value so they read as dark
 * against any field brightness.
 *
 * ⚠ Not decoration. Once the slider passes the display's peak the patch is *supposed* to
 * become invisible — which leaves the player with nothing to look at and no way to tell
 * "vanished" from "I am looking in the wrong place". An outline ON the patch would keep it
 * permanently visible and destroy the measurement; marks OUTSIDE it point without marking.
 */
const MARK_GAP = 0.014;
const MARK_LEN = 0.016;

/**
 * Brightness of the test field, in stops above reference white. Driven by the slider.
 *
 * A uniform, so dragging updates the pattern with no shader recompile — which is what makes
 * the change-detection procedure usable at all.
 */
const uCalStops = /*#__PURE__*/ uniform(2);

export function setCalibrationStops(stops: number): void {
  uCalStops.value = Number.isFinite(stops)
    ? Math.min(Math.max(stops, 0), CAL_MAX_STOPS)
    : 2;
}

/**
 * The full-screen test pattern, in display-linear multiples of reference white.
 *
 * Assembled by masked `mix`es rather than branches: a fullscreen quad has no coherent
 * branching to win anyway, and this keeps every band's value independent of the others so
 * a layout change cannot silently alter a patch's brightness.
 */
export const hdrCalibrationNode = /*#__PURE__*/ Fn(() => {
  const x = screenUV.x.toVar();
  const y = screenUV.y.toVar();

  // ⚠ Masks use the bool node's own `.select(ifTrue, ifFalse)`, which compiles straight to
  // WGSL `select()`. An earlier draft multiplied `float(boolNode)` terms together and
  // rendered a black screen; `mix(a, b, boolNode)` is the same thing but is not in TSL's
  // typed overloads. `.select()` is both correct and typed — do not go back to either.
  const out = float(SURROUND).toVar();

  const inBox = (x0: number, x1: number, y0: number, y1: number): U =>
    x
      .greaterThanEqual(x0)
      .and(x.lessThanEqual(x1))
      .and(y.greaterThanEqual(y0))
      .and(y.lessThanEqual(y1));

  // ── the field, and the patch one step above it ─────────────────────────────
  const field = float(2.0).pow(uCalStops);
  const patch = float(2.0).pow(uCalStops.add(CAL_STEP_STOPS));
  out.assign(inBox(FIELD_X0, FIELD_X1, FIELD_Y0, FIELD_Y1).select(field, out));

  // Corner marks first, so the patch can never paint over them.
  for (const [cx, cy] of [
    [PATCH_X0, PATCH_Y0],
    [PATCH_X1, PATCH_Y0],
    [PATCH_X0, PATCH_Y1],
    [PATCH_X1, PATCH_Y1],
  ] as const) {
    const sx = cx === PATCH_X0 ? -1 : 1;
    const sy = cy === PATCH_Y0 ? -1 : 1;
    const ax = cx + sx * MARK_GAP;
    const ay = cy + sy * MARK_GAP;
    out.assign(
      inBox(
        Math.min(ax, ax + sx * MARK_LEN),
        Math.max(ax, ax + sx * MARK_LEN),
        Math.min(ay, ay + sy * 0.004),
        Math.max(ay, ay + sy * 0.004),
      ).select(float(SURROUND), out),
    );
    out.assign(
      inBox(
        Math.min(ax, ax + sx * 0.003),
        Math.max(ax, ax + sx * 0.003),
        Math.min(ay, ay + sy * MARK_LEN),
        Math.max(ay, ay + sy * MARK_LEN),
      ).select(float(SURROUND), out),
    );
  }

  out.assign(inBox(PATCH_X0, PATCH_X1, PATCH_Y0, PATCH_Y1).select(patch, out));

  // ── black-floor ramp (informational) ──────────────────────────────────────
  // Code value 0..FLOOR_STEPS-1, converted to display-linear so the pipeline's sRGB encode
  // brings it back to exactly that code. All of these sit in the transfer's linear segment.
  const ft = x.sub(FLOOR_X0).div(FLOOR_X1 - FLOOR_X0).toVar();
  const fCode = ft.mul(FLOOR_STEPS).floor();
  const fVal = fCode.div(255.0 * 12.92);
  const fGutter = ft.mul(FLOOR_STEPS).fract().lessThan(0.08);
  const inFloor = inBox(FLOOR_X0, FLOOR_X1, FLOOR_Y0, FLOOR_Y1);
  out.assign(inFloor.and(fGutter.not()).select(fVal, out));
  out.assign(inFloor.and(fGutter).select(float(0.0), out));

  return vec4(out, out, out, 1.0);
}) as unknown as () => U;
