#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Generate PLACEHOLDER audio assets for Phase 0. docs/AUDIO_PLAN.md §6.2.
//
// These are synthetic beeps and noise bursts whose only job is to prove the
// signal path end to end: fetch → decodeAudioData → voice pool → bus →
// limiter → destination. They are meant to be replaced wholesale in Phase 1;
// the EVENT IDS are the stable part, not these files.
//
// Zero npm dependencies: WAVs are written byte by byte, then handed to ffmpeg
// for Opus encoding. Only ffmpeg is required.
//
//   node scripts/gen-placeholder-audio.mjs
//
// ⚠ WORLD-TIER FILES ARE WRITTEN MONO, and that is not a size optimisation.
// Feeding a STEREO buffer into a PannerNode makes Web Audio silently switch to
// stereo→stereo upmixing, smearing the directional cue instead of erroring. It
// does not throw. It just sounds vaguely wrong forever. `check-audio-manifest`
// enforces this.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

const SR = 48000;
const OUT_2D = "public/audio/sfx2d";
const OUT_3D = "public/audio/sfx3d";
const TMP = join(process.env.TMPDIR ?? "/tmp", "sn-placeholder-audio");

// ── tiny DSP helpers ───────────────────────────────────────────────────────
const clamp = (v) => Math.max(-1, Math.min(1, v));

/** Deterministic PRNG so regenerating does not churn the assets. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function env(t, dur, attack, release) {
  if (t < attack) return t / attack;
  const tail = dur - release;
  if (t > tail) return Math.max(0, (dur - t) / release);
  return 1;
}

/** One-pole lowpass, used to take the edge off raw noise. */
function lowpass(samples, cutoffHz) {
  const dt = 1 / SR;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const a = dt / (rc + dt);
  let prev = 0;
  for (let i = 0; i < samples.length; i++) {
    prev += a * (samples[i] - prev);
    samples[i] = prev;
  }
  return samples;
}

function render(durationS, fn) {
  const n = Math.round(durationS * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i / SR, durationS);
  return out;
}

/**
 * Fade the very ends to zero regardless of content.
 * Any non-zero first or last sample is an audible click on every single play.
 */
function deClick(samples, ms = 3) {
  const k = Math.min(Math.round((ms / 1000) * SR), Math.floor(samples.length / 2));
  for (let i = 0; i < k; i++) {
    const g = i / k;
    samples[i] *= g;
    samples[samples.length - 1 - i] *= g;
  }
  return samples;
}

/** Make a loop seamless by crossfading the tail over the head. */
function makeSeamless(samples, fadeMs = 120) {
  const k = Math.min(Math.round((fadeMs / 1000) * SR), Math.floor(samples.length / 3));
  const out = samples.slice(0, samples.length - k);
  for (let i = 0; i < k; i++) {
    const g = i / k;
    out[i] = out[i] * g + samples[samples.length - k + i] * (1 - g);
  }
  return out;
}

