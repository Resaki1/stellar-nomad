/**
 * `window.__test` — the scripted-verification harness (dev only).
 *
 * Gives an agent (or `scripts/drive.mjs`) what a human tester has: put the camera
 * somewhere repeatable, wait until the picture is actually final, then measure the
 * picture and the sound instead of eyeballing them. See docs/AUTOMATED_TESTING.md.
 *
 *   __test.isolate()                         bench mode: no comms, no save writes, no shake
 *   __test.scene("earth_horizon_8")          any __bench scenario id …
 *   __test.scene({ body: "mars", altKm: 20, look: "horizon" })   … or an ad-hoc pose
 *   await __test.settled()                   bakes, textures, network, exposure, accumulators
 *   await __test.image.stats({ x0: 0, y0: 0, x1: 1, y1: 0.5 })
 *   await __test.image.save("mars_20")       PNG → .captures/ via the dev API route
 *   await __test.audio.record(2000)          loudness/peak + base64 webm
 *   __test.state()                           body, altitude, speed, exposure, ship frame
 *   __test.simRate(1e4)                      get/set sim rate (isolate() forces 0, restores on false)
 *   await __test.sampleOffsets("luna", 120)  per-frame absolute ship→body offset spread
 *   __test.transitTo("luna")                 target a body and engage the autopilot
 *   __test.flight.simulate({ segments })     scripted stepShip run, no rendering (M1 gates)
 *   await __test.physics.simulate({ segments, rocks })  same plus a private physics world (M2)
 *   __test.input.mouse(dx, dy)               inject a pointer-lock mouse delta (M1b gates)
 *
 * Built on the bench harness's poses (`resolveScenario`) and its readiness signals
 * (`hasPendingCloudBakes`, `isStbnLoaded`, `CLOUD_TEMPORAL_CYCLE`), not copies of them.
 */

import { getLocalPlayerShip } from "@/sim/entities";
import { pingCueOptions, playPingCue } from "@/store/pingSound";
import { Quaternion, Vector3 } from "three";
import type { createStore } from "jotai";

import { benchModeAtom, devTeleportAtom } from "@/store/dev";
import { commsQueueAtom } from "@/store/comms";
import { createReadiness } from "@/components/Loading/readiness";
import { app, getAppPhase } from "@/components/AppShell/appState";
import {
  exposureMeterStatus,
  resetExposureAdaptation,
} from "@/components/space/exposureMeter";
import { getDominantAtmosphereBody } from "@/components/space/atmospherePass";
import { CLOUD_TEMPORAL_CYCLE } from "@/components/space/perf/benchRunner";
import {
  BENCH_PHASE_DEG,
  findScenario,
  resolveScenario,
  type Scenario,
} from "@/components/space/perf/scenarios";
import { perf } from "@/components/space/perf/perfProfiler";
import { armCapture, getEngine, unlockAudio } from "@/audio/engine";
import { audioShipBuffer } from "@/audio/shipBuffer";
import { playAudio } from "@/audio";
import { tryGetAudioEvent } from "@/data/audioEvents";
import { testProbe } from "./testProbe";
import { simEpochMsAtom, simRateAtom } from "@/store/simTime";
import { allBodyDefs } from "@/sim/celestialConstants";
import { listFrames } from "@/sim/frames";
import { modulesAtom } from "@/store/modules";
import { aiNameAtom } from "@/store/aiName";
import { systemConfigAtom } from "@/store/system";
import { flush, getActiveSave, resetActiveWorld, saveInfo, snapshotActiveData, suspendSaveWrites } from "@/save/activeSave";
import { exportWorld, importWorld } from "@/save/saveDb";
import { getLocalPlayerId, setLastWorldId } from "@/save/playerId";
import type { WorldOperation } from "@/sim/world/commands";
import { newOpId, worldAuthority } from "@/sim/world/worldAuthority";
import { createGameplayHarness } from "./gameplayHarness";
import { createCoopHarness } from "./coopHarness";
import { getActiveAsteroidRuntime } from "@/sim/asteroids/runtimeContext";
import { bodyTransitTarget, isTransitBurning, targetedPOIAtom, transitDriveBuffer, transitDriveOwnedAtom } from "@/store/transit";
import { poiBuffer } from "@/store/poi";
import { simulateFlight, type FlightScript, type FlightSimResult } from "@/sim/ship/flightSim";
import { simulatePhysics, type PhysicsScript, type PhysicsSimResult } from "@/sim/physics/physicsSim";
import { getFlightTuning, resetFlightTuning, setFlightTuning, speedLimitKmps, type FlightTuning } from "@/sim/ship/flightTuning";
import { playerInput } from "@/input/playerInput";
import { addMouseDelta, mouseConfig, mouseState, resetMouseSteering } from "@/input/mouse";
import { isCursorNeeded, isPointerLocked, pointerLock, releaseGamePointerLock, requestGamePointerLock } from "@/input/pointerLock";
import type { MouseMode } from "@/store/mouseSettings";
import { cameraProbe } from "@/components/Camera/chaseCamera";
import { flightHud } from "@/components/HUD/FlightHud/flightHudBuffer";

type Store = ReturnType<typeof createStore>;

// ── Types ───────────────────────────────────────────────────────────────────

