/**
 * Per-pass GPU + CPU frame profiler.
 *
 * See `docs/PERF_MEASUREMENT.md` for the methodology and how to read the output.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The only perf signal we had was drei's aggregate FPS counter, which cannot
 * tell you *which* of the ~14 render passes and ~5 compute dispatches in
 * `SpaceRenderer`'s frame got slower. This module turns three.js's built-in
 * WebGPU timestamp queries into per-pass GPU milliseconds.
 *
 * ── How it works ────────────────────────────────────────────────────────────
 * three r183 already writes a GPU timestamp pair around every render pass and
 * compute dispatch when the renderer is built with `trackTimestamp: true`, and
 * reports them through the `Renderer.inspector` hook (`InspectorBase`). The
 * shipped `RendererInspector` (three/addons) does all the bookkeeping: it
 * allocates a query pair per render context, resolves them asynchronously a
 * frame or two later, and hands back a frame object whose `renders[]` and
 * `computes[]` entries carry `{ name, cpu, gpu }`. We subclass it purely to
 * siphon those numbers into fixed-size ring buffers.
 *
 * Passes are identified by `scene.name` / `computeNode.name` — which is why
 * every scene and compute node gets an explicit name (see `PASS` below and its
 * use in `SpaceRenderer.tsx`). Anything unnamed that shows up in `renders[]` is
 * bucketed as post-processing (the `RenderPipeline` bloom chain and the output
 * blit render internal `QuadMesh`es we don't own); anything unnamed in
 * `computes[]` is the asteroid-batch culling dispatch (its compute node is an
 * array, so it has no single name).
 *
 * ── Constraints this code respects ──────────────────────────────────────────
 * • The query pool holds 2048 queries and we submit ~19 contexts per frame, so
 *   the queries MUST be resolved every frame. `RendererInspector.addFrame`
 *   already schedules that and de-duplicates in-flight resolves.
 * • No User Timing API (`performance.measure`) in the hot path — at frame rate
 *   it accumulates entries and has OOM'd React dev mode here before. Plain
 *   `performance.now()` into preallocated Float64Arrays only.
 * • Nothing here allocates per frame. `snapshot()` does allocate, but it is
 *   called at ~4 Hz by the HUD or once per benchmark scenario.
 */

import { RendererInspector } from "three/addons/inspector/RendererInspector.js";

// ── Pass labels ─────────────────────────────────────────────────────────────
// The single source of truth for pass names. `SpaceRenderer` (and the pass
// modules) assign these to `scene.name` / `computeNode.name`; the profiler
// buckets timings by them. Numeric prefixes match the "Pass N" comments in
// SpaceRenderer.tsx and give a stable display order.

export const PASS = {
  atmoLUT: "1a atmo LUT bake",
  scaled: "1 scaled scene",
  bsm: "1b beer shadow map",
  froxel: "1c AP froxel",
  skyView: "1d sky-view LUT",
  atmosphere: "1.5 atmosphere",
  noiseBake: "2p noise bake",
  lightVolume: "2p light volume",
  marcher: "2a cloud marcher",
  reconstruct: "2c reconstruction",
  composite: "3 cloud composite",
  local: "4 local scene",
  post: "5 post (bloom+out)",
  miscCompute: "misc compute",
} as const;

export type PassLabel = (typeof PASS)[keyof typeof PASS];

/** Display order for the HUD and the benchmark report. */
export const PASS_ORDER: readonly PassLabel[] = [
  PASS.atmoLUT,
  PASS.scaled,
  PASS.bsm,
  PASS.froxel,
  PASS.skyView,
  PASS.atmosphere,
  PASS.noiseBake,
  PASS.lightVolume,
  PASS.marcher,
  PASS.reconstruct,
  PASS.composite,
  PASS.local,
  PASS.post,
  PASS.miscCompute,
];

// ── Ring-buffer series ──────────────────────────────────────────────────────

/** How many frames of history each series keeps. 512 ≈ 4–8 s at 60–120 fps. */
const HISTORY = 512;

/** Shared sort scratch for percentile computation (snapshot-time only). */
const sortScratch = new Float64Array(HISTORY);

