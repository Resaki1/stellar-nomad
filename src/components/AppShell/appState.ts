/**
 * App phase machine (M0.4): title → loading → playing. Module state rather than an atom
 * because the gate inside the Canvas and the shell outside it both drive it.
 * ⚠ Must stay light: the title bundle imports it (no three, no game modules).
 */
import { suspendSaveWrites } from "@/save/activeSave";
import { setSimPaused } from "@/sim/simPause";
import { releaseGamePointerLock } from "@/input/pointerLock";

export type AppPhase = "title" | "loading" | "playing";
export type LoadStage = "world" | "assets" | "warmup";

export type LoadProgress = {
  stage: LoadStage;
  worldName: string | null;
  assets: { loaded: number; total: number; inFlight: number; pending: string[] };
  warmup: { run: number; need: number; thresholdMs: number; compiling: boolean };
  error: string | null;
};

export type FrameStats = { frames: number; maxMs: number; over50: number; p50: number; p99: number };

export type LoadTimings = {
  /** Navigation start → title list rendered, ms. */
  titleInteractiveMs: number | null;
  gated: boolean;
  worldMs: number | null;
  assetsMs: number | null;
  warmupMs: number | null;
  compileMs: number | null;
  /** Start → gate open, ms. */
  totalMs: number | null;
  timedOut: boolean;
  /** First 10 s after the gate opened (or from first render with ?nogate). */
  afterGate: FrameStats | null;
};

const LOADING = "loading";

let phase: AppPhase = "title";
let progress: LoadProgress = {
  stage: "world",
  worldName: null,
  assets: { loaded: 0, total: 0, inFlight: 0, pending: [] },
  warmup: { run: 0, need: 0, thresholdMs: 0, compiling: false },
  error: null,
};
const timings: LoadTimings = {
  titleInteractiveMs: null,
  gated: true,
  worldMs: null,
  assetsMs: null,
  warmupMs: null,
  compileMs: null,
  totalMs: null,
  timedOut: false,
  afterGate: null,
};
let startAt = 0;
let stageAt = 0;
/** Shell-side bound for when LoadingGate never mounts (renderer init hangs); its own timeout covers the rest. */
const RENDERER_START_MS = 60_000;
let rendererTimer: ReturnType<typeof setTimeout> | null = null;
let startHandler: ((worldId?: string) => Promise<void>) | null = null;
const listeners = new Set<() => void>();

const emit = (): void => listeners.forEach((fn) => fn());

export function subscribeApp(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const getAppPhase = (): AppPhase => phase;
export const getLoadProgress = (): LoadProgress => progress;
export const getLoadTimings = (): LoadTimings => timings;

/** Dev only: `?nogate=1` mounts the game without the loading gate (A/B measurement). */
export function gateBypassed(): boolean {
  if (process.env.NODE_ENV !== "development" || typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("nogate") === "1";
}

export function markTitleInteractive(): void {
  timings.titleInteractiveMs ??= Math.round(performance.now());
}

export function setStartHandler(fn: ((worldId?: string) => Promise<void>) | null): void {
  startHandler = fn;
}

/** Freeze the sim and suspend saves: nothing may be stepped or written while half-loaded. */
export function beginLoading(): void {
  if (phase !== "title") return;
  setSimPaused(true, LOADING);
  suspendSaveWrites(true, LOADING);
  startAt = stageAt = performance.now();
  timings.gated = !gateBypassed();
  phase = "loading";
  emit();
}

const lap = (): number => {
  const now = performance.now();
  const ms = Math.round(now - stageAt);
  stageAt = now;
  return ms;
};

export function worldLoaded(name: string): void {
  timings.worldMs = lap();
  progress = { ...progress, stage: "assets", worldName: name };
  emit();
  if (!timings.gated) {
    enterPlaying();
    return;
  }
  rendererTimer = setTimeout(() => {
    console.warn(`[load] renderer did not start within ${RENDERER_START_MS / 1000} s`);
    loadFailed("The renderer did not start. WebGPU may be unavailable, or the GPU device was lost.");
  }, RENDERER_START_MS);
}

/** LoadingGate's first frame: the renderer is running. */
export function gateRunning(): void {
  if (rendererTimer !== null) clearTimeout(rendererTimer);
  rendererTimer = null;
}

export function assetsLoaded(): void {
  timings.assetsMs = lap();
  progress = { ...progress, stage: "warmup" };
  emit();
}

export function publishProgress(next: Partial<Omit<LoadProgress, "stage" | "worldName">>): void {
  progress = { ...progress, ...next };
  emit();
}

export function loadFailed(message: string): void {
  if (phase !== "loading" || progress.error) return;
  gateRunning();
  // The title gesture took the lock; the error screen needs the cursor.
  releaseGamePointerLock();
  progress = { ...progress, error: message };
  emit();
}

/** Open the gate: unfreeze the sim, resume saves. */
export function enterPlaying(opts: { timedOut?: boolean; compileMs?: number | null } = {}): void {
  if (phase !== "loading") return;
  if (timings.gated) timings.warmupMs = lap();
  timings.totalMs = Math.round(performance.now() - startAt);
  timings.timedOut = !!opts.timedOut;
  if (opts.compileMs !== undefined) timings.compileMs = opts.compileMs === null ? null : Math.round(opts.compileMs);
  setSimPaused(false, LOADING);
  suspendSaveWrites(false, LOADING);
  phase = "playing";
  emit();
}

export function recordAfterGate(stats: FrameStats): void {
  timings.afterGate = stats;
}

/** This page without the parameters that skip the title (keeps e.g. `?dpr`). */
export function titleUrl(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("autostart");
  url.searchParams.delete("world");
  return url.toString();
}

/** `__test.app` */
export const app = {
  phase: getAppPhase,
  progress: getLoadProgress,
  timings: (): LoadTimings => structuredClone(timings),
  /** Start a world from the title: the last played one, or `worldId`. */
  start(worldId?: string): Promise<void> {
    if (phase !== "title" || !startHandler) return Promise.reject(new Error(`[app] cannot start from phase ${phase}`));
    return startHandler(worldId);
  },
};
