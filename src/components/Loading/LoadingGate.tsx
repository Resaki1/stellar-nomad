"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useProgress } from "@react-three/drei";
import { useStore } from "jotai";
import { useRef } from "react";
import { createReadiness, type Readiness, type ResidentMemory } from "./readiness";
import { net } from "./netActivity";
import {
  assetsLoaded,
  enterPlaying,
  gateRunning,
  getAppPhase,
  getLoadProgress,
  publishProgress,
  recordAfterGate,
} from "@/components/AppShell/appState";
import { compileScenePipelines } from "@/components/space/SpaceRenderer";
import { resetExposureAdaptation } from "@/components/space/exposureMeter";
import { resetPlayerInput } from "@/input/playerInput";
import { resetMouseSteering } from "@/input/mouse";

const QUIET_MS = 750;
const TIMEOUT_MS = 90_000;
/** Consecutive frames under the budget before the gate opens. */
const WARM_RUN = 60;
/** Two 60 Hz vsyncs; slower machines get 2× their own median instead. */
const MIN_BUDGET_MS = 34;
const RECORD_MS = 10_000;
const PUBLISH_MS = 100;
const HITCH_MS = 50;
/** drei's LoadingManager counts; outside the shared readiness bits. */
const PENDING_LOADER = 1 << 8;

const WINDOW = 60;
const _recent = new Float64Array(WINDOW);
const _sorted = new Float64Array(WINDOW);
const _record = new Float32Array(4096);

function median(n: number): number {
  _sorted.set(_recent);
  const v = _sorted.subarray(0, n).sort();
  return v[n >> 1];
}

function compileEnabled(): boolean {
  return new URLSearchParams(window.location.search).get("nocompile") !== "1";
}

/**
 * Drives the loading overlay from inside the Canvas: assets (loader counts + the readiness
 * checks `__test.settled()` uses) → compileAsync → a run of frames under budget. Then
 * records frame times for the first 10 s of play.
 */
export default function LoadingGate(): null {
  const store = useStore();
  const gl = useThree((s) => s.gl) as unknown as { info: { memory: ResidentMemory } };
  const st = useRef<{
    readiness: Readiness | null;
    frame: number;
    lastNow: number;
    startedAt: number;
    publishedAt: number;
    recent: number;
    run: number;
    compile: "idle" | "running" | "done";
    compileMs: number | null;
    recStart: number;
    recN: number;
    recDone: boolean;
  }>({
    readiness: null, frame: 0, lastNow: 0, startedAt: 0, publishedAt: 0, recent: 0, run: 0,
    compile: "idle", compileMs: null, recStart: 0, recN: 0, recDone: false,
  });

  useFrame(() => {
    const s = st.current;
    const now = performance.now();
    const dt = s.lastNow > 0 ? now - s.lastNow : 0;
    s.lastNow = now;
    s.frame++;
    const phase = getAppPhase();

    if (phase === "playing") {
      if (s.recDone) return;
      if (s.recStart === 0) {
        s.recStart = now;
        return;
      }
      if (s.recN < _record.length) _record[s.recN++] = dt;
      if (now - s.recStart >= RECORD_MS) {
        s.recDone = true;
        const v = Array.from(_record.subarray(0, s.recN)).sort((a, b) => a - b);
        recordAfterGate({
          frames: v.length,
          maxMs: Math.round(v[v.length - 1] * 10) / 10,
          over50: v.filter((x) => x > HITCH_MS).length,
          p50: Math.round(v[v.length >> 1] * 10) / 10,
          p99: Math.round(v[Math.floor(v.length * 0.99)] * 10) / 10,
        });
      }
      return;
    }
    if (phase !== "loading" || getLoadProgress().error) return;
    if (s.startedAt === 0) {
      s.startedAt = now;
      gateRunning();
    }
    s.readiness ??= createReadiness(s.frame, false);

    let mask = s.readiness.check(store, s.frame, QUIET_MS, gl.info.memory);
    const lp = useProgress.getState();
    if (lp.active || lp.loaded < lp.total) mask |= PENDING_LOADER;

    if (dt > 0) {
      _recent[s.recent % WINDOW] = dt;
      s.recent++;
    }
    const n = Math.min(s.recent, WINDOW);
    const budget = n > 0 ? Math.max(MIN_BUDGET_MS, 2 * median(n)) : MIN_BUDGET_MS;
    const stage = getLoadProgress().stage;

    if (stage === "assets" && mask === 0) {
      assetsLoaded();
      if (compileEnabled()) {
        s.compile = "running";
        compileScenePipelines()
          .then((ms) => (s.compileMs = ms))
          .catch((e: unknown) => console.warn("[load] compileAsync failed", e))
          .finally(() => (s.compile = "done"));
      } else {
        s.compile = "done";
      }
    } else if (stage === "warmup") {
      s.run = s.compile === "done" && mask === 0 && dt < budget ? s.run + 1 : 0;
    }

    const timedOut = now - s.startedAt > TIMEOUT_MS;
    if (s.run >= WARM_RUN || timedOut) {
      if (timedOut) {
        console.warn(`[load] gate timed out after ${TIMEOUT_MS / 1000} s; still pending:`, s.readiness.describe(mask));
      }
      resetExposureAdaptation();
      resetPlayerInput();
      resetMouseSteering();
      enterPlaying({ timedOut, compileMs: s.compileMs });
      return;
    }

    if (now - s.publishedAt >= PUBLISH_MS) {
      s.publishedAt = now;
      const pending = s.readiness.describe(mask);
      if (mask & PENDING_LOADER) pending.push("loader");
      publishProgress({
        assets: { loaded: lp.loaded, total: lp.total, inFlight: net.inFlight, pending },
        warmup: { run: s.run, need: WARM_RUN, thresholdMs: Math.round(budget), compiling: s.compile === "running" },
      });
    }
  });

  return null;
}
