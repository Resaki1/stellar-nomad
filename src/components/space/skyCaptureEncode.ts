/**
 * SKY CAPTURE ENCODE — the sky cube's own numeric scale, separated from the
 * player-facing display lift.
 *
 * See [`docs/STAR_RENDERING_PLAN.md`](../../../docs/STAR_RENDERING_PLAN.md) §15.
 *
 * ── WHY THIS EXISTS: ONE CONSTANT HAD THREE JOBS ────────────────────────────
 * `STAR_ARTISTIC_GAIN = 1024` was read as a display lie with two jobs (a flat lift
 * and a per-star compression). It had a THIRD, and it was purely numerical:
 * `skySpecular`'s cube capture relied on it to keep the sky inside half-float.
 * The sky is ~1.3e-8 game units against RGBA16F's smallest subnormal of 2⁻²⁴ =
 * 5.96e-8, so a capture at unit scale stores **black**. R7b replaced the flat gain
 * with an adaptation-driven lift that is correctly 1.0 in deep space — and the cube
 * went dark with it, which is why R7b had to be parked at `mode: "legacy"`.
 *
 * 🔑 The two quantities were never the same question:
 *   • the LIFT answers "how visible must the sky be to the player" — it belongs to
 *     adaptation, changes every frame, and is a deliberate lie;
 *   • the ENCODE answers "where in half-float's range do these numbers live" — it
 *     belongs to the storage format, must be FIXED for the life of a capture, and is
 *     not a lie at all because it is divided straight back out on read.
 *
 * ── 🐛 AND IT WAS HIDING A SECOND DEFECT ────────────────────────────────────
 * `skySpecular`'s header claimed "`uPreExposure` stays OUT of the texture and is
 * applied per frame through the environment node". Nothing implemented that: both
 * sky materials multiply by `uPreExposure` in their graphs, so the capture baked in
 * the capture frame's pre-exposure AND the environment node applied the live value
 * again — **pre-exposure squared**.
 *
 * ⚠ Dormant at startup and detonating later, which is why it survived: the capture
 * runs ~5 frames in, before the exposure follower's first async readback lands, so
 * `preExposure ≈ 1` and the squaring is invisible. The first `invalidateSkyCube()`
 * (an interstellar jump) re-captures at the LIVE pre-exposure — order 1e5 in deep
 * space, 0.05 near a star — and the hull's reflections are then wrong by that
 * factor. No gate would have caught it: the harness checks the capture's INPUTS
 * (`uPsfNorm`) and never its output.
 *
 * ── HOW ─────────────────────────────────────────────────────────────────────
 * `uSkyCaptureScale` is multiplied into both sky graphs LAST, and is exactly 1.0
 * except while a capture is running, when it is set to `scale / displayFactor`.
 * Since both graphs end in `× uPreExposure × uStarLift`, that cancels the two live
 * factors and leaves `radiance × scale` — a quantity that depends on nothing
 * per-frame. `uSkyEnvDecode = 1/scale` on the environment node returns it to
 * physical, and the live `uPreExposure × uStarLift` are re-applied there.
 *
 * ⚠ REJECTED: temporarily overwriting `uPreExposure.value` and `uStarLift.value`
 * during the capture. It needs no shader change at all, and that is exactly the
 * problem — it makes the cube's scale invisible at every site that determines it,
 * and it mutates two globals that every other material in the scene reads. An
 * explicit uniform costs one multiply in two shaders and cannot leak.
 *
 * ── THE SCALE IS DERIVED, NOT AUTHORED ──────────────────────────────────────
 * `skyCaptureScaleFor` places the sky's MEASURED mean radiance at 1.0 in the stored
 * texture, rounded to a power of two. Two properties matter:
 *
 *  • **It adapts.** The mean comes from `skyIrradiance`'s bake of the actual loaded
 *    panorama, so a different sky asset — or a procedurally generated one — gets a
 *    correct scale with no table to update.
 *  • **The round trip is bit-exact.** A power of two divides out with no rounding
 *    whatever, so decoupling the encode introduces ZERO photometric error. That is
 *    worth the rounding: the placement only needs to be right to a few stops.
 *
 * MEASURED ON DEVICE by `__lum.skyCapture()` (mean 1.3466e-8 game units ⇒ scale 2²⁶,
 * all six faces, solid-angle weighted):
 *
 *     stored value                       encoded    half-float verdict
 *     Ω-weighted mean                     0.9864    centre of range
 *     max                                  25.43    2.58e3× under 65504 (11.3 stops)
 *     min non-zero                        1.31e-3   21.5× over the smallest normal
 *     texels stored as exactly 0            1 / 393,216
 *     texels in the subnormals              0 / 393,216
 *
 * ⚠ Two predictions of mine were off, both harmlessly, and both worth recording:
 *  • the max is the PANORAMA's brightest texel (25.4), not Sirius' PSF peak in a cube
 *    face (predicted 20.8) — the galactic core sets the ceiling constraint here, not
 *    the brightest star, so a brighter catalogue would not be what pushes this over;
 *  • the darkest non-zero texel is 1.31e-3, not the 7.7e-3 I predicted from "8-bit
 *    level 1". The panorama is UASTC, which decodes to finer values than the sRGB
 *    quantisation step — so the dim-end margin is 4.4 stops, not 7.0. Still ample,
 *    but do not reason about this asset as if it were 8-bit.
 *
 * The whole sky spans only ~14 stops in the cube while half-float's normal range
 * spans 27, so the placement is not delicate — it just has to be done at all.
 */

