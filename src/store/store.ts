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
  bloom: boolean;
  toneMapping: boolean;
  /**
   * MSAA on the scaled-scene target (defect D14). 4× when on.
   *
   * ⚠ Recreates the render target, so it is read at RT construction rather than
   * per frame — but unlike `perf` it does NOT need a reload, because the target
   * lives in a useMemo keyed on this value.
   */
  antialias: boolean;
  /**
   * SMAA on the TONE-MAPPED image (defect D14c) — a different failure mode from
   * `antialias`, not a redundant one.
   *
   * ⚠ MSAA resolves in LINEAR HDR and the tone curve is applied after, so on a
   * high-contrast edge (a lit planet against space) its first coverage step is
   * MEASURED at 73% of the whole output range — the edge stays effectively binary.
   * SMAA runs where a step is what the eye sees. Kept separate from `antialias`
   * until we know which one players actually notice.
   */
  antialiasPost: boolean;
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
  initial: boolean;
};

export const settingsAtom = atomWithStorage<Settings>("settings", {
  invertPitch: false,
  // Both default ON as of the Phase 1 lighting work (docs/LIGHTING_PLAN.md §5.3).
  // `toneMapping: false` selects Khronos PBR Neutral, which crushes everything
  // above linear ≈4 — wrong for a scene whose own reference white is ~20 and
  // whose sun disc is ~1e5. AgX is the correct default, and bloom is currently
  // the only cue that anything is brighter than white.
  bloom: true,
  toneMapping: true,
  // D14: the scene had NO anti-aliasing of any kind, which the user reported as
  // "planets look really pixelated at the edges until I get pretty close".
  antialias: true,
  // ⚠⚠ DEFAULT OFF — MEASURED +4.19 ms AND IT FIXED NOTHING WE HAD REPORTED.
  // Across all 12 sweep scenarios enabling SMAA moved `5 post` by +3.51 … +4.80 ms
  // (mean +4.19), consistently, i.e. ~24% of the earth_8 frame budget. It was added
  // for a REAL effect (MSAA's linear-HDR resolve makes its first coverage step 73% of
  // the output range on a high-contrast edge) — but the aliasing actually complained
  // about turned out to be atmosphere march banding (D14d), which the jitter fixed.
  // 🔑 Paying 4 ms for a defect nobody has reported is the wrong trade. The setting
  // stays so it can be re-judged against a specific artefact rather than a theory.
  antialiasPost: false,
  fps: false,
  perf: false,
  exposureStops: 0,
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
