/**
 * Scripted performance benchmark runner — the thing you actually run.
 *
 * See `docs/PERF_MEASUREMENT.md`. Exposed on `window.__bench` by `DevTools.tsx`.
 *
 *   await __bench.run("earth_650")   // one scenario → stats object
 *   await __bench.sweep()            // every scenario, printed as a table
 *   __bench.lastJson                 // copy-pasteable JSON of the last run
 *   __bench.warp("earth_8")          // just fly there and stay
 *
 * ── What makes a run trustworthy ────────────────────────────────────────────
 * 1. A fixed pose (`scenarios.ts`) — same position, same heading, zero throttle.
 * 2. Benchmark mode on, so nothing wall-clock-driven or save-mutating runs
 *    (`benchModeAtom`).
 * 3. A settle phase that is discarded, long enough to cover:
 *      • the 252-frame cloud temporal cycle (BAYER 4 × STBN_FRAME_MODULUS 63 —
 *        the marcher's sub-pixel slot and noise slice both have to come back
 *        round, or two runs sample a different subset of the jitter),
 *      • the ~17-frame light-volume crossfade and ~10-frame reconstruction EMA,
 *      • any texture/pipeline compile hitch the warp triggered.
 *    The settle phase ends early only when the frame times are actually stable
 *    (no recent frame more than 3× the median), and the result records whether
 *    that happened — an unsettled run is flagged, not silently reported.
 * 4. A measure window that is a multiple of 252 frames for the same reason.
 *
 * Everything is driven from `requestAnimationFrame`, which is the same clock
 * R3F's `frameloop="always"` renders on, so one tick = one rendered frame.
 */

import type { createStore } from "jotai";

import { benchModeAtom, devTeleportAtom } from "@/store/dev";
import { commsQueueAtom } from "@/store/comms";
import { hasPendingCloudBakes } from "@/components/celestial/bodies/cloudVolumeCompute";
import { isStbnLoaded } from "@/components/celestial/bodies/stbnTexture";
import {
  PASS_ORDER,
  perf,
  type PerfSnapshot,
  type SeriesStats,
} from "./perfProfiler";
import {
  SCENARIOS,
  findScenario,
  resolveScenario,
  type Scenario,
} from "./scenarios";

type Store = ReturnType<typeof createStore>;

/**
 * The cloud pipeline's temporal cycle length: BAYER.length (4) ×
 * STBN_FRAME_MODULUS (63). Mirrored from `SpaceRenderer.tsx`'s
 * `cloudFrameIndex` wrap — if either constant changes there, change it here.
 */
const CLOUD_TEMPORAL_CYCLE = 252;

export type BenchOptions = {
  /** Frames to discard after warping. Default one temporal cycle + slack. */
  settleFrames?: number;
  /** Hard cap on settling if frame times never stabilise. */
  maxSettleFrames?: number;
  /** Frames to measure. Default one temporal cycle. Kept ≤ 512 (ring size). */
  measureFrames?: number;
};

const DEFAULTS: Required<BenchOptions> = {
  settleFrames: CLOUD_TEMPORAL_CYCLE + 48,
  maxSettleFrames: 900,
  measureFrames: CLOUD_TEMPORAL_CYCLE,
};

export type ScenarioResult = {
  scenario: string;
  what: string;
  /** Frames actually measured. */
  frames: number;
  /**
   * Frames discarded for a corrupt GPU timestamp. A handful is normal; a large
   * fraction of `frames` means the numbers rest on a thin sample.
   */
  droppedFrames: number;
  /** Frames spent settling before measurement began. */
  settleFrames: number;
  /** False = frame times never stabilised; treat the numbers with suspicion. */
  settled: boolean;
  /** Derived from the MEDIAN frame time, not the mean — spikes don't hide here. */
  fps: number;
  frameMs: SeriesStats;
  cpuTotalMs: SeriesStats;
  cpuRenderMs: SeriesStats;
  gpuTotalMs: SeriesStats;
  /**
   * Per-pass GPU ms. `meanMs` is over EVERY measured frame, so a pass that only
   * ran once (a one-shot bake) reads as an amortised fraction — `maxMs` is its
   * real cost.
   */
  passes: Array<{ label: string; meanMs: number; p95Ms: number; maxMs: number }>;
  counters: PerfSnapshot["counters"];
  gates: PerfSnapshot["gates"];
};