/** Ad-hoc pose. Same semantics as a bench `Scenario` (sun-relative approach axis). */
export type SceneSpec = {
  body: string;
  altKm: number;
  /** "body" looks at the centre (default), "up" away from it, "horizon" level sun-ward. */
  look?: "body" | "up" | "horizon";
  /** Phase angle at the body, degrees. 35 = bench default (91% lit), 180 = night side. */
  phaseDeg?: number;
};

/** Normalised screen rectangle, 0..1, origin top-left. */
export type Region = { x0: number; y0: number; x1: number; y1: number };

export type SettleOptions = {
  /** Frames to run before checking anything. Default: one cloud temporal cycle. */
  minFrames?: number;
  /** Give up after this many frames and report what was still pending. Default 3000. */
  maxFrames?: number;
  /** Network must be idle this long, ms. Default 750. */
  quietMs?: number;
  /** Snap eye adaptation to its target instead of waiting it out. Default true. */
  snapExposure?: boolean;
};

export type SettleResult = {
  settled: boolean;
  frames: number;
  ms: number;
  /** Conditions still unmet at the end (empty when settled). */
  pending: string[];
};

export type ImageStats = {
  width: number;
  height: number;
  region: Region;
  /** sRGB-encoded luma, 0..255 (Rec.709 weights on the 8-bit values). */
  luma: { mean: number; p01: number; p50: number; p99: number };
  /** Mean of each 8-bit channel. */
  rgbMean: [number, number, number];
  /** Fraction of pixels with any channel ≥ 254. */
  clippedFrac: number;
  /** Fraction of pixels with luma ≤ 1. */
  blackFrac: number;
  /**
   * Gradient banding, rows and columns combined. A "band edge" is a ±1 LSB step
   * between two flat runs each ≥ 4 px long. Dithered gradients step every pixel or
   * two, so they score near 0; quantised ones score high.
   */
  banding: { edgesPer1kPx: number; meanFlatRunPx: number };
  /** 32-bin luma histogram, counts. */
  histogram: number[];
  /** 16×9 luma thumbnail hash — equal hashes ⇒ nothing visible changed. */
  hash: string;
};

export type AudioRecording = {
  mime: string;
  ms: number;
  channels: number;
  peak: number;
  peakDb: number;
  rms: number;
  rmsDb: number;
  /** base64 of the encoded recording, for drive.mjs to write and run ffmpeg on. */
  base64?: string;
};

// ── Frame helpers ───────────────────────────────────────────────────────────

const STALL_MS = 10_000;
/** Adapted-vs-target EV gap counted as converged. ~1/14 stop: below visible. */
const EXPOSURE_TOL_EV = 0.07;

/** Resolve after `n` RENDERED frames; reject if none render for 10 s. */
function frames(n: number): Promise<void> {
  const target = testProbe.frames + n;
  return new Promise((resolve, reject) => {
    let last = testProbe.frames;
    let lastChange = performance.now();
    const step = () => {
      if (testProbe.frames >= target) return resolve();
      if (testProbe.frames !== last) {
        last = testProbe.frames;
        lastChange = performance.now();
      } else if (performance.now() - lastChange > STALL_MS) {
        return reject(
          new Error(
            "[test] no frames rendered for 10 s — render loop paused " +
              "(settings menu open, or the tab/pane is hidden).",
          ),
        );
      }
      // setTimeout, not rAF: rAF is throttled to ~2/s in a hidden pane, and we
      // want the stall to be REPORTED rather than look like a slow scene.
      setTimeout(step, 4);
    };
    step();
  });
}

// ── Image capture ───────────────────────────────────────────────────────────

function gameCanvas(): HTMLCanvasElement {
  const c = document.querySelector("canvas");
  if (!c) throw new Error("[test] no canvas");
  return c;
}

/** Read the presented frame (HUD excluded). Waits one frame so it is current. */
async function readCanvas(): Promise<ImageData> {
  await frames(1);
  const c = gameCanvas();
  // toBlob reads the last presented WebGPU frame; drawImage on a WebGPU canvas is
  // not guaranteed to. Verified non-black in both the pane and headless Chrome.
  const blob = await new Promise<Blob>((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error("[test] toBlob failed"))), "image/png"),
  );
  const bmp = await createImageBitmap(blob);
  const oc = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = oc.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("[test] no 2d context");
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, oc.width, oc.height);
}

const FULL: Region = { x0: 0, y0: 0, x1: 1, y1: 1 };

