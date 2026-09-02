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
  sizedBy: "true" | "pixelFloor" | "halfFloatCeiling";
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
  /** What the peak WOULD have been at the disc's true size. */
  unspreadPeak: number;
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
  unspreadPeak: 0,
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