export type BenchReport = {
  label: string;
  /** Client-side ISO timestamp of the run. */
  when: string;
  env: {
    userAgent: string;
    canvasPx: string;
    devicePixelRatio: number;
    gpuTimings: boolean;
    /**
     * Smallest non-zero GPU delta observed, ms. 0.1 means Chrome's timestamp
     * quantisation is active and every GPU number is rounded to 0.1 ms — enable
     * chrome://flags/#enable-webgpu-developer-features for finer resolution.
     */
    gpuResolutionMs: number;
    unlabeledPasses: string[];
    /**
     * Where the ship was when the sweep STARTED, and how many resources were
     * resident then.
     *
     * This matters more than it looks. `CelestialBody`'s LOD latch only ever
     * loads tiers — it never unloads them — so flying past Saturn before a sweep
     * leaves its textures resident for the whole run and measurably changes
     * `1 scaled scene` at Earth, with identical draw calls. Two runs are only
     * comparable when this block matches; the only clean reset is a page reload.
     * MEASURED: a sweep started near Saturn read 8–23% higher on `1 scaled scene`
     * than the same build started near Earth.
     */
    startedFrom: {
      body: string | null;
      altitudeKm: number;
      distanceKm: number;
      textures: number;
      geometries: number;
    };
  };
  results: ScenarioResult[];
};

/**
 * Live sweep progress, for UI that wants to show it (`PerfHUD`).
 *
 * A plain mutable object rather than an atom on purpose: a sweep runs for ~2
 * minutes at frame rate, and the consumer reads it from an interval. Routing it
 * through React state would re-render the HUD mid-measurement, which is exactly
 * what the measurement is trying to avoid.
 */
export const benchProgress = {
  running: false,
  /** 1-based index of the scenario being measured. */
  index: 0,
  total: 0,
  scenario: "",
  /** "settling" | "measuring" | "" */
  phase: "",
};

// ── Frame-driven helpers ────────────────────────────────────────────────────

/**
 * How long to wait for rendered frames before declaring the loop dead. Generous
 * enough to cover a shader-compile hitch, short enough not to look like a hang.
 */
const STALL_TIMEOUT_MS = 10_000;

/**
 * Advance `n` **rendered** frames.
 *
 * Counting `perf.renderedFrames` rather than `requestAnimationFrame` ticks is
 * deliberate. The two come apart in both directions, and both cases used to be
 * silent failures:
 *  • rAF ticks but nothing renders — `frameloop="never"` while the settings menu
 *    is open. Counting rAF would "measure" frames that never drew.
 *  • Nothing ticks at all — a backgrounded or hidden tab freezes rAF outright
 *    (verified: 0 callbacks). The sweep would hang forever with no output.
 *
 * The watchdog is a `setTimeout` because that still fires in a background tab
 * where rAF does not, so a stalled run reports instead of hanging.
 */
function advance(n: number): Promise<void> {
  const target = perf.renderedFrames + n;
  return new Promise<void>((resolve, reject) => {
    let lastSeen = perf.renderedFrames;
    let watchdog = 0;

    const arm = () => {
      clearTimeout(watchdog);
      watchdog = window.setTimeout(() => {
        reject(
          new Error(
            "[bench] no frames rendered for 10s — the render loop is paused. " +
              "Is the settings menu open, or the tab in the background? " +
              "The window must stay focused for the whole run.",
          ),
        );
      }, STALL_TIMEOUT_MS);
    };

    const step = () => {
      if (perf.renderedFrames >= target) {
        clearTimeout(watchdog);
        resolve();
        return;
      }
      if (perf.renderedFrames !== lastSeen) {
        lastSeen = perf.renderedFrames;
        arm(); // progress — restart the clock
      }
      requestAnimationFrame(step);
    };

    arm();
    requestAnimationFrame(step);
  });
}

/**
 * Wait until the one-shot startup work is done. These are the known synchronous
 * hitches — a compute-pipeline compile and the blue-noise fetch — that would
 * otherwise appear as a phantom spike in whichever scenario happened to run
 * first. Gives up after `timeoutFrames` and lets the caller proceed (the result
 * is still flagged unsettled if the frame times say so).
 */