import { uniform } from "three/tsl";

/**
 * Where the sky's mean radiance is placed in the stored texture.
 *
 * 1.0 centres it: half-float's normals run 6.1e-5 … 65504, whose geometric centre
 * is ~2.0, and the sky's own range is far narrower than the format's.
 */
const ENCODE_TARGET = 1.0;

/**
 * Multiplied into the sky materials LAST. Exactly 1.0 on screen; `scale /
 * (preExposure × lift)` while a cube face is being drawn.
 *
 * ⚠ Read by BOTH sky graphs — `Stars/StarField` and `Skybox/MilkyWaySkybox`. Adding
 * a third object to `SKY_CAPTURE_LAYER` means adding this to its graph too, or that
 * object alone captures at the wrong scale.
 */
export const uSkyCaptureScale = /*#__PURE__*/ uniform(1);

/** `1/scale` — applied by `skySpecular`'s environment node. */
export const uSkyEnvDecode = /*#__PURE__*/ uniform(1);

let _scale = 0;
let _captureDisplayFactor = 0;
let _capturing = false;

/**
 * Encode scale for a sky whose mean radiance is `meanRadiance` game units, as a
 * power of two. 0 when the mean is not known yet — the caller must not capture.
 */
export function skyCaptureScaleFor(meanRadiance: number): number {
  if (!(meanRadiance > 0) || !Number.isFinite(meanRadiance)) return 0;
  return 2 ** Math.round(Math.log2(ENCODE_TARGET / meanRadiance));
}

/**
 * Run `body()` with the sky materials writing `radiance × scale` — free of this
 * frame's pre-exposure and display lift.
 *
 * @param scale         from `skyCaptureScaleFor`; must be > 0
 * @param displayFactor `getPreExposure() × getStarLift()`, i.e. the product both
 *        sky graphs apply, which this cancels
 *
 * ⚠ Restores in a `finally`, and the on-screen render of this same frame happens
 * AFTER the capture returns — leaving the capture scale live for one frame would
 * paint the sky at ~5e7× and blow the glare pyramid to +Inf.
 *
 * ⚠⚠ It deliberately does NOT touch the decode. The capture is amortised over six
 * frames, and the PMREM the materials sample still holds the PREVIOUS set until the
 * last face lands — so publishing the new decode here would pair a new scale with
 * old texels for six frames. Harmless while the scale is unchanged, wrong by the
 * ratio the moment it is not. `commitSkyCaptureScale` is the other half.
 */
export function withSkyCaptureEncode<T>(
  scale: number,
  displayFactor: number,
  body: () => T,
): T {
  const safe = displayFactor > 0 && Number.isFinite(displayFactor) ? displayFactor : 1;
  uSkyCaptureScale.value = scale / safe;
  _captureDisplayFactor = safe;
  _capturing = true;
  try {
    return body();
  } finally {
    uSkyCaptureScale.value = 1;
    _capturing = false;
  }
}

/**
 * Publish the decode for a COMPLETED set of faces. Call in the same step that
 * invalidates the PMREM, so the scale and the texels it applies to change together.
 */
export function commitSkyCaptureScale(scale: number): void {
  _scale = scale;
  uSkyEnvDecode.value = 1 / scale;
}

/** The scale the current cube was encoded with. 0 before the first capture. */
export const getSkyCaptureScale = (): number => _scale;

/** True only while cube faces are being drawn. */
export const isCapturingSky = (): boolean => _capturing;

/** Live state for `__lum.skyCapture()`. */
export function skyCaptureEncodeStatus(): {
  scale: number;
  decode: number;
  /** Must be exactly 1 — a power of two divides out without rounding. */
  roundTrip: number;
  /** `preExposure × lift` witnessed at capture time; must not affect the texels. */
  captureDisplayFactor: number;
  /** What the graphs are multiplying by right now. Must be 1 outside a capture. */
  liveCaptureScale: number;
  encodeTarget: number;
} {
  return {
    scale: _scale,
    decode: uSkyEnvDecode.value as number,
    roundTrip: _scale * (uSkyEnvDecode.value as number),
    captureDisplayFactor: _captureDisplayFactor,
    liveCaptureScale: uSkyCaptureScale.value as number,
    encodeTarget: ENCODE_TARGET,
  };
}
