/**
 * Live star LOD / shell-clamp state, published by `Star.tsx` and read by
 * `__lum.starLod()`.
 *
 * ⚠ A plain leaf module, not an export from `Star.tsx`: importing a `"use client"`
 * component module into `lumHarness` yielded a SECOND module instance, so the
 * harness read a status object the mounted component never wrote (it reported
 * "has not run a frame" while the star was rendering). Same pattern as
 * `sunOcclusion.ts` — the component pushes, the harness reads.
 */

export type StarLodStatus = {
  distAu: number;
  distScaled: number;
  /** True angular diameter of the disc, in drawing-buffer pixels. */
  discPx: number;
  tier: "disc" | "point";
  /** 1 = drawn at its true position; < 1 = projected onto the shell. */
  shellScale: number;
  drawnAtScaled: number;
  clampScaled: number;
  farScaled: number;
  coreRadianceGame: number;
  starVis: number;
  /** Diameter the disc is actually DRAWN at, buffer px. ≥ discPx. */
  renderPx: number;
  /** Which limit set `renderPx`. */
  sizedBy: "true" | "pixelFloor" | "halfFloatCeiling" | "releasing";
  /** This frame's source pre-exposure. */
  preExposure: number;
  /**
   * Peak value written into the scene buffer, **after the blackbody tint** —
   * i.e. the brightest CHANNEL, which is the quantity that must fit in
   * half-float. Reporting the untinted scalar hid a +Inf red channel.
   */
  writtenPeak: number;
  /** Scalar cap the CPU sizes against: HALF_FLOAT_WRITE_MAX / max(r,g,b). */
  writeBudget: number;
  /**
   * Fraction of the star's flux that survives the write. 1 = none discarded.
   * < 1 is the residual P8d deficit, only possible while the disc is resolved.
   */
  fluxKept: number;
  /** Clipped flux handed to the analytic PSF (R3b), in buffer value · px². */
  pointGlareFlux: number;
  /** What the peak WOULD have been at the disc's true size. */
  unspreadPeak: number;
  /**
   * Peak at the size the disc is actually DRAWN at, before the guard clips.
   *
   * ⚠ `unspreadPeak / cap` is NOT the clip ratio when the pixel floor has spread
   * the disc — it conflates flux-conserving spread with clipping (95.7× vs a real
   * 2.06× at 30 AU). Compare THIS against the cap.
   */
  drawnPeak: number;
  /** Legacy hand-authored corona multiplier — 0 once R3 is judged. */
  coronaScale: number;
  /** False until Star has run a frame. */
  ran: boolean;
};

/** Mutated in place each frame — useFrame must not allocate. */
export const starLodStatus: StarLodStatus = {
  distAu: 0,
  distScaled: 0,
  discPx: 0,
  tier: "disc",
  shellScale: 1,
  drawnAtScaled: 0,
  clampScaled: 0,
  farScaled: 0,
  coreRadianceGame: 0,
  starVis: 1,
  renderPx: 0,
  sizedBy: "true",
  preExposure: 1,
  writtenPeak: 0,
  writeBudget: 60_000,
  fluxKept: 1,
  pointGlareFlux: 0,
  unspreadPeak: 0,
  drawnPeak: 0,
  coronaScale: 0,
  ran: false,
};

/**
 * Legacy hand-authored corona (`INNER_GLOW_FRAC` / `OUTER_GLOW_ABS` /
 * `GLOW_PAD` / `MIN_SCREEN_PX`), as a multiplier. **Default 0 — it is off.**
 *
 * 🔑 Retained ONLY so the R3 look change can be A/B'd at runtime without a
 * reload, in the `setGlare` / `setScotopic` idiom. It reproduces the shipped
 * look including its D25 bug (`OUTER_GLOW_ABS` carries no pre-exposure), because
 * an A/B against a *corrected* old version would compare something that never
 * shipped. **Delete this and the constants it gates once the judgement is in.**
 *
 * Measured reason it is going (STAR_RENDERING_PLAN §9.1): beyond ~5 AU the
 * corona carries **5.3× the star's entire physical flux**, because
 * `MIN_SCREEN_PX` pins the billboard at ~42 buffer px while the disc shrinks to
 * the 2.5 px floor.
 */
let _coronaScale = 0;

export const getStarCoronaScale = (): number => _coronaScale;

export function setStarCoronaScale(scale: number): void {
  _coronaScale = Number.isFinite(scale) && scale >= 0 ? scale : 0;
}

/**
 * R3b: analytic point-source glare on/off, for the A/B.
 */
let _pointGlare = true;
export const getStarPointGlareEnabled = (): boolean => _pointGlare;
export function setStarPointGlareEnabled(on: boolean): void {
  _pointGlare = on;
}

/**
 * Sign of the screen-space Y mapping for the analytic term's centre.
 *
 * ⚠ `uv()` in the post chain and NDC do not agree about which way Y runs across
 * three's backends, and this repo has already lost time to exactly that
 * (`screenUV.y increases DOWNWARD` in hdrCalibration). Rather than guess, the
 * flip is a runtime toggle: if the star's glare is centred above/below the star
 * by twice its offset from the middle of the screen, call
 * `__lum.starGlareFlipY(true)`.
 */
// ⚠ MEASURED ON DEVICE: `true` is correct for this backend. `uv()` in the post
// chain runs Y opposite to NDC here, so the default is the flipped one.
let _flipY = true;
export const getStarGlareFlipY = (): boolean => _flipY;
export function setStarGlareFlipY(on: boolean): void {
  _flipY = on;
}