async function waitForAssets(timeoutFrames: number): Promise<boolean> {
  for (let i = 0; i < timeoutFrames; i++) {
    if (!hasPendingCloudBakes() && isStbnLoaded()) return true;
    // advance(), not nextFrame(), so a paused render loop surfaces as the
    // watchdog error instead of hanging here forever.
    await advance(1);
  }
  return false;
}

/**
 * Discard frames until the frame time is stable, or `max` frames have passed.
 *
 * "Stable" = we have at least a full temporal cycle of samples and no frame in
 * the recent window exceeded 3× the median. That catches load hitches (texture
 * upload, shader compile) which are exactly what a warp provokes.
 */
async function settle(
  minFrames: number,
  max: number,
): Promise<{ frames: number; settled: boolean }> {
  let frames = 0;
  await advance(minFrames);
  frames += minFrames;

  while (frames < max) {
    const stats = perf.frameMs.stats();
    // p99 within 3× of the median means no outlier spike remains in history.
    if (stats.n >= CLOUD_TEMPORAL_CYCLE && stats.max <= stats.p50 * 3) {
      return { frames, settled: true };
    }
    // Clear history and give it another cycle — a single early hitch would
    // otherwise keep `max` elevated forever.
    perf.reset();
    await advance(CLOUD_TEMPORAL_CYCLE);
    frames += CLOUD_TEMPORAL_CYCLE;
  }
  return { frames, settled: false };
}

// ── Runner ──────────────────────────────────────────────────────────────────

function toResult(
  scenario: Scenario,
  snap: PerfSnapshot,
  settleFrames: number,
  settled: boolean,
): ScenarioResult {
  return {
    scenario: scenario.id,
    what: scenario.what,
    frames: snap.frameMs.n,
    droppedFrames: snap.droppedFrames,
    settleFrames,
    settled,
    fps: snap.frameMs.p50 > 0 ? 1000 / snap.frameMs.p50 : 0,
    frameMs: snap.frameMs,
    cpuTotalMs: snap.cpuTotalMs,
    cpuRenderMs: snap.cpuRenderMs,
    gpuTotalMs: snap.gpuTotalMs,
    passes: snap.passes.map((p) => ({
      label: p.label,
      meanMs: p.gpu.mean,
      p95Ms: p.gpu.p95,
      maxMs: p.gpu.max,
    })),
    counters: snap.counters,
    gates: snap.gates,
  };
}

export class BenchRunner {
  /** The most recent report. Also mirrored as `lastJson` for copy-paste. */
  last: BenchReport | null = null;
  lastJson = "";

  private running = false;

  constructor(private readonly store: Store) {}

  /** Every scenario id, for reference. */
  list(): Array<{ id: string; what: string }> {
    return SCENARIOS.map((s) => ({ id: s.id, what: s.what }));
  }

  /** Warp to a scenario and stay there (no measurement). Useful for eyeballing. */
  warp(id: string): void {
    const scenario = findScenario(id);
    if (!scenario) {
      console.error(`[bench] unknown scenario "${id}". Try __bench.list()`);
      return;
    }
    this.store.set(devTeleportAtom, resolveScenario(scenario));
    console.log(`[bench] warped to ${scenario.id} — ${scenario.what}`);
  }

  /** Where the ship was when this session opened. See BenchReport.env.startedFrom. */
  private startedFrom: BenchReport["env"]["startedFrom"] | null = null;

  /** Enter benchmark mode and clear anything already on screen. */
  private beginSession(): void {
    // Snapshot BEFORE the first warp, while the gates still describe where the
    // player actually was.
    const snap = perf.snapshot();
    this.startedFrom = {
      body: snap.gates.body,
      altitudeKm: snap.gates.altitudeKm,
      distanceKm: snap.gates.distanceKm,
      textures: snap.counters.textures,
      geometries: snap.counters.geometries,
    };
    this.store.set(benchModeAtom, true);
    // Drop any comms already queued; benchModeAtom stops new ones arriving.
    this.store.set(commsQueueAtom, []);
  }

  private endSession(): void {
    this.store.set(benchModeAtom, false);
  }