export type SeriesStats = {
  /** Number of samples the stats were computed from. */
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
};

/**
 * Fixed-capacity ring buffer of frame samples. `push` is allocation-free;
 * `stats` sorts into a shared scratch buffer.
 */
class Series {
  private readonly buf = new Float64Array(HISTORY);
  private count = 0;
  private head = 0;

  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % HISTORY;
    if (this.count < HISTORY) this.count++;
  }

  reset(): void {
    this.count = 0;
    this.head = 0;
  }

  get length(): number {
    return this.count;
  }

  stats(): SeriesStats {
    const n = this.count;
    if (n === 0) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    // Copy the live samples into the scratch buffer in arbitrary order (order
    // does not matter — we sort next).
    let sum = 0;
    const start = (this.head - n + HISTORY) % HISTORY;
    for (let i = 0; i < n; i++) {
      const v = this.buf[(start + i) % HISTORY];
      sortScratch[i] = v;
      sum += v;
    }
    const view = sortScratch.subarray(0, n);
    view.sort();
    const at = (q: number) =>
      view[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
    return {
      n,
      mean: sum / n,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: view[n - 1],
    };
  }
}

// ── Gate state ──────────────────────────────────────────────────────────────

/**
 * Which cost gates are open, sampled once per frame by `SpaceRenderer`. This is
 * what makes a timing table self-explaining: the pass set changes with altitude
 * (froxel below 4000 km, BSM below 2000 km, volumetric clouds below 700 km), so
 * a number without its gate state is not interpretable.
 */
export type GateState = {
  /** Altitude above the dominant atmosphere body's ground radius, km. */
  altitudeKm: number;
  /** Distance to that body's centre, km. */
  distanceKm: number;
  /** Which body the atmosphere pass picked (`null` = none in range). */
  body: string | null;
  /** `uVolumetricBlend` — 0 means the whole cloud pipeline is skipped. */
  volumetricBlend: number;
  /** Ground cloud-shadow strength (0 = BSM not baked / faded out). */
  bsmStrength: number;
  cloudsVisible: boolean;
  froxelBaked: boolean;
  skyViewBaked: boolean;
  bsmBaked: boolean;
  lightVolume: boolean;
};

const emptyGates = (): GateState => ({
  altitudeKm: 0,
  distanceKm: 0,
  body: null,
  volumetricBlend: 0,
  bsmStrength: 0,
  cloudsVisible: false,
  froxelBaked: false,
  skyViewBaked: false,
  bsmBaked: false,
  lightVolume: false,
});

// ── Snapshot shape ──────────────────────────────────────────────────────────

export type PerfSnapshot = {
  /** Frames recorded since the last `reset()`. */
  frames: number;
  /** Frames discarded for a corrupt GPU timestamp. See `droppedFrames`. */
  droppedFrames: number;
  /** Wall-clock frame period, ms. `1000 / frameMs.p50` is the honest FPS. */
  frameMs: SeriesStats;
  /** Total JS time per frame across every `useFrame` (all priorities). */
  cpuTotalMs: SeriesStats;
  /** JS time inside SpaceRenderer's pass submission only. */
  cpuRenderMs: SeriesStats;
  /** Sum of all per-pass GPU times for the frame. */
  gpuTotalMs: SeriesStats;
  /** Per-pass GPU ms, in `PASS_ORDER`, omitting passes that never ran. */
  passes: Array<{ label: string; gpu: SeriesStats }>;
  /**
   * Last frame's renderer counters (valid now that info.reset() runs).
   *
   * `textures`/`geometries` are NOT per-frame — they are live resident-resource
   * counts from `renderer.info.memory`, recorded because they are the cheapest
   * signal for the contamination described in `docs/PERF_MEASUREMENT.md`: the
   * `CelestialBody` LOD latch only ever loads, never unloads, so wherever you
   * flew before a sweep leaves its textures resident and quietly changes
   * `1 scaled scene`. Two runs are only comparable when these match.
   */
  counters: {
    drawCalls: number;
    triangles: number;
    renderCalls: number;
    computeCalls: number;
    textures: number;
    geometries: number;
  };
  gates: GateState;
  /** True once at least one GPU timing sample has landed. */
  gpuAvailable: boolean;
  /** Whether the adapter supports timestamp queries at all. */
  gpuSupported: boolean;
  /**
   * Smallest non-zero GPU delta seen. Chrome quantises timestamp-query results
   * to 100 µs unless WebGPU developer features are enabled — if this reads
   * 0.1 then every number below is rounded to 0.1 ms.
   */
  gpuResolutionMs: number;
};

