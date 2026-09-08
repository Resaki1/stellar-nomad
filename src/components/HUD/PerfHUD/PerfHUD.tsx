"use client";

/**
 * Live per-pass GPU/CPU readout. Toggled by Settings → Dev → "perf profiler".
 *
 * Data comes from `space/perf/perfProfiler.ts`; see `docs/PERF_MEASUREMENT.md`
 * for how to read it and how to run a scripted benchmark instead.
 *
 * ── Why it looks like this ──────────────────────────────────────────────────
 * A perf overlay that costs perf is useless. Per `docs/UI_STYLE_GUIDE.md` §10
 * this follows the mutable-buffer pattern the other always-on HUD elements use:
 * React renders the skeleton ONCE, then a 4 Hz interval writes `textContent`.
 * No per-frame state, no per-frame React, no `backdrop-filter`. The body is a
 * single `<pre>` — one string write per tick — which is also the right shape for
 * a monospace diagnostic table.
 */

import { useEffect, useRef } from "react";

import { benchProgress } from "@/components/space/perf/benchRunner";
import {
  PASS_ORDER,
  isPerfEnabled,
  perf,
  type PerfSnapshot,
} from "@/components/space/perf/perfProfiler";

import "./PerfHUD.scss";

/** How often the DOM is refreshed. Human-readable, not frame-rate. */
const REFRESH_MS = 250;

/** Frame-time budgets, ms. 120 fps and 60 fps. */
const BUDGET_GOOD_MS = 1000 / 120;
const BUDGET_WARN_MS = 1000 / 60;

const ms = (v: number) => v.toFixed(2).padStart(6);

/**
 * Bimodality: mean / p50. ⚠⚠ 1.0 IS NORMAL AND ANYTHING OVER ~1.1 MEANS THE MEDIAN IS
 * LYING. MEASURED across 14 runs on 2026-09-07: every clean run sat at 1.00–1.01 and
 * every GPU-oversubscribed one at 1.18–1.82, with no overlap.
 *
 * 🔑 The mechanism, because it decides which statistic to trust: `deltaTime` is the
 * interval between renderer SUBMISSIONS, not presents. When the GPU falls behind, the
 * CPU keeps submitting at display cadence until the swapchain runs dry, so the samples
 * split into a fast mode at the vsync interval and a slow mode 4–6× longer. The MEDIAN
 * then describes the submission cadence and nothing else — it reported **138 fps on a
 * 120 Hz display**, which is impossible for presented frames — while total wall time is
 * conserved, so the MEAN stays honest.
 */
const BIMODAL_RATIO = 1.1;

function headline(snap: PerfSnapshot): string {
  const p50 = snap.frameMs.p50;
  // ⚠ FROM THE MEAN, NOT p50. p50 is robust to a few outlier spikes, which is why it
  // was chosen — but it is NOT robust to a bimodal split, and GPU backpressure produces
  // exactly that. Under backpressure p50 reports the fast mode as if it were the frame
  // rate, overstating it by up to 2×.
  const mean = snap.frameMs.mean;
  const fps = mean > 0 ? 1000 / mean : 0;
  const bimodal = p50 > 0 && mean / p50 > BIMODAL_RATIO;
  return (
    `${fps.toFixed(1).padStart(5)} fps   ` +
    `frame ${ms(mean)} mean /${ms(p50)} p50 /${ms(snap.frameMs.p95)} p95` +
    (bimodal
      ? `  ⚠ BIMODAL ${(mean / p50).toFixed(2)}× — GPU behind, p50 is submission cadence`
      : "") +
    "\n" +
    `gpu ${ms(snap.gpuTotalMs.mean)}   ` +
    `cpu ${ms(snap.cpuTotalMs.mean)} (submit ${ms(snap.cpuRenderMs.mean)})` +
    // Only shown when it happens — see PerfProfiler.droppedFrames.
    (snap.droppedFrames > 0
      ? `\n${snap.frames} frames, ${snap.droppedFrames} dropped`
      : "")
  );
}

function gateLine(snap: PerfSnapshot): string {
  const g = snap.gates;
  const flags = [
    g.cloudsVisible ? "clouds" : null,
    g.froxelBaked ? "froxel" : null,
    g.bsmBaked ? "bsm" : null,
    g.skyViewBaked ? "skyview" : null,
    g.lightVolume ? "lightvol" : null,
  ].filter(Boolean);
  return (
    `${g.body ?? "no body"}  alt ${Math.round(g.altitudeKm)}km  ` +
    `blend ${g.volumetricBlend.toFixed(2)}  draws ${snap.counters.drawCalls}\n` +
    (flags.length > 0 ? flags.join(" ") : "no gates open")
  );
}

function passTable(snap: PerfSnapshot): string {
  if (!snap.gpuSupported) {
    return "GPU timing unavailable on this adapter —\nCPU numbers above are still valid.";
  }
  if (!snap.gpuAvailable) return "waiting for the first GPU timings…";
  const width = PASS_ORDER.reduce((w, l) => Math.max(w, l.length), 0);
  const lines: string[] = [`${"pass".padEnd(width)}   mean    p95`];
  for (const { label, gpu } of snap.passes) {
    // Hide passes whose gate is shut — a column of zeros is noise. The
    // benchmark report keeps them so a sweep's matrix stays aligned.
    if (gpu.mean < 0.005 && gpu.p95 < 0.005) continue;
    lines.push(`${label.padEnd(width)} ${ms(gpu.mean)} ${ms(gpu.p95)}`);
  }
  return lines.join("\n");
}

export default function PerfHUD() {
  const headRef = useRef<HTMLPreElement>(null);
  const gateRef = useRef<HTMLPreElement>(null);
  const tableRef = useRef<HTMLPreElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The setting is on, but the renderer was built without timestamp queries
    // (they can only be requested at construction — see isPerfEnabled).
    if (!isPerfEnabled()) {
      if (headRef.current) {
        headRef.current.textContent =
          "perf profiler ON but the renderer\nwas built without it — RELOAD\nthe page (or use ?perf=1).";
      }
      return;
    }

    const tick = () => {
      const snap = perf.snapshot();
      if (headRef.current) headRef.current.textContent = headline(snap);
      if (gateRef.current) gateRef.current.textContent = gateLine(snap);
      if (tableRef.current) tableRef.current.textContent = passTable(snap);
      if (hintRef.current) {
        // A sweep runs for ~2 minutes; without this there is no sign it is alive.
        hintRef.current.textContent = benchProgress.running
          ? `SWEEP ${benchProgress.index}/${benchProgress.total} ` +
            `${benchProgress.scenario} (${benchProgress.phase})`
          : "__bench.sweep()";
      }
      if (rootRef.current) {
        // ⚠ Mean, matching the headline: under backpressure p50 would paint this
        // "good" while the GPU is 4× over budget.
        const f = snap.frameMs.mean || snap.frameMs.p50;
        rootRef.current.dataset.budget =
          f <= BUDGET_GOOD_MS ? "good" : f <= BUDGET_WARN_MS ? "warn" : "bad";
      }
    };

    tick();
    const id = window.setInterval(tick, REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="perf-hud" ref={rootRef} data-budget="good">
      <pre className="perf-hud__head" ref={headRef} />
      <pre className="perf-hud__gates" ref={gateRef} />
      <pre className="perf-hud__table" ref={tableRef} />
      <div className="perf-hud__hint" ref={hintRef}>
        __bench.sweep()
      </div>
    </div>
  );
}