function writeWav(path, samples, channels = 1) {
  const n = samples.length;
  const dataBytes = n * channels * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  for (let i = 0; i < n; i++) {
    const v = Math.round(clamp(samples[i]) * 32767);
    for (let c = 0; c < channels; c++) {
      buf.writeInt16LE(v, 44 + (i * channels + c) * 2);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
}

// ── the placeholder sounds ─────────────────────────────────────────────────
const SOUNDS = [
  {
    out: `${OUT_2D}/ui_click_soft.opus`,
    channels: 1,
    render: () =>
      deClick(
        lowpass(
          render(0.05, (t, d) => {
            const r = rng(11);
            return (r() * 2 - 1) * env(t, d, 0.001, 0.045) * 0.6;
          }),
          2200,
        ),
      ),
  },
  {
    out: `${OUT_2D}/ui_click_hard.opus`,
    channels: 1,
    render: () =>
      deClick(
        render(0.06, (t, d) => {
          const r = rng(23);
          const noise = (r() * 2 - 1) * 0.5;
          const tone = Math.sin(2 * Math.PI * 900 * t) * 0.5;
          return (noise + tone) * env(t, d, 0.0005, 0.05);
        }),
      ),
  },
  {
    out: `${OUT_2D}/ui_hover_tick.opus`,
    channels: 1,
    render: () =>
      deClick(
        render(0.025, (t, d) =>
          Math.sin(2 * Math.PI * 2600 * t) * env(t, d, 0.0005, 0.022) * 0.5,
        ),
      ),
  },
  {
    out: `${OUT_2D}/ui_notify_info.opus`,
    channels: 1,
    // Two-tone rising: the conventional "acknowledged" shape.
    render: () =>
      deClick(
        render(0.26, (t, d) => {
          const f = t < 0.1 ? 660 : 880;
          return Math.sin(2 * Math.PI * f * t) * env(t, d, 0.004, 0.09) * 0.45;
        }),
      ),
  },
  {
    out: `${OUT_2D}/ui_notify_warn.opus`,
    channels: 1,
    // Two-tone FALLING plus a beat, per §6.3: severity reads from PATTERN, not
    // only pitch. Real spacecraft alerting works this way.
    render: () =>
      deClick(
        render(0.36, (t, d) => {
          const f = t < 0.14 ? 520 : 400;
          const gate = t > 0.16 && t < 0.2 ? 0 : 1;
          return (
            Math.sin(2 * Math.PI * f * t) * env(t, d, 0.004, 0.1) * gate * 0.5
          );
        }),
      ),
  },
  {
    out: `${OUT_2D}/ship_engine_loop.opus`,
    channels: 1,
    loop: true,
    render: () => {
      const r = rng(97);
      const raw = render(2.4, (t) => {
        const rumble =
          Math.sin(2 * Math.PI * 58 * t) * 0.5 +
          Math.sin(2 * Math.PI * 87 * t) * 0.22;
        const hiss = (r() * 2 - 1) * 0.28;
        const wobble = 1 + 0.05 * Math.sin(2 * Math.PI * 0.7 * t);
        return (rumble * wobble + hiss) * 0.55;
      });
      return deClick(makeSeamless(lowpass(raw, 1400)), 2);
    },
  },
  ...[1, 2, 3].map((i) => ({
    out: `${OUT_3D}/impact_0${i}.opus`,
    channels: 1, // MONO — spatialised. See the header warning.
    render: () => {
      const r = rng(1000 + i * 37);
      return deClick(
        lowpass(
          render(0.34, (t, d) => {
            const noise = (r() * 2 - 1);
            const thud = Math.sin(2 * Math.PI * (120 - i * 18) * t);
            return (
              (noise * 0.7 + thud * 0.6) * env(t, d, 0.001, 0.3) * 0.85
            );
          }),
          3000 + i * 700,
        ),
      );
    },
  })),
  {
    out: `${OUT_3D}/station_vent_loop.opus`,
    channels: 1, // MONO — spatialised.
    loop: true,
    render: () => {
      const r = rng(555);
      const raw = render(3.2, (t) => {
        const air = (r() * 2 - 1) * 0.5;
        const hum = Math.sin(2 * Math.PI * 120 * t) * 0.12;
        const breathe = 1 + 0.18 * Math.sin(2 * Math.PI * 0.25 * t);
        return (air * breathe + hum) * 0.5;
      });
      return deClick(makeSeamless(lowpass(raw, 900)), 2);
    },
  },
];

// Close inspection (B11): rising two-tone start, a quiet 8 Hz scan tick loop, a bright confirm chirp.
SOUNDS.push(
  {
    out: `${OUT_2D}/mining_inspect_start.opus`,
    channels: 1,
    render: () =>
      deClick(
        render(0.18, (t, d) => {
          const f = t < 0.07 ? 1180 : 1580;
          return Math.sin(2 * Math.PI * f * t) * env(t, d, 0.003, 0.06) * 0.42;
        }),
      ),
  },
  {
    out: `${OUT_2D}/mining_inspect_loop.opus`,
    channels: 1,
    loop: true,
    // 8 ticks per second over exactly 1 s, so the loop seam falls between ticks.
    render: () =>
      render(1.0, (t) => {
        const ph = (t * 8) % 1;
        const tick = ph < 0.018 ? Math.sin(2 * Math.PI * 2400 * t) * Math.sin((Math.PI * ph) / 0.018) : 0;
        const bed = Math.sin(2 * Math.PI * 620 * t) * 0.05;
        return (tick * 0.5 + bed) * 0.6;
      }),
  },
  {
    out: `${OUT_2D}/mining_inspect_complete.opus`,
    channels: 1,
    render: () =>
      deClick(
        render(0.3, (t, d) => {
          const f = t < 0.08 ? 1320 : t < 0.16 ? 1760 : 2350;
          return (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)) * env(t, d, 0.002, 0.12) * 0.34;
        }),
      ),
  },
);

// Optional name filter (`... inspect`): write only matching outputs, so a new placeholder does not
// regenerate (and orphan) the ones real assets have replaced.
const ONLY = process.argv[2] ?? null;

// ── run ────────────────────────────────────────────────────────────────────
function haveFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!haveFfmpeg()) {
  console.error(
    "ffmpeg not found. Install it (brew install ffmpeg) — it does the Opus encode.",
  );
  process.exit(1);
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

let made = 0;
for (const s of SOUNDS) {
  if (ONLY && !s.out.includes(ONLY)) continue;
  const wav = join(TMP, s.out.replace(/\//g, "_").replace(/\.opus$/, ".wav"));
  writeWav(wav, s.render(), s.channels);

  mkdirSync(dirname(s.out), { recursive: true });
  // 96 kbps is generous for placeholders but keeps the loops clean; §6.8 puts
  // real SFX at 48-96 kbps.
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", wav,
    "-c:a", "libopus",
    "-b:a", "96k",
    "-ac", String(s.channels),
    "-application", "audio",
    s.out,
  ]);
  made++;
  console.log(`  ${s.out}${s.loop ? "  (seamless loop)" : ""}`);
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${made} placeholder files written.`);
if (!existsSync(OUT_3D)) process.exit(1);