// ── Profiler ────────────────────────────────────────────────────────────────

class PerfProfiler {
  /** Set once at renderer construction; false = every hook here is a no-op. */
  enabled = false;
  /**
   * Whether the adapter granted the `timestamp-query` feature. Set after
   * `renderer.init()` resolves. Distinct from `gpuTimingAvailable`, which only
   * becomes true once a timing has actually landed — the HUD needs both to tell
   * "this GPU can't do it" apart from "no frames measured yet".
   */
  gpuTimingSupported = false;
  /** True when at least one non-zero GPU timing has been recorded. */
  gpuTimingAvailable = false;

  frames = 0;

  /**
   * Monotonic count of frames actually RENDERED since page load. Incremented at
   * the end of every real frame, so it is the only trustworthy clock for the
   * benchmark runner: `requestAnimationFrame` keeps ticking (or stops) for
   * reasons unrelated to whether the scene drew — `frameloop="never"` while the
   * settings menu is open being the obvious one. Never reset.
   */
  renderedFrames = 0;

  readonly frameMs = new Series();
  readonly cpuTotalMs = new Series();
  readonly cpuRenderMs = new Series();
  readonly gpuTotalMs = new Series();

  private readonly passes = new Map<string, Series>();

  counters = {
    drawCalls: 0,
    triangles: 0,
    renderCalls: 0,
    computeCalls: 0,
    textures: 0,
    geometries: 0,
  };
  gates: GateState = emptyGates();

  /** Names seen in `renders[]`/`computes[]` that we did not label. Diagnostic. */
  readonly unlabeled = new Set<string>();

  /**
   * Frames thrown away because a pass reported an impossible GPU duration.
   *
   * three's timestamp pool reuses one query set and resets its write cursor on
   * every resolve, so a slot occasionally gets read before it has been written
   * for the current frame — `end - start` then comes back negative (observed:
   * −3.3e6 ms) or non-finite. One bad slot invalidates that frame's whole
   * breakdown, so the frame is dropped rather than clamped, and counted here so
   * a high drop rate is visible instead of silently skewing the numbers.
   */
  droppedFrames = 0;

  private gpuMinDelta = Infinity;
  private frameStartMs = 0;
  private renderStartMs = 0;

  /** Get-or-create the series for a pass label. */
  private series(label: string): Series {
    let s = this.passes.get(label);
    if (s === undefined) {
      s = new Series();
      this.passes.set(label, s);
    }
    return s;
  }

  /** Drop all history. Called between benchmark scenarios. */
  reset(): void {
    this.frames = 0;
    this.droppedFrames = 0;
    this.frameMs.reset();
    this.cpuTotalMs.reset();
    this.cpuRenderMs.reset();
    this.gpuTotalMs.reset();
    this.passes.forEach((s) => s.reset());
  }

  // ── CPU hooks ─────────────────────────────────────────────────────────────
  // Called from PerfProbe at useFrame priority -1000 / +1000 so they bracket
  // every other useFrame in the app, giving total JS frame time. (SpaceRenderer
  // runs at priority 1, so its own submission cost is a subset — see
  // markRenderStart/End.)

  markFrameStart(): void {
    if (!this.enabled) return;
    this.frameStartMs = performance.now();
  }

  markFrameEnd(): void {
    if (!this.enabled || this.frameStartMs === 0) return;
    this.cpuTotalMs.push(performance.now() - this.frameStartMs);
    this.renderedFrames++;
  }

  markRenderStart(): void {
    if (!this.enabled) return;
    this.renderStartMs = performance.now();
  }

  markRenderEnd(): void {
    if (!this.enabled || this.renderStartMs === 0) return;
    this.cpuRenderMs.push(performance.now() - this.renderStartMs);
  }

