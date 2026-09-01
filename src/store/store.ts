import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export type SetAtom<Args extends unknown[], Result> = (...args: Args) => Result;

export type Movement = {
  yaw: number;
  pitch: number;
  speed: number;
};

export type Settings = {
  invertPitch: boolean;
  toneMapping: boolean;
  /**
   * MSAA on the scaled-scene target (defect D14). 4× when on.
   *
   * ⚠ Recreates the render target, so it is read at RT construction rather than
   * per frame — but unlike `perf` it does NOT need a reload, because the target
   * lives in a useMemo keyed on this value.
   */
  antialias: boolean;
  fps: boolean;
  /**
   * Per-pass GPU/CPU profiler (dev only). Read at renderer construction, not
   * live — GPU timestamp queries can only be requested when the WebGPURenderer
   * is created, so toggling this needs a reload. See
   * `space/perf/perfProfiler.ts` and `docs/PERF_MEASUREMENT.md`.
   */
  perf: boolean;
  /**
   * Exposure compensation in STOPS (+1 = twice as bright), applied on top of the
   * metered exposure. Dev-only for now; see docs/LIGHTING_PLAN.md §3.4 and the
   * "exposure" section of Settings → Dev. 0 = the calibrated neutral.
   */
  exposureStops: number;
  /**
   * Veiling-glare strength as a MULTIPLE of the physical straylight fraction
   * (`GLARE_STRAYLIGHT_FRACTION` = 0.03, "a few percent of all light entering the
   * eye is scattered"). 1 = physically calibrated, 0 = off.
   *
   * 🔑 A PLAYER SETTING BY REQUEST, and it is the right one to expose: glare is
   * what makes the sun punishing to look at, which is deliberate feel — but it
   * also veils asteroids and targets, so how much is tolerable is a matter of
   * taste and of what the player is doing. The SHAPE stays derived
   * (`glarePass.ts`); this scales only the amount.
   *
   * ⚠ Feeds a UNIFORM, never the post graph's `useEffect` deps — a settings
   * change here must not recompile shaders (WebGPU compilation stutter).
   */
  glare: number;
  /**
   * Phase 6a — request an extended-range (HDR) drawing buffer.
   *
   * ⚠ Needs a RELOAD, like `perf`: the canvas pixel format is fixed when the
   * `GPUCanvasContext` is configured, which happens once inside a caching getter in
   * three's `WebGPUBackend`. So this is read from localStorage at renderer construction
   * (`isHdrOutputRequested()`), not from this atom.
   *
   * 🔑 OFF by default even when `(dynamic-range: high)` is true, deliberately. That
   * media query is a *capability* test, not a headroom test — it is true for a ~400-nit
   * "HDR400" panel with no local dimming (≈1 stop of real headroom), where HDR usually
   * looks WORSE than SDR. Auto-enabling would degrade the game on hardware that
   * advertises the feature. See docs/HDR_OUTPUT_PLAN.md §6.1.
   */
  hdrOutput: boolean;
  /**
   * HDR headroom actually used, in STOPS above reference white. Only has an effect when
   * the extended-range canvas is active; ignored on the SDR path.
   *
   * 🔑 DEFAULT 2 STOPS (4× reference white), and that is a MEASUREMENT, not a guess.
   * On the XDR, peak 4× (2 stops) makes the sun's core visibly punch out; peak 8× (3 stops)
   * adds "a small difference too but not much". That saturation point IS the display's real
   * headroom — beyond it the compositor clips, so extra stops only compress more scene range
   * into the same visible span. `log2(1600/203)` = 2.98 is the XDR's theoretical maximum and
   * it falls as screen brightness rises, so ~2 is the honest conservative default.
   *
   * ⚠ Feeds a UNIFORM (`setDisplayPeak`), never the post graph's `useEffect` deps — changing
   * it must not recompile shaders.
   */
  hdrPeakStops: number;
  initial: boolean;
};

export const settingsAtom = atomWithStorage<Settings>("settings", {
  invertPitch: false,
  // `toneMapping: false` selects Khronos PBR Neutral, which crushes everything
  // above linear ≈4 — wrong for a scene whose own reference white is ~20 and whose
  // sun disc is ~1e5. AgX is the correct default.
  // ⚠ `bloom` used to live here and was DELETED with Phase 8 (glarePass.ts replaced
  // it). A stale `bloom` key may still sit in a returning player's saved blob; it is
  // simply ignored, and `atomWithStorage` needs no migration for a removed key.
  toneMapping: true,
  // D14: the scene had NO anti-aliasing of any kind, which the user reported as
  // "planets look really pixelated at the edges until I get pretty close".
  antialias: true,
  fps: false,
  perf: false,
  exposureStops: 0,
  // 1 = the physically derived straylight fraction. Phase 8 landed as the
  // replacement for additive bloom, so this is on by default at its physical value.
  glare: 1,
  // Opt-in; see the doc comment on `Settings.hdrOutput` for why detection is not enough.
  hdrOutput: false,
  // 2 stops = 4x reference white. See the doc comment: measured as where the benefit
  // saturates on an XDR panel, and conservative for anything dimmer.
  hdrPeakStops: 2,
  initial: true,
});

export const settingsIsOpenAtom = atom(false);

/**
 * Phase 6d — the HDR calibration screen is open.
 *
 * ⚠ Read by `SpaceRenderer`'s post-graph effect, not just by the HUD: the test pattern
 * REPLACES `pipeline.outputNode`, because HTML cannot exceed reference white and so cannot
 * measure headroom. Toggling this rebuilds the post graph (a one-off shader compile on a
 * modal screen, which is an acceptable place for it).
 */
export const hdrCalibrationOpenAtom = atom(false);

export const movementAtom = atom<Movement>({
  yaw: 0,
  pitch: 0,
  speed: 1,
});

export const hudInfoAtom = atom({
  speed: 0,
});

export const shipHealthAtom = atom(100);
