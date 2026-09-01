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
  ran: false,
};