  /** Called once per frame by SpaceRenderer with the live gate state. */
  setGates(g: GateState): void {
    if (!this.enabled) return;
    this.gates = g;
  }

  setCounters(c: PerfSnapshot["counters"]): void {
    if (!this.enabled) return;
    this.counters.drawCalls = c.drawCalls;
    this.counters.triangles = c.triangles;
    this.counters.renderCalls = c.renderCalls;
    this.counters.computeCalls = c.computeCalls;
    this.counters.textures = c.textures;
    this.counters.geometries = c.geometries;
  }

  /**
   * Called from `PerfInspector.resolveFrame` once a frame's GPU timestamps have
   * come back. `perPass` is a scratch map owned by the caller.
   */
  recordFrame(deltaTimeMs: number, perPass: Map<string, number>, gpuTotal: number): void {
    if (!this.enabled) return;
    this.frames++;
    // deltaTime is 0 on the very first frame (no previous finish time).
    if (deltaTimeMs > 0) this.frameMs.push(deltaTimeMs);
    if (gpuTotal > 0) {
      this.gpuTimingAvailable = true;
      this.gpuTotalMs.push(gpuTotal);
    }
    // Push a sample for every label we've ever seen, so a pass that stops
    // running (gate closed) decays toward 0 instead of holding a stale value.
    this.passes.forEach((s, label) => s.push(perPass.get(label) ?? 0));
    perPass.forEach((ms, label) => {
      if (!this.passes.has(label)) this.series(label).push(ms);
      if (ms > 0 && ms < this.gpuMinDelta) this.gpuMinDelta = ms;
    });
  }

  snapshot(): PerfSnapshot {
    const passes: PerfSnapshot["passes"] = [];
    const seen = new Set<string>();
    for (const label of PASS_ORDER) {
      const s = this.passes.get(label);
      seen.add(label);
      if (s && s.length > 0) passes.push({ label, gpu: s.stats() });
    }
    // Anything not in PASS_ORDER (shouldn't happen, but never hide work).
    this.passes.forEach((s, label) => {
      if (!seen.has(label) && s.length > 0) passes.push({ label, gpu: s.stats() });
    });
    return {
      frames: this.frames,
      droppedFrames: this.droppedFrames,
      frameMs: this.frameMs.stats(),
      cpuTotalMs: this.cpuTotalMs.stats(),
      cpuRenderMs: this.cpuRenderMs.stats(),
      gpuTotalMs: this.gpuTotalMs.stats(),
      passes,
      counters: { ...this.counters },
      gates: { ...this.gates },
      gpuAvailable: this.gpuTimingAvailable,
      gpuSupported: this.gpuTimingSupported,
      gpuResolutionMs: Number.isFinite(this.gpuMinDelta) ? this.gpuMinDelta : 0,
    };
  }
}

/** Process-wide profiler singleton. */
export const perf = new PerfProfiler();

// ── Inspector subclass ──────────────────────────────────────────────────────

/**
 * The shape of the frame object `RendererInspector` builds. Declared locally
 * because `@types/three`'s stub for `RendererInspector` is an empty class — the
 * runtime members are documented in
 * `three/examples/jsm/inspector/RendererInspector.js`.
 */
type InspectorStats = {
  name: string | undefined;
  gpu: number;
  cpu: number;
  gpuNotAvailable?: boolean;
};
type InspectorFrame = {
  frameId: number;
  deltaTime: number;
  renders: InspectorStats[];
  computes: InspectorStats[];
};

/** Reused across frames — `resolveFrame` is the only reader/writer. */
const perPassScratch = new Map<string, number>();

const KNOWN_LABELS: ReadonlySet<string> = new Set<string>(PASS_ORDER);

class PerfInspector extends RendererInspector {
  constructor() {
    super();
    // We drain each frame into ring buffers immediately, so we only need enough
    // retained frames to cover the timestamp resolve latency (1–3 frames).
    // `maxFrames` is a real RendererInspector field, but @types/three ships the
    // class as an empty stub — hence the narrow cast.
    (this as unknown as { maxFrames: number }).maxFrames = 64;
  }

