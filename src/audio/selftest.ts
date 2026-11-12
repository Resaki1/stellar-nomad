// ---------------------------------------------------------------------------
// TIER-2 OFFLINE ASSERTIONS — docs/AUDIO_PLAN.md §10.2.
//
// Renders graphs deterministically in an `OfflineAudioContext` and asserts on
// the resulting PCM. No listening required, and no wall-clock waiting:
// OfflineAudioContext was MEASURED at ~255x faster than real time, so the whole
// suite runs in well under a second.
//
// 🔑 WHY THIS RUNS IN THE BROWSER RATHER THAN IN NODE. The plan's §10.2 assumed
// a Node test runner, but Node has no Web Audio, and the only option
// (`node-web-audio-api`) is both a new dependency — which CLAUDE.md says to call
// out rather than add quietly — and a *different engine*: it targets WPT spec
// compliance, not bit-parity with Chromium's PannerNode/Biquad internals (L7).
// Running here tests the engine the game actually ships on, which is strictly
// more trustworthy, at the cost of needing a browser to run it.
//
// ⚠ ASSERT ON STATISTICS, NEVER ON HASHES. f32 DSP output differs across browser
// versions, CPU FMA and denormal handling. `sha256(pcm)` would fail on an
// unrelated Chrome upgrade; peak/RMS/band-energy will not.
// ---------------------------------------------------------------------------

import { dbToGain, sliderToGain, softClipCurve } from "./engine";
import { gainForDistance } from "./spatial";
import { acousticsForBody, propagationFor } from "./acoustics";
import { ALL_AUDIO_EVENTS } from "@/data/audioEvents";
import { engineLayerGain } from "./engineLayers";
import { CUTTER_HANDOFF_S, CUTTER_ATTACK_MS, CUTTER_RELEASE_MS, cutterPitchCents } from "./miningFeedback";

export type TestResult = {
  name: string;
  pass: boolean;
  detail: string;
};

type Ctor = new (ch: number, len: number, sr: number) => OfflineAudioContext;

function offline(seconds: number, sampleRate = 48000, channels = 1) {
  const C = (window as unknown as { OfflineAudioContext: Ctor })
    .OfflineAudioContext;
  return new C(channels, Math.ceil(seconds * sampleRate), sampleRate);
}

function stats(buf: AudioBuffer) {
  let peak = 0;
  let sumSq = 0;
  let n = 0;
  let maxDelta = 0;
  let dc = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    let prev = d[0];
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sumSq += v * v;
      dc += v;
      const delta = Math.abs(v - prev);
      if (delta > maxDelta) maxDelta = delta;
      prev = v;
      n++;
    }
  }
  return {
    peak,
    rms: Math.sqrt(sumSq / Math.max(1, n)),
    dc: dc / Math.max(1, n),
    maxDelta,
  };
}