function computeStats(img: ImageData, region: Region): ImageStats {
  const { width: W, height: H, data } = img;
  const x0 = Math.max(0, Math.floor(region.x0 * W));
  const x1 = Math.min(W, Math.ceil(region.x1 * W));
  const y0 = Math.max(0, Math.floor(region.y0 * H));
  const y1 = Math.min(H, Math.ceil(region.y1 * H));
  const w = x1 - x0;
  const h = y1 - y0;
  const n = Math.max(1, w * h);

  const luma = new Uint8Array(w * h);
  const hist256 = new Uint32Array(256);
  let sr = 0,
    sg = 0,
    sb = 0,
    clipped = 0,
    black = 0,
    sl = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y + y0) * W + (x + x0)) * 4;
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      const l = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      luma[y * w + x] = l;
      hist256[l]++;
      sr += r;
      sg += g;
      sb += b;
      sl += l;
      if (r >= 254 || g >= 254 || b >= 254) clipped++;
      if (l <= 1) black++;
    }
  }

  const pct = (p: number) => {
    const target = p * n;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist256[v];
      if (acc >= target) return v;
    }
    return 255;
  };

  // Banding along rows and columns.
  const MIN_RUN = 4;
  let edges = 0,
    runSum = 0,
    runCount = 0;
  const scan = (len: number, at: (k: number) => number) => {
    let prevRun = 0;
    let run = 1;
    for (let k = 1; k <= len; k++) {
      const same = k < len && at(k) === at(k - 1);
      if (same) {
        run++;
        continue;
      }
      // run ended at k-1
      if (prevRun >= MIN_RUN && run >= MIN_RUN && k - run - 1 >= 0) {
        const d = Math.abs(at(k - run) - at(k - run - 1));
        if (d === 1) {
          edges++;
          runSum += run;
          runCount++;
        }
      }
      prevRun = run;
      run = 1;
    }
  };
  for (let y = 0; y < h; y++) scan(w, (k) => luma[y * w + k]);
  for (let x = 0; x < w; x++) scan(h, (k) => luma[k * w + x]);

  const histogram = new Array<number>(32).fill(0);
  for (let v = 0; v < 256; v++) histogram[v >> 3] += hist256[v];

  // 16×9 thumbnail hash (FNV-1a over 4-bit-quantised block means).
  let hash = 0x811c9dc5;
  for (let by = 0; by < 9; by++) {
    for (let bx = 0; bx < 16; bx++) {
      let s = 0,
        c = 0;
      const ys = Math.floor((by * h) / 9),
        ye = Math.floor(((by + 1) * h) / 9);
      const xs = Math.floor((bx * w) / 16),
        xe = Math.floor(((bx + 1) * w) / 16);
      for (let y = ys; y < ye; y += 2)
        for (let x = xs; x < xe; x += 2) {
          s += luma[y * w + x];
          c++;
        }
      hash ^= (c ? s / c : 0) >> 4;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }

  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    width: w,
    height: h,
    region,
    luma: { mean: r2(sl / n), p01: pct(0.01), p50: pct(0.5), p99: pct(0.99) },
    rgbMean: [r2(sr / n), r2(sg / n), r2(sb / n)],
    clippedFrac: Math.round((clipped / n) * 1e4) / 1e4,
    blackFrac: Math.round((black / n) * 1e4) / 1e4,
    banding: {
      edgesPer1kPx: r2((edges / (2 * n)) * 1000),
      meanFlatRunPx: r2(runCount ? runSum / runCount : 0),
    },
    histogram,
    hash: hash.toString(16).padStart(8, "0"),
  };
}

// ── Dev capture upload (pane workflow; drive.mjs writes files itself) ───────