  /** Measure one scenario. Assumes a session is already open. */
  private async measure(
    scenario: Scenario,
    opts: Required<BenchOptions>,
  ): Promise<ScenarioResult> {
    this.store.set(devTeleportAtom, resolveScenario(scenario));
    // One frame for Spaceship's useFrame to consume the warp, then let the
    // world catch up (LOD tiers, texture prefetch, atmosphere LUT rebake).
    await advance(2);
    await waitForAssets(600);

    benchProgress.phase = "settling";
    perf.reset();
    const { frames, settled } = await settle(opts.settleFrames, opts.maxSettleFrames);

    benchProgress.phase = "measuring";
    perf.reset();
    await advance(opts.measureFrames);
    const snap = perf.snapshot();

    if (!settled) {
      console.warn(
        `[bench] ${scenario.id}: frame times never stabilised — numbers are noisy.`,
      );
    }
    return toResult(scenario, snap, frames, settled);
  }

  private buildEnv(): BenchReport["env"] {
    const canvas = document.querySelector("canvas");
    const unlabeled: string[] = [];
    perf.unlabeled.forEach((v) => unlabeled.push(v));
    return {
      userAgent: navigator.userAgent,
      canvasPx: canvas ? `${canvas.width}x${canvas.height}` : "unknown",
      devicePixelRatio: window.devicePixelRatio,
      gpuTimings: perf.gpuTimingAvailable,
      gpuResolutionMs: perf.snapshot().gpuResolutionMs,
      unlabeledPasses: unlabeled,
      startedFrom:
        this.startedFrom ?? {
          body: null,
          altitudeKm: 0,
          distanceKm: 0,
          textures: 0,
          geometries: 0,
        },
    };
  }

  private finish(label: string, results: ScenarioResult[]): BenchReport {
    const report: BenchReport = {
      label,
      when: new Date().toISOString(),
      env: this.buildEnv(),
      results,
    };
    this.last = report;
    this.lastJson = JSON.stringify(report, null, 4);
    printReport(report);
    // Best-effort: put the full JSON on the clipboard so it can be pasted
    // straight into a chat or a doc. Needs a permission the page may not have
    // (and no user gesture is in flight by the time a sweep ends), so failure is
    // expected and silent — `__bench.lastJson` is always there as the fallback.
    void navigator.clipboard
      ?.writeText(this.lastJson)
      .then(() => console.log("[bench] full JSON copied to clipboard."))
      .catch(() => {});
    return report;
  }

  /** Measure a single scenario. */
  async run(id: string, options: BenchOptions = {}): Promise<BenchReport | null> {
    const scenario = findScenario(id);
    if (!scenario) {
      console.error(`[bench] unknown scenario "${id}". Try __bench.list()`);
      return null;
    }
    if (!this.guard()) return null;
    const opts = { ...DEFAULTS, ...options };
    this.running = true;
    this.beginSession();
    try {
      const result = await this.measure(scenario, opts);
      return this.finish(id, [result]);
    } finally {
      this.endSession();
      this.running = false;
    }
  }

  /** Measure every scenario in order. */
  async sweep(label = "sweep", options: BenchOptions = {}): Promise<BenchReport | null> {
    if (!this.guard()) return null;
    const opts = { ...DEFAULTS, ...options };
    this.running = true;
    this.beginSession();
    const results: ScenarioResult[] = [];
    benchProgress.running = true;
    benchProgress.total = SCENARIOS.length;
    try {
      for (let i = 0; i < SCENARIOS.length; i++) {
        const s = SCENARIOS[i];
        benchProgress.index = i + 1;
        benchProgress.scenario = s.id;
        console.log(`[bench] (${i + 1}/${SCENARIOS.length}) ${s.id} — ${s.what}`);
        results.push(await this.measure(s, opts));
      }
      return this.finish(label, results);
    } finally {
      benchProgress.running = false;
      benchProgress.phase = "";
      this.endSession();
      this.running = false;
    }
  }

  /** Print the current live stats without warping anywhere. */
  report(): PerfSnapshot {
    const snap = perf.snapshot();
    printSnapshot(snap);
    return snap;
  }

  /**
   * Throw away accumulated samples. Use after anything that invalidates history
   * — a manual `warp()`, a window resize, a settings change — so `report()`
   * reflects only what has happened since.
   */
  reset(): void {
    perf.reset();
  }

