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
 *   __test.state()                           body, altitude, speed, exposure
 *
 * Built on the bench harness's poses (`resolveScenario`) and its readiness signals
 * (`hasPendingCloudBakes`, `isStbnLoaded`, `CLOUD_TEMPORAL_CYCLE`), not copies of them.
 */

import type { createStore } from "jotai";

import { benchModeAtom, devTeleportAtom } from "@/store/dev";
import { commsQueueAtom } from "@/store/comms";
import { hasPendingCloudBakes } from "@/components/celestial/bodies/cloudVolumeCompute";
import { isStbnLoaded } from "@/components/celestial/bodies/stbnTexture";
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

// ── Network-quiet tracking (installed once, dev only) ───────────────────────

const net = { inFlight: 0, lastActivityAt: 0, installed: false };

function installNetworkTracking(): void {
  if (net.installed) return;
  net.installed = true;
  // fetch covers KTX2/GLTF/audio (three's FileLoader uses fetch); the observer
  // also catches <img>-based loads, which never go through fetch.
  const orig = window.fetch.bind(window);
  window.fetch = (async (...args: Parameters<typeof fetch>) => {
    net.inFlight++;
    net.lastActivityAt = performance.now();
    try {
      return await orig(...args);
    } finally {
      net.inFlight--;
      net.lastActivityAt = performance.now();
    }
  }) as typeof fetch;
  try {
    new PerformanceObserver(() => {
      net.lastActivityAt = performance.now();
    }).observe({ type: "resource", buffered: false });
  } catch {
    /* observer unsupported — fetch tracking still works */
  }
}

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
  installNetworkTracking();

  const harness = {
    /** Rendered frames since load. */
    get frameCount(): number {
      return testProbe.frames;
    },

    /** Wait until the first frames render (page fully booted). */
    async ready(timeoutMs = 60_000): Promise<{ frames: number; ms: number }> {
      const t0 = performance.now();
      while (testProbe.frames < 3) {
        if (performance.now() - t0 > timeoutMs) throw new Error("[test] game never rendered");
        await new Promise((r) => setTimeout(r, 100));
      }
      return { frames: testProbe.frames, ms: Math.round(performance.now() - t0) };
    },

    /**
     * Bench mode on/off. On = no comms, no ship-position saves, no camera shake,
     * frozen HUD readouts — what you want for any repeatable capture.
     */
    isolate(on = true): void {
      store.set(benchModeAtom, on);
      if (on) store.set(commsQueueAtom, []);
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
      let lastRes = "";
      let resStableSince = testProbe.frames;
      // Frame at which loading finished (and exposure snapped). `minFrames` counts from
      // here: radiance buffers are pre-exposed (D25), so temporal history accumulated
      // before the snap is at the wrong exposure.
      let loadedAt: number | null = null;
      let pending: string[] = [];

      while (testProbe.frames - f0 < maxFrames) {
        pending = [];
        if (store.get(devTeleportAtom) !== null) pending.push("teleport");
        if (hasPendingCloudBakes()) pending.push("cloudBakes");
        if (!isStbnLoaded()) pending.push("blueNoise");
        if (net.inFlight > 0 || performance.now() - net.lastActivityAt < quietMs)
          pending.push(`network(${net.inFlight} in flight)`);
        const mem = testProbe.renderer?.info.memory;
        const res = mem ? `${mem.textures}/${mem.geometries}` : "";
        if (res !== lastRes) {
          lastRes = res;
          resStableSince = testProbe.frames;
        }
        if (testProbe.frames - resStableSince < 30) pending.push(`resources(${res})`);

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