/** Energy in a band, by naive DFT at one frequency. Enough to compare bands. */
function bandEnergy(buf: AudioBuffer, freqHz: number): number {
  const d = buf.getChannelData(0);
  const w = (2 * Math.PI * freqHz) / buf.sampleRate;
  let re = 0;
  let im = 0;
  // Sample a bounded window: a full DFT over 2 s at 48 k is 96k iterations per
  // frequency, which is needless for a comparison.
  const N = Math.min(d.length, 8192);
  const start = Math.floor((d.length - N) / 2);
  for (let i = 0; i < N; i++) {
    re += d[start + i] * Math.cos(w * i);
    im += d[start + i] * Math.sin(w * i);
  }
  return Math.sqrt(re * re + im * im) / N;
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

export async function runAudioSelfTest(): Promise<TestResult[]> {
  const out: TestResult[] = [];
  const add = (name: string, pass: boolean, detail: string) =>
    out.push({ name, pass, detail });

  {
    // Correlated sources stay bounded; the common thrust envelope reaches zero.
    const throttles = [NaN, -1, 0, 0.1, 0.25, 0.5, 0.75, 0.99, 1, 2];
    const valid = throttles.every((t) => {
      const gains = ([0, 1, 2] as const).map((layer) => engineLayerGain(layer, t));
      return gains.every((g) => Number.isFinite(g) && g >= 0 && g <= 1)
        && gains.reduce((sum, g) => sum + g, 0) <= 1 + 1e-9
        && (t > 0 ? gains.some((g) => g > 0) : gains.every((g) => g === 0));
    });
    add("engine crossfade is bounded and coasting is silent", valid, "Smooth onset under thrust; zero/invalid demand silences every engine layer");
  }

  // ── 1. Pure maths, no graph needed ──────────────────────────────────────
  {
    // The perceptual slider curve. t=0 must be a HARD zero, not -inf dB.
    const pts: [number, number][] = [
      [0, 0],
      [0.5, 0.25],
      [0.8, 0.64],
      [1, 1],
    ];
    const bad = pts.filter(([t, g]) => !near(sliderToGain(t), g, 1e-9));
    add(
      "slider curve is t² and zero at zero",
      bad.length === 0,
      bad.length ? `wrong at ${JSON.stringify(bad)}` : "0→0, 0.5→0.25, 0.8→0.64, 1→1",
    );
    // Out-of-range input must not produce a negative or >1 gain.
    add(
      "slider curve clamps out-of-range input",
      sliderToGain(-1) === 0 && sliderToGain(5) === 1 && sliderToGain(NaN) === 0,
      `-1→${sliderToGain(-1)}, 5→${sliderToGain(5)}, NaN→${sliderToGain(NaN)}`,
    );
  }
  {
    const d6 = dbToGain(-6);
    add(
      "dbToGain(-6) ≈ 0.501",
      near(d6, 0.5012, 1e-3),
      `${d6.toFixed(4)}`,
    );
  }
  {
    // Distance bands must be monotonically decreasing and reach exactly 0.
    let mono = true;
    let prev = Infinity;
    for (let m = 1; m <= 3000; m += 7) {
      const g = gainForDistance(m);
      if (g > prev + 1e-9) mono = false;
      prev = g;
    }
    add(
      "distance gain is monotonic and reaches silence",
      mono && gainForDistance(1) === 1 && gainForDistance(1e6) === 0,
      `near=${gainForDistance(1)}, far=${gainForDistance(1e6)}, monotonic=${mono}`,
    );
  }
  {
    // Vacuum must be silent, and it must be EXACTLY zero rather than small.
    const p = propagationFor(null, 0, 10);
    add(
      "vacuum silences air-coupled propagation exactly",
      p.gain === 0 && p.tier === "vacuum",
      `gain=${p.gain} tier=${p.tier}`,
    );
    // Climbing must be monotonically quieter, never louder.
    const earth = acousticsForBody("earth");
    const alts = [0, 5, 10, 20, 50, 100];
    const gains = alts.map((a) => propagationFor(earth, a, 50).gain);
    const decreasing = gains.every((g, i) => i === 0 || g <= gains[i - 1] + 1e-9);
    add(
      "altitude monotonically reduces coupling",
      decreasing,
      alts.map((a, i) => `${a}km:${gains[i].toFixed(4)}`).join(" "),
    );
  }

  // ── 2. Rendered graphs ──────────────────────────────────────────────────
  {
    // A bare context must render true silence — establishes that a non-zero
    // reading elsewhere means something, and catches a leaking test harness.
    const ctx = offline(0.2);
    const s = stats(await ctx.startRendering());
    add("empty graph renders exact silence", s.peak === 0, `peak=${s.peak}`);
  }
  {
    // Gain staging: a 0.5 source through a 0.5 gain must be 0.25, not 0.5.
    const ctx = offline(0.3);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0.5;
    osc.frequency.value = 440;
    osc.connect(g).connect(ctx.destination);
    osc.start();
    const s = stats(await ctx.startRendering());
    add(
      "gain stages multiply",
      near(s.peak, 0.5, 0.02),
      `peak=${s.peak.toFixed(4)} (osc amplitude 1 × 0.5)`,
    );
  }
  {
    // Does a fade-in actually remove a start click?
    //
    // ⚠⚠ THE FIRST VERSION OF THIS TEST WAS DEGENERATE AND PASSED NOTHING USEFUL.
    // It started a 220 Hz SINE from silence and compared sample-to-sample delta.
    // But a sine begins at phase 0, i.e. at amplitude ZERO — there is no
    // discontinuity to remove, so faded and un-faded measured identically
    // (0.02880 both), which is simply 2π·220/48000, the sine's own steepest
    // slope. The metric was right; the scenario could not produce the defect.
    //
    // A `ConstantSourceNode` is the correct probe: switching one on from silence
    // is a full-scale STEP, the worst possible click.
    //
    // ⚠ `const` arrow, not a function declaration: tsconfig targets ES5, where a
    // function declaration inside a block is a strict-mode error (TS1252).
    const renderStep = async (fadeS: number) => {
      const ctx = offline(0.2);
      const src = ctx.createConstantSource();
      src.offset.value = 1;
      const g = ctx.createGain();
      const START = 0.05;
      if (fadeS > 0) {
        // The ramp must be anchored to the SOURCE's start, not to t=0, or it
        // would complete before the source exists and shape nothing.
        g.gain.setValueAtTime(0, START);
        g.gain.linearRampToValueAtTime(1, START + fadeS);
      } else {
        g.gain.value = 1;
      }
      src.connect(g).connect(ctx.destination);
      // ⚠⚠ `start(0.05)`, NOT `start(0)`. THIS WAS THE SECOND BUG IN THIS ONE
      // TEST. With the source starting at t=0 the very first sample is already
      // full scale, and `stats()` seeds `prev` from sample 0 — so the step
      // happened *before* the window and measured as maxDelta 0.0000. The
      // discontinuity has to be inside the buffer to be observable at all.
      src.start(START);
      return stats(await ctx.startRendering());
    };
    const hard = await renderStep(0);
    const faded = await renderStep(0.006);
    // A 6 ms ramp to full scale at 48 kHz should step by ~1/288 per sample.
    const expected = 1 / (0.006 * 48000);
    add(
      "a 6 ms fade removes a full-scale start click",
      faded.maxDelta < hard.maxDelta * 0.1 && near(faded.maxDelta, expected, expected),
      `maxDelta hard=${hard.maxDelta.toFixed(4)} faded=${faded.maxDelta.toFixed(5)} (expected ~${expected.toFixed(5)})`,
    );
  }
  {
    // The absorption filter must actually remove highs and spare lows —
    // asserted on band energy, not on the filter's declared frequency.
    const renderThroughLowpass = async (cutoffHz: number, toneHz: number) => {
      const ctx = offline(0.4);
      const osc = ctx.createOscillator();
      osc.frequency.value = toneHz;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = cutoffHz;
      lp.Q.value = 0.0001;
      osc.connect(lp).connect(ctx.destination);
      osc.start();
      return bandEnergy(await ctx.startRendering(), toneHz);
    };
    const lowKept = await renderThroughLowpass(500, 200);
    const highCut = await renderThroughLowpass(500, 8000);
    const ratioDb = 20 * Math.log10(highCut / Math.max(1e-12, lowKept));
    add(
      "absorption lowpass attenuates highs, spares lows",
      ratioDb < -20,
      `8 kHz is ${ratioDb.toFixed(1)} dB below 200 Hz through a 500 Hz corner`,
    );
  }
  {
    // Ducking: the thing §7.6 promises. Assert the measured attenuation matches
    // the configured amount, rather than merely that "it got quieter".
    const DUCK_DB = -8;
    const ctx = offline(1.0);
    const osc = ctx.createOscillator();
    const music = ctx.createGain();
    osc.frequency.value = 300;
    music.gain.setValueAtTime(1, 0);
    music.gain.setTargetAtTime(dbToGain(DUCK_DB), 0.4, 0.02);
    osc.connect(music).connect(ctx.destination);
    osc.start();
    const buf = await ctx.startRendering();
    const sr = buf.sampleRate;
    const seg = (from: number, to: number) => {
      const d = buf.getChannelData(0);
      let sq = 0;
      const a = Math.floor(from * sr);
      const b = Math.floor(to * sr);
      for (let i = a; i < b; i++) sq += d[i] * d[i];
      return Math.sqrt(sq / (b - a));
    };
    const before = seg(0.05, 0.35);
    const after = seg(0.6, 0.95);
    const measured = 20 * Math.log10(after / before);
    add(
      `ducking attenuates by the configured ${DUCK_DB} dB`,
      near(measured, DUCK_DB, 1.0),
      `measured ${measured.toFixed(2)} dB (±1 dB tolerance)`,
    );
  }
  {
    // The master limiter must hold a deliberately overdriven sum under control.
    const ctx = offline(0.5);
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.002;
    lim.release.value = 0.12;
    // The safety clipper the compressor alone cannot replace — see engine.ts.
    const clip = ctx.createWaveShaper();
    clip.curve = softClipCurve();
    clip.oversample = "2x";
    lim.connect(clip).connect(ctx.destination);
    // Eight simultaneous full-scale sources: the "many impacts at once" case.
    for (let i = 0; i < 8; i++) {
      const osc = ctx.createOscillator();
      osc.frequency.value = 200 + i * 37;
      const g = ctx.createGain();
      g.gain.value = 1;
      osc.connect(g).connect(lim);
      osc.start();
    }
    const s = stats(await ctx.startRendering());
    // ⚠ Tolerance 1.01, not 1.0. A `WaveShaper` with `oversample: "2x"`
    // resamples, and the interpolation filter can ring a few ten-thousandths
    // above the curve's own ceiling. MEASURED 1.0004 — that is −68 dBFS of
    // overshoot, inaudible and not a clipping risk. Demanding an exact ≤1.0
    // asserts something an oversampled shaper cannot deliver.
    add(
      "master limiter + clipper hold an 8× overdriven sum at full scale",
      s.peak <= 1.01,
      `peak=${s.peak.toFixed(4)} (unlimited ≈ 8; compressor alone measured 1.3751)`,
    );
  }
  {
    // DC offset would waste headroom and can thump on some hardware.
    const ctx = offline(0.3);
    const osc = ctx.createOscillator();
    osc.frequency.value = 300;
    osc.connect(ctx.destination);
    osc.start();
    const s = stats(await ctx.startRendering());
    add("no DC offset on a symmetric source", Math.abs(s.dc) < 1e-3, `dc=${s.dc.toExponential(2)}`);
  }

  // ── 3. Catalogue invariants that need no audio ──────────────────────────
  {
    const airWorld = ALL_AUDIO_EVENTS.filter(
      (e) => e.tier === "world" && e.coupling === "air",
    );
    const contactWorld = ALL_AUDIO_EVENTS.filter(
      (e) => e.tier === "world" && e.coupling !== "air",
    );
    add(
      "world events declare a coupling intent",
      true,
      `${airWorld.length} air-coupled (silent in vacuum), ${contactWorld.length} contact-coupled (audible in vacuum)`,
    );
    // Priority ladder: an ambient loop must never outrank an alert.
    const ui = ALL_AUDIO_EVENTS.filter((e) => e.tier === "ui");
    const ambient = ALL_AUDIO_EVENTS.filter((e) => e.bus === "ambience");
    const worst = Math.min(...ui.map((e) => e.priority));
    const best = Math.max(...ambient.map((e) => e.priority), -Infinity);
    add(
      "UI/alert priority outranks ambience",
      ambient.length === 0 || best < worst,
      `lowest UI ${worst} vs highest ambience ${best}`,
    );
  }

  // Decode the SHIPPING clips and test the two handoffs at several unrelated
  // sustain phases, cold and hot. A perfect clock sequence can still have a
  // perceptual hole when both authored edges fade to zero.
  try {
    const decoder = offline(0.01);
    const defs = ["mining.laser.start", "mining.laser.loop", "mining.laser.stop"]
      .map((id) => ALL_AUDIO_EVENTS.find((e) => e.id === id)!);
    const buffers = await Promise.all(defs.map(async (def) => Promise.all(def.variants.map(async (url) => {
      const response = await fetch(url, { cache: "no-cache" });
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      return decoder.decodeAudioData(await response.arrayBuffer());
    }))));
    let worstDip = 0, peak = 0;
    for (const heat of [0, 1]) for (const offset of [0, 0.037, 0.51]) for (let variant = 0; variant < buffers[0].length; variant++) {
      const ctx = offline(1.6);
      const rate = 2 ** (cutterPitchCents(heat) / 1200);
      const loopStart = buffers[0][variant].duration / rate - CUTTER_HANDOFF_S;
      const stopAt = 1;
      for (let layer = 0; layer < 3; layer++) {
        const src = ctx.createBufferSource();
        src.buffer = buffers[layer][variant % buffers[layer].length];
        src.playbackRate.value = rate;
        src.loop = layer === 1;
        const gain = ctx.createGain();
        const level = dbToGain(defs[layer].gainDb ?? 0);
        src.connect(gain); gain.connect(ctx.destination);
        if (layer === 1) {
          gain.gain.setValueAtTime(0, 0);
          gain.gain.setValueAtTime(0, loopStart);
          gain.gain.linearRampToValueAtTime(level, loopStart + CUTTER_ATTACK_MS / 1000);
          gain.gain.setTargetAtTime(0, stopAt, CUTTER_RELEASE_MS / 3000);
          src.start(loopStart, offset); src.stop(stopAt + CUTTER_RELEASE_MS / 1000);
        } else if (layer === 2) {
          gain.gain.setValueAtTime(0, stopAt);
          gain.gain.linearRampToValueAtTime(level, stopAt + 0.045);
          src.start(stopAt);
        } else { gain.gain.value = level; src.start(); }
      }
      const rendered = await ctx.startRendering();
      peak = Math.max(peak, stats(rendered).peak);
      const pcm = rendered.getChannelData(0);
      const rms = (at: number) => {
        const start = Math.round(at * ctx.sampleRate), n = Math.round(0.025 * ctx.sampleRate);
        let sum = 0;
        for (let i = start; i < start + n; i++) sum += pcm[i] ** 2;
        return Math.sqrt(sum / n);
      };
      const reference = rms(0.7);
      for (const [from, to] of [[loopStart, loopStart + 0.12], [stopAt, stopAt + 0.09]]) {
        for (let at = from; at <= to; at += 0.01)
          worstDip = Math.min(worstDip, 20 * Math.log10(rms(at) / reference));
      }
    }
    add("shipping cutter handoffs have no energy hole", worstDip > -7 && peak < 0.9,
      `12 phase/heat/variant cases; worst 25ms dip ${worstDip.toFixed(1)} dB, peak ${peak.toFixed(3)}`);
  } catch (error) {
    add("shipping cutter handoffs have no energy hole", false, String(error));
  }

  return out;
}

/** Console-friendly runner. Returns true when everything passed. */
export async function reportAudioSelfTest(): Promise<boolean> {
  const results = await runAudioSelfTest();
  const failed = results.filter((r) => !r.pass);
  // Keep the structured results reachable for a headless/automated run — a
  // console.table is unreadable to anything that is not a human.
  (window as unknown as { __audioSelfTest?: unknown }).__audioSelfTest = results;
  console.table(
    results.map((r) => ({ "": r.pass ? "PASS" : "FAIL", test: r.name, detail: r.detail })),
  );
  console.log(
    failed.length
      ? `[__audio] selftest: ${failed.length}/${results.length} FAILED`
      : `[__audio] selftest: all ${results.length} passed`,
  );
  return failed.length === 0;
}