  private guard(): boolean {
    if (this.running) {
      console.error("[bench] a run is already in progress.");
      return false;
    }
    if (!perf.enabled) {
      console.error(
        "[bench] profiling is off. Enable Settings → Dev → 'perf profiler' and RELOAD " +
          "(GPU timestamp queries can only be requested when the renderer is created), " +
          "or load the page with ?perf=1",
      );
      return false;
    }
    return true;
  }
}

// ── Shared instance ─────────────────────────────────────────────────────────

let _runner: BenchRunner | null = null;

/**
 * The one shared runner. Both `DevTools` (which publishes it as `window.__bench`)
 * and the Settings → Dev "run perf sweep" button use this, so the
 * already-in-progress guard works no matter which one starts a run.
 */
export function getBenchRunner(store: Store): BenchRunner {
  if (!_runner) _runner = new BenchRunner(store);
  return _runner;
}

// ── Console output ──────────────────────────────────────────────────────────

const f2 = (v: number) => Number(v.toFixed(2));

/**
 * Warn when the per-pass GPU sum exceeds the real frame period.
 *
 * A timestamp pair measures the wall-clock span of one pass on the GPU timeline,
 * and those spans can overlap — both across passes and across frames in flight —
 * so the sum is not additive with the frame period. MEASURED on an M2 Pro at the
 * cloud deck: 70.4 ms of pass time inside a 19.2 ms frame (3.7×), while the same
 * build 6,000 km higher summed 5.3 ms inside an 8.3 ms frame (0.64×, consistent).
 * So the inflation appears exactly when the GPU is saturated.
 *
 * The per-pass numbers remain trustworthy as *relative* signal — a resolution
 * change moves precisely the resolution-bound passes and leaves the fixed-size
 * ones (shadow map, froxel, sky-view LUT) alone, which is a strong specificity
 * check — but when this warning fires they must not be read as a ms budget.
 */
function inflationFactor(snap: PerfSnapshot): number {
  const frame = snap.frameMs.p50;
  if (frame <= 0 || snap.gpuTotalMs.mean <= 0) return 1;
  return snap.gpuTotalMs.mean / frame;
}

function warnIfInflated(snap: PerfSnapshot): void {
  const k = inflationFactor(snap);
  if (k > 1.15) {
    console.warn(
      `[bench] per-pass GPU sums to ${f2(snap.gpuTotalMs.mean)}ms inside a ` +
        `${f2(snap.frameMs.p50)}ms frame (${f2(k)}×) — NOT additive. Compare passes to ` +
        `EACH OTHER and across runs;\n        do not read the sum as a ms budget. The ` +
        `frame and CPU numbers are unaffected.\n` +
        `        🔑 CAUSE: GPUs PIPELINE ACROSS FRAMES, so pass spans from consecutive ` +
        `frames overlap and their\n        durations sum past the frame interval. ⚠ This ` +
        `does NOT require the GPU to be saturated —\n        MEASURED 1.71× at ` +
        `deep_space while hitting 120 fps with zero dropped frames. An earlier version\n` +
        `        of this message said "when the GPU is saturated", which is why a 1.5× ` +
        `inflation at 120 fps\n        looked like a bug; it is not.\n` +
        `        ⚠ Secondary suspect, worth one look: an UNEXCLUDED CONTAINER context ` +
        `(one that encloses\n        others) would be summed alongside its own children. ` +
        `Check env.unlabeledPasses for a new\n        container three has added, and add ` +
        `it to CONTAINER_NAMES in perfProfiler.ts. ⚠ Do not expect\n        much: three's ` +
        `"Render Pipeline" container measured ~0 ms of its own, so excluding it moved the\n` +
        `        post bucket by 0.1 ms. Structurally right, causally irrelevant.`,
    );
  }
}

function printSnapshot(snap: PerfSnapshot): void {
  console.log(
    `frame p50 ${f2(snap.frameMs.p50)}ms (${f2(1000 / (snap.frameMs.p50 || 1))} fps) · ` +
      `gpu ${f2(snap.gpuTotalMs.mean)}ms · cpu ${f2(snap.cpuTotalMs.mean)}ms · ` +
      `alt ${Math.round(snap.gates.altitudeKm)}km`,
  );
  warnIfInflated(snap);
  console.table(
    snap.passes.map((p) => ({
      pass: p.label,
      "gpu mean ms": f2(p.gpu.mean),
      "gpu p95 ms": f2(p.gpu.p95),
    })),
  );
}