  /**
   * Called by `RendererInspector.resolveTimestamp()` once both the render and
   * compute timestamps for `frame` have been read back from the GPU.
   */
  resolveFrame(frame: unknown): void {
    if (!perf.enabled) return;
    const f = frame as InspectorFrame;
    perPassScratch.clear();
    let total = 0;
    let corrupt = false;

    const add = (label: string, gpu: number) => {
      // A pass cannot take negative time, and nothing here takes a second. Both
      // mean the query slot was read before it was written — see
      // PerfProfiler.droppedFrames.
      if (!Number.isFinite(gpu) || gpu < 0 || gpu > 1000) {
        corrupt = true;
        return;
      }
      total += gpu;
      perPassScratch.set(label, (perPassScratch.get(label) ?? 0) + gpu);
    };

    for (const stats of f.renders) {
      const name = stats.name;
      if (name && KNOWN_LABELS.has(name)) {
        add(name, stats.gpu);
      } else {
        // Unnamed render contexts belong to RenderPipeline (bloom mip chain +
        // tonemap/output blit), which owns its own internal QuadMeshes.
        if (name) perf.unlabeled.add(`render:${name}`);
        add(PASS.post, stats.gpu);
      }
    }

    for (const stats of f.computes) {
      const name = stats.name;
      if (name && KNOWN_LABELS.has(name)) {
        add(name, stats.gpu);
      } else {
        // Unnamed compute = the asteroid tier batches, which dispatch an ARRAY
        // of nodes (`compute([resetNode, computeNode])`) and so carry no name.
        if (name) perf.unlabeled.add(`compute:${name}`);
        add(PASS.miscCompute, stats.gpu);
      }
    }

    if (corrupt) {
      perf.droppedFrames++;
      return;
    }
    perf.recordFrame(f.deltaTime, perPassScratch, total);
  }
}

// ── Enablement ──────────────────────────────────────────────────────────────

let cachedPreference: boolean | null = null;

/**
 * Whether profiling should be on for this page load.
 *
 * `trackTimestamp` can only be requested when the renderer is CONSTRUCTED, so
 * this cannot be a live React value — it is read once, before the Canvas
 * mounts, from the same persisted `settings` blob the Jotai `settingsAtom` uses
 * (reading localStorage directly avoids the atomWithStorage hydration race —
 * the same trick SettingsMenu's first-run GPU detection uses). Toggling the
 * setting therefore needs a reload, which `PerfHUD` says out loud.
 *
 * `?perf=1` in the URL forces it on regardless — that is how a benchmark run
 * starts from a cold load.
 */
export function isPerfEnabled(): boolean {
  if (cachedPreference !== null) return cachedPreference;
  if (typeof window === "undefined") return false;
  let on = false;
  try {
    if (new URLSearchParams(window.location.search).get("perf") !== null) {
      on = true;
    } else {
      const raw = window.localStorage.getItem("settings");
      if (raw) on = JSON.parse(raw)?.perf === true;
    }
  } catch {
    // Malformed JSON / storage blocked — profiling simply stays off.
    on = false;
  }
  cachedPreference = on;
  return on;
}

/**
 * The renderer surface this module touches. Typed structurally and loosely
 * because `trackTimestamp` lives on the backend, which `@types/three` models as
 * an opaque `Backend`.
 */
type ProfilableRenderer = {
  inspector: unknown;
  backend?: unknown;
};

/**
 * Install the profiler on a freshly constructed renderer. Must be called before
 * the first frame. No-op unless `enabled`.
 */
export function installPerfInspector(renderer: ProfilableRenderer): void {
  if (!perf.enabled) return;
  renderer.inspector = new PerfInspector();
}

/**
 * Whether the backend granted GPU timestamp queries. `trackTimestamp` is
 * requested at construction but silently downgraded if the adapter lacks the
 * `timestamp-query` feature, so this is the only trustworthy signal.
 */
export function hasGpuTimestamps(renderer: ProfilableRenderer): boolean {
  return (renderer.backend as { trackTimestamp?: boolean } | undefined)
    ?.trackTimestamp === true;
}