async function upload(name: string, blob: Blob): Promise<string> {
  const res = await fetch(`/api/dev/capture?name=${encodeURIComponent(name)}`, {
    method: "POST",
    body: blob,
  });
  const out = (await res.json()) as { path?: string; error?: string };
  if (!res.ok || !out.path) throw new Error(`[test] upload failed: ${out.error ?? res.status}`);
  return out.path;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

// ── HUD visibility ──────────────────────────────────────────────────────────

const hidden: HTMLElement[] = [];

/** Hide every DOM sibling along the canvas's ancestor chain (HUD, drei <Html> labels). */
function setHud(visible: boolean): void {
  if (visible) {
    for (const el of hidden) el.style.opacity = "";
    hidden.length = 0;
    return;
  }
  if (hidden.length) return;
  let node: HTMLElement | null = gameCanvas();
  while (node && node.parentElement && node !== document.body) {
    for (const sib of Array.from(node.parentElement.children)) {
      // opacity, not visibility: a descendant can re-assert `visibility: visible`
      // (Next's dev badge does, from its shadow root); it can't undo a parent's opacity.
      if (sib !== node && sib instanceof HTMLElement && sib.style.opacity !== "0") {
        sib.style.opacity = "0";
        hidden.push(sib);
      }
    }
    node = node.parentElement;
  }
}

// ── Harness ─────────────────────────────────────────────────────────────────

export function createTestHarness(store: Store) {
  let rateBeforeIsolate: number | null = null;
  const trackStops = new Set<() => void>();

  const harness = {
    /** Rendered frames since load. */
    get frameCount(): number {
      return testProbe.frames;
    },

    /** Wait until the game is playable: the loading gate is open and frames render. */
    async ready(timeoutMs = 180_000): Promise<{ frames: number; ms: number }> {
      const t0 = performance.now();
      while (getAppPhase() !== "playing" || testProbe.frames < 3) {
        if (performance.now() - t0 > timeoutMs) throw new Error(`[test] game never became playable (phase ${getAppPhase()})`);
        await new Promise((r) => setTimeout(r, 100));
      }
      return { frames: testProbe.frames, ms: Math.round(performance.now() - t0) };
    },

    /** App shell (M0.4): phase(), start(worldId?), timings(), progress(). */
    app,

    /**
     * Bench mode on/off. On = no comms, no save writes at all, no camera shake,
     * frozen HUD readouts — what you want for any repeatable capture.
     */
    isolate(on = true): void {
      store.set(benchModeAtom, on);
      suspendSaveWrites(on, "isolate");
      if (on) {
        store.set(commsQueueAtom, []);
        if (rateBeforeIsolate === null) rateBeforeIsolate = store.get(simRateAtom);
        store.set(simRateAtom, 0);
      } else if (rateBeforeIsolate !== null) {
        store.set(simRateAtom, rateBeforeIsolate);
        rateBeforeIsolate = null;
      }
    },

    /** Name the ship AI if unnamed, so the naming prompt does not take keyboard focus. */
    nameAi(name = "Test"): void {
      if (store.get(aiNameAtom) === null) store.set(aiNameAtom, name);
    },

    /** Get, or set then get, the sim rate (sim seconds per real second). */
    simRate(rate?: number): number {
      if (rate !== undefined) {
        store.set(simRateAtom, rate);
        rateBeforeIsolate = null; // an explicit rate survives isolate(false)
      }
      return store.get(simRateAtom);
    },

    /** Body frames with their SOI radii, km. */
    frameList() {
      return listFrames().map((f) => ({ id: f.id, depth: f.depth, soiKm: Math.round(f.soiKm) }));
    },

    /**
     * Sample the ABSOLUTE ship→body offset on `n` consecutive frames, read after the
     * ship's update. A one-frame frame-origin lag shows as a spread ≈ the body's per-frame motion.
     */
    async sampleOffsets(bodyId: string, n = 120) {
      const body = allBodyDefs().find((b) => b.id === bodyId);
      if (!body) throw new Error(`[test] unknown body "${bodyId}"`);
      const off: number[][] = [];
      const bodyPos: number[][] = [];
      const frameIds = new Set<string>();
      await new Promise<void>((resolve, reject) => {
        const hook = () => {
          const p = testProbe.ship.posKm;
          const b = body.positionKm;
          off.push([p[0] - b[0], p[1] - b[1], p[2] - b[2]]);
          bodyPos.push([b[0], b[1], b[2]]);
          frameIds.add(testProbe.ship.frameId);
          if (off.length >= n) {
            testProbe.frameHooks.delete(hook);
            clearTimeout(timer);
            resolve();
          }
        };
        const timer = setTimeout(() => {
          testProbe.frameHooks.delete(hook);
          reject(new Error("[test] sampleOffsets: frames stalled"));
        }, STALL_MS + n * 100);
        testProbe.frameHooks.add(hook);
      });
      const spread = [0, 1, 2].map((k) => {
        const v = off.map((o) => o[k]);
        return Math.max(...v) - Math.min(...v);
      });
      const dist = off.map((o) => Math.hypot(o[0], o[1], o[2]));
      let bodyMove = 0;
      for (let i = 1; i < bodyPos.length; i++) {
        bodyMove += Math.hypot(
          bodyPos[i][0] - bodyPos[i - 1][0],
          bodyPos[i][1] - bodyPos[i - 1][1],
          bodyPos[i][2] - bodyPos[i - 1][2],
        );
      }
      return {
        n: off.length,
        frameIds: Array.from(frameIds),
        distKm: { min: Math.min(...dist), max: Math.max(...dist) },
        distSpreadKm: Math.max(...dist) - Math.min(...dist),
        maxComponentSpreadKm: Math.max(...spread),
        bodyMoveKmPerFrame: bodyPos.length > 1 ? bodyMove / (bodyPos.length - 1) : 0,
      };
    },

    /** Per-frame ship track (frame id, absolute km, cumulative fixed steps): `n` frames or until trackStop(). */
    async track(n: number): Promise<{ frameId: string; absKm: number[]; steps: number }[]> {
      const rows: { frameId: string; absKm: number[]; steps: number }[] = [];
      await new Promise<void>((resolve) => {
        const finish = () => {
          testProbe.frameHooks.delete(hook);
          trackStops.delete(finish);
          resolve();
        };
        const hook = () => {
          const t = testProbe.ship;
          rows.push({ frameId: t.frameId, absKm: [...t.posKm], steps: t.steps });
          if (rows.length >= n) finish();
        };
        trackStops.add(finish);
        testProbe.frameHooks.add(hook);
      });
      return rows;
    },

    /** End every running track() now. */
    trackStop(): void {
      for (const stop of Array.from(trackStops)) stop();
    },

    /**
     * Target a body (same POI shape as gaze targeting) and engage the autopilot: holds
     * the transit key through the spool. Grants the transit-drive module if missing.
     */
    async transitTo(bodyId: string, opts: { field?: boolean } = {}): Promise<{ engaged: boolean; arrivalOffsetKm: number; legCount: number; fieldArrival: boolean; refusal: string | null }> {
      const body = allBodyDefs().find((b) => b.id === bodyId);
      if (!body) throw new Error(`[test] unknown body "${bodyId}"`);
      if (!store.get(transitDriveOwnedAtom)) {
        const m = store.get(modulesAtom);
        store.set(modulesAtom, { ...m, ownedModules: [...m.ownedModules, "special_transit_drive"] });
      }
      const target = bodyTransitTarget(body, store.get(systemConfigAtom).asteroidFields, opts.field !== false);
      const arrivalOffsetKm = target.arrivalOffsetKm ?? 0;
      store.set(targetedPOIAtom, target);
      transitDriveBuffer.keyHeld = true;
      const refused0 = transitDriveBuffer.ev.refused;
      try {
        for (let i = 0; i < 2000 && !isTransitBurning(transitDriveBuffer.phase) && transitDriveBuffer.ev.refused === refused0; i++) await frames(1);
      } finally {
        transitDriveBuffer.keyHeld = false;
      }
      return { engaged: isTransitBurning(transitDriveBuffer.phase) && transitDriveBuffer.autopilot, arrivalOffsetKm, legCount: transitDriveBuffer.legCount, fieldArrival: transitDriveBuffer.fieldArrival, refusal: transitDriveBuffer.ev.refused !== refused0 ? transitDriveBuffer.ev.refusal : null };
    },

    /** Teleport to a bench scenario id or an ad-hoc `SceneSpec`. Ship stops dead. */
    scene(spec: string | SceneSpec): { id: string; positionKm: number[] } {
      let scenario: Scenario | undefined;
      if (typeof spec === "string") {
        scenario = findScenario(spec);
        if (!scenario) throw new Error(`[test] unknown scenario "${spec}" — see __bench.list()`);
      } else {
        scenario = {
          id: `test_${spec.body}_${spec.altKm}_${spec.look ?? "body"}`,
          what: "ad-hoc __test.scene",
          bodyId: spec.body,
          altitudeKm: spec.altKm,
          lookMode: spec.look ?? "body",
          phaseDeg: spec.phaseDeg ?? BENCH_PHASE_DEG,
        };
      }
      const warp = resolveScenario(scenario);
      store.set(devTeleportAtom, warp);
      return { id: scenario.id, positionKm: warp.positionKm.map((v) => Math.round(v)) };
    },

    /** Await `n` rendered frames. */
    frames,

    /**
     * Wait until the picture is final: warp consumed, cloud bakes + blue noise done,
     * network idle, resident texture/geometry counts stable, eye adaptation converged,
     * and at least one full cloud temporal cycle rendered.
     */
    async settled(opts: SettleOptions = {}): Promise<SettleResult> {
      const minFrames = opts.minFrames ?? CLOUD_TEMPORAL_CYCLE;
      const maxFrames = opts.maxFrames ?? 3000;
      const quietMs = opts.quietMs ?? 750;
      const snap = opts.snapExposure ?? true;
      const t0 = performance.now();
      const f0 = testProbe.frames;

      await frames(2);
      const readiness = createReadiness(testProbe.frames);
      // Frame at which loading finished (and exposure snapped). `minFrames` counts from
      // here: radiance buffers are pre-exposed (D25), so temporal history accumulated
      // before the snap is at the wrong exposure.
      let loadedAt: number | null = null;
      let pending: string[] = [];

      while (testProbe.frames - f0 < maxFrames) {
        pending = readiness.describe(
          readiness.check(store, testProbe.frames, quietMs, testProbe.renderer?.info.memory),
        );

        // Snap only once loading is done, or it snaps to a half-loaded scene's EV.
        if (pending.length > 0) {
          loadedAt = null; // loading (re)started, e.g. a late LOD swap: start over
        } else if (loadedAt === null) {
          if (snap) resetExposureAdaptation();
          loadedAt = testProbe.frames;
        }
        const ex = exposureMeterStatus();
        const dEV = ex.adaptedEV - ex.targetEV;
        if (snap && loadedAt !== null && Math.abs(dEV) > EXPOSURE_TOL_EV) {
          // The view moved after the snap (e.g. rotation still damping out after a key
          // release, MEASURED Δ0.37 EV): re-snap and restart the accumulator floor.
          resetExposureAdaptation();
          loadedAt = testProbe.frames;
        } else if (Math.abs(dEV) > EXPOSURE_TOL_EV) {
          pending.push(`exposure(Δ${dEV.toFixed(2)} EV)`);
        }
        const since = loadedAt === null ? 0 : testProbe.frames - loadedAt;
        if (since < minFrames) pending.push(`minFrames(${since}/${minFrames})`);

        if (pending.length === 0) {
          return { settled: true, frames: testProbe.frames - f0, ms: Math.round(performance.now() - t0), pending };
        }
        await frames(1);
      }
      return { settled: false, frames: testProbe.frames - f0, ms: Math.round(performance.now() - t0), pending };
    },

    /** Show/hide all DOM over the canvas (HUD, labels, overlays). */
    hud(visible: boolean): void {
      setHud(visible);
    },

    /** Synthetic held key on `window` (the flight model samples held keys per frame). */
    async hold(key: string, ms: number): Promise<void> {
      window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      await new Promise((r) => setTimeout(r, ms));
      window.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    },

    /** Where the ship is and what the eye model is doing, for assertions. */
    state() {
      const dom = getDominantAtmosphereBody();
      const ex = exposureMeterStatus();
      const gates = perf.enabled ? perf.snapshot().gates : null;
      return {
        frames: testProbe.frames,
        benchMode: store.get(benchModeAtom),
        atmosphereBody: dom ? dom.id : null,
        altitudeKm: dom ? Math.round((dom.distanceKm - dom.params.groundRadiusKm) * 1000) / 1000 : null,
        speedMps: Math.round(audioShipBuffer.speedMps * 10) / 10,
        throttle: Math.round(audioShipBuffer.throttle * 100) / 100,
        simRate: store.get(simRateAtom),
        simEpochMs: store.get(simEpochMsAtom),
        ship: {
          posKm: [...testProbe.ship.posKm],
          frameId: testProbe.ship.frameId,
          relPosKm: [...testProbe.ship.relPosKm],
          quat: [...testProbe.ship.quat],
          steps: testProbe.ship.steps,
          frameSwitches: testProbe.ship.frameSwitches,
          velKmps: [...testProbe.ship.velKmps],
          speedMps: Math.hypot(...testProbe.ship.velKmps) * 1000,
          angVelRadS: [...testProbe.ship.angVel],
          assist: testProbe.ship.assist,
          boostCharge: testProbe.ship.boostCharge,
          speedLimitMps: testProbe.ship.speedLimitKmps * 1000,
          throttleSetPoint: playerInput.throttle,
        },
        transit: { phase: transitDriveBuffer.phase, autopilot: transitDriveBuffer.autopilot },
        camera: harness.input.camera(),
        input: {
          mode: mouseConfig.mode,
          sensitivity: mouseConfig.sensitivity,
          deadzone: mouseConfig.deadzone,
          autoCentre: mouseConfig.autoCentre,
          invertPitch: playerInput.invertPitch,
          stick: [mouseState.stickX, mouseState.stickY],
          mouseCmd: [playerInput.mouseYaw, playerInput.mousePitch],
          aimCmd: [playerInput.aimYaw, playerInput.aimPitch],
          aim: mouseState.aimValid ? [mouseState.aim.x, mouseState.aim.y, mouseState.aim.z] : null,
          freeLook: mouseState.freeLook,
          pointerLocked: isPointerLocked(),
          cursorNeeded: isCursorNeeded(),
        },
        reticle: harness.input.reticle(),
        exposure: {
          meteredEV: Math.round(ex.meteredEV * 100) / 100,
          adaptedEV: Math.round(ex.adaptedEV * 100) / 100,
          targetEV: Math.round(ex.targetEV * 100) / 100,
        },
        resources: testProbe.renderer
          ? { ...testProbe.renderer.info.memory }
          : null,
        gates,
      };
    },

    /** M1 flight model: deterministic scripted runs through the real stepShip, and the live tuning table. */
    flight: {
      simulate: (script: FlightScript): FlightSimResult => simulateFlight(script),
      tuning(patch?: Partial<FlightTuning> | "reset"): FlightTuning {
        if (patch === "reset") resetFlightTuning();
        else if (patch) setFlightTuning(patch);
        return { ...getFlightTuning() };
      },
      speedLimitMps: (): number => speedLimitKmps(getFlightTuning()) * 1000,
      input: () => ({ ...playerInput, held: { ...playerInput.held } }),
    },

    /** Private near-field world + stepShip, no rendering (docs/PHYSICS_PLAN.md §7.4). */
    physics: {
      simulate: (script: PhysicsScript): Promise<PhysicsSimResult> => simulatePhysics(script),
    },

    /** M1b mouse steering and camera rig. Injected deltas go through the same path as a pointer-lock mousemove. */
    input: {
      mouse(dx: number, dy: number): void {
        addMouseDelta(dx, dy);
      },
      /** true/false overrides the free-look key; null hands it back to the key. */
      freeLook(on: boolean | null): void {
        mouseState.freeLookForced = on;
      },
      mode(m?: MouseMode): MouseMode {
        if (m && m !== mouseConfig.mode) {
          mouseConfig.mode = m;
          resetMouseSteering();
        }
        return mouseConfig.mode;
      },
      /** Patch the live mouse preferences (not persisted). */
      config(patch: Partial<typeof mouseConfig> = {}) {
        Object.assign(mouseConfig, patch);
        return { ...mouseConfig };
      },
      centre(): void {
        resetMouseSteering();
      },
      /** Test override of the invert-pitch setting (the settings atom re-applies on its next change). */
      invertPitch(on: boolean): void {
        playerInput.invertPitch = on;
      },
      camera() {
        const p = cameraProbe;
        return {
          lagDeg: p.lagDeg, lagVecDeg: [...p.lagVecDeg], orbitDeg: [...p.orbitDeg], offsetDeg: p.offsetDeg,
          fovDeg: p.fovDeg, snaps: p.snaps, quat: [...flightHud.cameraQuat], shipRenderQuat: [...flightHud.shipQuat],
        };
      },
      /** Reticle as computed this frame, plus where the DOM element actually is. */
      reticle() {
        const h = flightHud;
        const el = h.els.nose;
        const r = el?.getBoundingClientRect();
        return {
          x: h.reticle.x, y: h.reticle.y, visible: h.reticle.visible,
          dom: r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null,
          stick: { ...h.stick }, aim: { ...h.aim }, velocity: { ...h.velocity }, driftMps: h.driftMps,
          fovDeg: h.fovDeg, aspect: h.aspect, viewport: [...h.viewport],
          focusedPoi: poiBuffer.pois.find((p) => p.focused)?.id ?? null,
        };
      },
      /** Camera rig + ship rate on each of the next `n` frames. */
      async sampleCamera(n: number) {
        const rows: { t: number; lagVecDeg: number[]; lagDeg: number; offsetDeg: number; orbitDeg: number[]; angVel: number[] }[] = [];
        await new Promise<void>((resolve) => {
          const hook = () => {
            rows.push({
              t: performance.now(), lagVecDeg: [...cameraProbe.lagVecDeg], lagDeg: cameraProbe.lagDeg,
              offsetDeg: cameraProbe.offsetDeg, orbitDeg: [...cameraProbe.orbitDeg], angVel: [...testProbe.ship.angVel],
            });
            if (rows.length >= n) {
              testProbe.frameHooks.delete(hook);
              resolve();
            }
          };
          testProbe.frameHooks.add(hook);
        });
        return rows;
      },
      pointerLock: {
        request: () => requestGamePointerLock(),
        release: () => releaseGamePointerLock(),
        state: () => ({ ...pointerLock, locked: isPointerLocked(), cursorNeeded: isCursorNeeded() }),
      },
    },

    /** Active world save (M0.3). Writes respect isolate(): flush() is a no-op while isolated. */
    save: {
      info: () => saveInfo(),
      /** `force` as export/reset use it (refused in a co-op session). Resolves true when written. */
      flush: (force = false) => flush(force),
      /** Deep copy of the in-memory save data. */
      data: () => snapshotActiveData(),
      async export(): Promise<string> {
        const rec = getActiveSave();
        if (!rec) throw new Error("[test] no active world");
        await flush();
        return exportWorld(rec.meta.id);
      },
      /** Store `json` as a new world and make it the one the next load boots. Returns its id. */
      async importAndActivate(json: string): Promise<string> {
        const meta = await importWorld(json, getLocalPlayerId());
        setLastWorldId(meta.id);
        return meta.id;
      },
      /** Fresh data for the active world (same meta), written immediately. Reload afterwards. */
      reset: () => resetActiveWorld(),
    },

    /** M3 domain operations and save fixtures (gameplay-check.mjs). */

    gameplay: createGameplayHarness(store),
    coop: createCoopHarness(store),


    world: {
      /** Legacy gate shape: no opId needed, true when accepted. */
      submit: (cmd: Omit<WorldOperation, "opId">): boolean =>
        worldAuthority.submit({ ...cmd, opId: newOpId() } as WorldOperation, getLocalPlayerId()).status === "accepted",
      /** Loaded asteroid instances nearest the ship: id, field, chunk, distance (km). */
      asteroidsNearShip(n = 5) {
        const rt = getActiveAsteroidRuntime();
        const fields = store.get(systemConfigAtom).asteroidFields ?? [];
        const ship = testProbe.ship.posKm;
        const out: { instanceId: number; fieldId: string; chunkKey: string; distKm: number }[] = [];
        for (const f of fields) {
          const fr = rt?.getFieldRuntime(f.id);
          if (!fr) continue;
          fr.chunks.forEach((chunk, chunkKey) => {
            for (const modelId in chunk.instancesByModel) {
              const inst = chunk.instancesByModel[modelId];
              for (let i = 0; i < inst.count; i++) {
                const x = f.anchorKm[0] + chunk.originKm[0] + inst.positionsM[i * 3] / 1000 - ship[0];
                const y = f.anchorKm[1] + chunk.originKm[1] + inst.positionsM[i * 3 + 1] / 1000 - ship[1];
                const z = f.anchorKm[2] + chunk.originKm[2] + inst.positionsM[i * 3 + 2] / 1000 - ship[2];
                out.push({ instanceId: inst.instanceIds[i] >>> 0, fieldId: f.id, chunkKey, distKm: Math.hypot(x, y, z) });
              }
            }
          });
        }
        return out.sort((a, b) => a.distKm - b.distKm).slice(0, n);
      },
      /** Is `instanceId` present in loaded chunk `chunkKey`? (null when that chunk isn't loaded) */
      instanceLoaded(fieldId: string, chunkKey: string, instanceId: number): boolean | null {
        const chunk = getActiveAsteroidRuntime()?.getFieldRuntime(fieldId)?.getChunk(chunkKey);
        if (!chunk) return null;
        for (const modelId in chunk.instancesByModel) {
          const inst = chunk.instancesByModel[modelId];
          for (let i = 0; i < inst.count; i++) if (inst.instanceIds[i] >>> 0 === instanceId >>> 0) return true;
        }
        return false;
      },
    },

    image: {
      /** Metrics of the rendered frame (HUD excluded), optionally in a region. */
      async stats(region: Region = FULL): Promise<ImageStats> {
        return computeStats(await readCanvas(), region);
      },
      /** PNG of the rendered frame as base64 (no data: prefix). */
      async png(): Promise<string> {
        await frames(1);
        const c = gameCanvas();
        const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
        if (!blob) throw new Error("[test] toBlob failed");
        return blobToBase64(blob);
      },
      /** Save the rendered frame to `.captures/<name>.png` (dev API route). */
      async save(name: string): Promise<string> {
        await frames(1);
        const c = gameCanvas();
        const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
        if (!blob) throw new Error("[test] toBlob failed");
        return upload(`${name}.png`, blob);
      },
    },

    audio: {
      /** Resume the AudioContext without a gesture (works with autoplay allowed). */
      unlock(): boolean {
        unlockAudio();
        return getEngine()?.ctx.state === "running";
      },
      /**
       * Record the real master bus for `ms`. Returns levels; `keep` adds base64 of
       * the encoded file so drive.mjs can run ffmpeg (loudness, spectrogram) on it.
       * `playEvent` fires that event id once recording has started.
       */
      async record(ms = 2000, keep = true, playEvent?: string): Promise<AudioRecording> {
        const stream = armCapture();
        const e = getEngine();
        if (!stream || !e) throw new Error("[test] audio engine not running — call __test.audio.unlock()");
        const mime = ["audio/webm;codecs=opus", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
        if (!mime) throw new Error("[test] no MediaRecorder mime type");
        const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 256_000 });
        const chunks: Blob[] = [];
        rec.ondataavailable = (ev) => chunks.push(ev.data);
        const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
        rec.start();
        if (playEvent) {
          const def = tryGetAudioEvent(playEvent);
          if (!def) {
            rec.stop();
            throw new Error(`[test] unknown audio event "${playEvent}" — see __audio.events()`);
          }
          // Let the recorder spin up so the onset isn't clipped.
          await new Promise((r) => setTimeout(r, 50));
          playAudio(def.id);
        }
        await new Promise((r) => setTimeout(r, ms));
        rec.stop();
        await stopped;
        const blob = new Blob(chunks, { type: mime });
        const buf = await e.ctx.decodeAudioData(await blob.arrayBuffer());
        let peak = 0,
          sumSq = 0,
          count = 0;
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < d.length; i++) {
            const v = Math.abs(d[i]);
            if (v > peak) peak = v;
            sumSq += d[i] * d[i];
            count++;
          }
        }
        const rms = Math.sqrt(sumSq / Math.max(1, count));
        // Floor at −120 dB: Opus decodes digital silence to denormals (saw −673 dB).
        const db = (v: number) => Math.max(-120, Math.round(20 * Math.log10(Math.max(v, 1e-12)) * 10) / 10);
        return {
          mime,
          ms: Math.round(buf.duration * 1000),
          channels: buf.numberOfChannels,
          peak: Math.round(peak * 1e4) / 1e4,
          peakDb: db(peak),
          rms: Math.round(rms * 1e4) / 1e4,
          rmsDb: db(rms),
          base64: keep ? await blobToBase64(blob) : undefined,
        };
      },
      /**
       * Where a positioned one-shot is heard: plays `eventId` 20 m out along a CAMERA-relative
       * direction and records the master bus per channel. balance = (R−L)/(R+L) RMS: −1 hard left,
       * +1 hard right, ~0 ahead or behind (equal-power panning has no front/back cue).
       */
      async pan(dir: "ahead" | "behind" | "left" | "right" | "up", eventId = "hud.ping", ms = 700) {
        const stream = armCapture();
        const e = getEngine();
        const cam = testProbe.camera;
        if (!stream || !e || !cam) throw new Error("[test] audio engine or camera not ready — __test.audio.unlock()");
        const local = { ahead: [0, 0, -1], behind: [0, 0, 1], left: [-1, 0, 0], right: [1, 0, 0], up: [0, 1, 0] }[dir];
        cam.updateMatrixWorld();
        const q = cam.getWorldQuaternion(new Quaternion());
        const w = new Vector3(local[0], local[1], local[2]).applyQuaternion(q).multiplyScalar(20);
        const mime = ["audio/webm;codecs=opus", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m))!;
        const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 256_000 });
        const chunks: Blob[] = [];
        rec.ondataavailable = (ev) => chunks.push(ev.data);
        const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
        rec.start();
        await new Promise((r) => setTimeout(r, 60));
        if (eventId === "ping-cue") {
          // The real crew-ping path: a frame-relative place 5 km out along that view direction.
          const ship = getLocalPlayerShip();
          if (!ship) throw new Error("[test] no ship");
          const u = w.clone().setLength(5);
          playPingCue(ship.frameId, [ship.posKm.x + u.x, ship.posKm.y + u.y, ship.posKm.z + u.z]);
        } else {
          const opts = eventId === "hud.ping" ? pingCueOptions(w) : { positionM: { x: w.x, y: w.y, z: w.z } };
          playAudio(eventId, { ...opts, ignoreLimits: true });
        }
        await new Promise((r) => setTimeout(r, ms));
        rec.stop();
        await stopped;
        const buf = await e.ctx.decodeAudioData(await new Blob(chunks, { type: mime }).arrayBuffer());
        const rmsOf = (c: number): number => {
          const d = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
          let s = 0;
          for (let i = 0; i < d.length; i++) s += d[i] * d[i];
          return Math.sqrt(s / Math.max(1, d.length));
        };
        const l = rmsOf(0), r = rmsOf(1);
        // Brightness: RMS of the first difference over RMS (a crude high-frequency share), both channels.
        let diff = 0, all = 0;
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const d = buf.getChannelData(c);
          for (let i = 1; i < d.length; i++) { diff += (d[i] - d[i - 1]) ** 2; all += d[i] * d[i]; }
        }
        const db = (v: number) => Math.round(20 * Math.log10(Math.max(v, 1e-9)) * 10) / 10;
        return { dir, worldM: [w.x, w.y, w.z].map((x) => Math.round(x * 10) / 10), lDb: db(l), rDb: db(r),
          balance: Math.round(((r - l) / Math.max(1e-9, r + l)) * 100) / 100,
          brightness: Math.round(Math.sqrt(diff / Math.max(1e-18, all)) * 1000) / 1000 };
      },
      /** Record and save to `.captures/<name>.webm` (dev API route). */
      async save(name: string, ms = 2000, playEvent?: string): Promise<string> {
        const r = await harness.audio.record(ms, true, playEvent);
        const bytes = Uint8Array.from(atob(r.base64 ?? ""), (c) => c.charCodeAt(0));
        return upload(`${name}.webm`, new Blob([bytes], { type: r.mime }));
      },
    },
  };
  return harness;
}

export type TestHarness = ReturnType<typeof createTestHarness>;