/**
 * Print the report as two tables: one row per scenario (the headline numbers),
 * then a pass × scenario matrix of GPU ms, which is where the altitude gates
 * become visible as columns switching on.
 */
function printReport(report: BenchReport): void {
  console.log(
    `[bench] ${report.label} — ${report.env.canvasPx} @ dpr ${report.env.devicePixelRatio}, ` +
      `gpu timings ${report.env.gpuTimings ? "on" : "OFF"}` +
      (report.env.gpuResolutionMs >= 0.1
        ? ` (quantised to ${report.env.gpuResolutionMs}ms — see chrome://flags/#enable-webgpu-developer-features)`
        : ""),
  );

  // Comparability header. This is the check that would have caught the
  // 2026-08-11 09:51 run being started near Saturn.
  const from = report.env.startedFrom;
  console.log(
    `[bench] started from ${from.body ?? "deep space"} at ` +
      `${Math.round(from.altitudeKm)} km alt, with ${from.textures} textures / ` +
      `${from.geometries} geometries resident. Runs are ONLY comparable when this ` +
      `line matches — LOD tiers never unload, so reload the page for a clean baseline.`,
  );

  console.table(
    report.results.map((r) => ({
      scenario: r.scenario,
      "alt km": Math.round(r.gates.altitudeKm),
      fps: f2(r.fps),
      "frame p50": f2(r.frameMs.p50),
      "frame p95": f2(r.frameMs.p95),
      "gpu ms": f2(r.gpuTotalMs.mean),
      // Σ per-pass ÷ frame. ≈1 means the pass breakdown accounts for the frame
      // and is trustworthy; >1 means some passes' spans overlap and that row's
      // per-pass numbers cannot be read additively. This ratio is the single most
      // useful column for deciding whether to believe a breakdown.
      "gpu/frame": r.frameMs.p50 > 0 ? f2(r.gpuTotalMs.mean / r.frameMs.p50) : 0,
      "cpu ms": f2(r.cpuTotalMs.mean),
      "draws": r.counters.drawCalls,
      // Resident-resource count: if this drifts across a sweep, later scenarios
      // are not comparable with earlier ones.
      "tex": r.counters.textures,
      clouds: r.gates.cloudsVisible ? "Y" : "-",
      froxel: r.gates.froxelBaked ? "Y" : "-",
      bsm: r.gates.bsmBaked ? "Y" : "-",
      settled: r.settled ? "Y" : "NO",
      dropped: r.droppedFrames,
    })),
  );

  // Pass × scenario matrix of mean GPU ms.
  const matrix: Array<Record<string, number | string>> = [];
  for (const label of PASS_ORDER) {
    const row: Record<string, number | string> = { pass: label };
    let any = false;
    for (const r of report.results) {
      const p = r.passes.find((x) => x.label === label);
      const v = p ? f2(p.meanMs) : 0;
      if (v > 0) any = true;
      row[r.scenario] = v;
    }
    if (any) matrix.push(row);
  }
  if (matrix.length > 0) {
    console.log("[bench] per-pass GPU ms (mean):");
    console.table(matrix);
  }

  for (const r of report.results) {
    // Re-derive per scenario: saturation, and therefore overlap, is per scenario.
    const gpuSum = r.passes.reduce((a, p) => a + p.meanMs, 0);
    if (r.frameMs.p50 > 0 && gpuSum / r.frameMs.p50 > 1.15) {
      console.warn(
        `[bench] ${r.scenario}: GPU pass sum ${f2(gpuSum)}ms > frame ${f2(r.frameMs.p50)}ms ` +
          `(${f2(gpuSum / r.frameMs.p50)}×) — pass spans overlap; relative comparison only.`,
      );
    }
  }

  console.log(
    "[bench] copy `__bench.lastJson` to share the full result " +
      `(${report.results.length} scenario${report.results.length === 1 ? "" : "s"}).`,
  );
}
