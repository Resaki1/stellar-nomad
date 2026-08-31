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
  initial: true,
});

export const settingsIsOpenAtom = atom(false);

export const movementAtom = atom<Movement>({
  yaw: 0,
  pitch: 0,
  speed: 1,
});

export const hudInfoAtom = atom({
  speed: 0,
});

export const shipHealthAtom = atom(100);
