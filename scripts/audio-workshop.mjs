#!/usr/bin/env node
// Same typed renderer as /dev/audio, compiled with the existing TypeScript toolchain.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const recipeIndex = args.indexOf("--recipe");
const outIndex = args.indexOf("--out");
if (args.includes("--help")) {
  console.log("pnpm gen:audio-workshop [--out DIRECTORY] [--recipe RECIPE.json]\npnpm check:audio-workshop\nWAVs are candidates in AUDIO/workshop; public/audio and the game catalogue are untouched.");
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--check") continue;
  if ((args[i] === "--out" || args[i] === "--recipe") && args[i + 1] && !args[i + 1].startsWith("--")) { i++; continue; }
  throw new Error(`Unknown or incomplete option: ${args[i]}`);
}
const output = resolve(outIndex >= 0 ? args[outIndex + 1] : "AUDIO/workshop");
const temp = mkdtempSync(join(tmpdir(), "stellar-audio-workshop-"));
try {
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc",
    "src/audio/workshop/synthesize.ts", "src/audio/workshop/export.ts",
    "--outDir", temp, "--module", "commonjs", "--target", "es2022", "--strict", "--skipLibCheck"], { stdio: "pipe" });
  const require = createRequire(import.meta.url);
  const { SOUND_PRESETS, createRecipe, parseRecipe, durationRange } = require(join(temp, "presets.js"));
  const { renderSound, RENDERER_VERSION } = require(join(temp, "synthesize.js"));
  const { encodeWav, recipeDocument, soundFilename } = require(join(temp, "export.js"));
  const report = [];
  let assertions = 0;
  const check = (condition, detail) => { assert.ok(condition, detail); assertions++; };

  function inspect(sound) {
    const { samples, stats, recipe, loop } = sound;
    const prefix = `${recipe.presetId} / seed ${recipe.seed}`;
    check(stats.finite && !stats.silent, `${prefix}: non-finite or silent`);
    check(stats.peakDb <= -4.99, `${prefix}: sample headroom`);
    check(Math.abs(stats.dc) < 1e-6, `${prefix}: DC offset`);
    check(samples.length === Math.round(recipe.duration * 48000), `${prefix}: duration`);
    if (recipe.presetId.startsWith("ship.engine.") && recipe.body === 1 && recipe.pitch === 0) {
      // Guard the audible balance: fan-like broadband noise once masked all
      // of the bass. Measure energy through a two-pole 160 Hz lowpass.
      const coefficient = 1 - Math.exp(-2 * Math.PI * 160 / 48000);
      let low = 0, low2 = 0, bassEnergy = 0, totalEnergy = 0;
      for (const sample of samples) {
        low += coefficient * (sample - low);
        low2 += coefficient * (low - low2);
        bassEnergy += low2 * low2;
        totalEnergy += sample * sample;
      }
      check(bassEnergy / totalEnergy > 0.45, `${prefix}: engine bass body masked by broadband noise`);
    }
    if (loop) {
      // A wrap is one ordinary sample step, not a forced zero crossing. Compare
      // it with the actual waveform slope, not an arbitrary transient threshold.
      check(stats.seamDelta <= Math.max(0.002, stats.maxDelta * 1.2), `${prefix}: loop discontinuity`);
      const window = Math.min(2400, Math.floor(samples.length / 8));
      const power = (start) => {
        let sum = 0;
        for (let i = start; i < start + window; i++) sum += samples[i] ** 2;
        return sum / window;
      };
      const middle = power(Math.floor(samples.length / 2));
      check(power(0) / middle > 0.1 && power(samples.length - window) / middle > 0.1, `${prefix}: silent loop edge`);
    } else check(samples[0] === 0 && samples.at(-1) === 0, `${prefix}: nonzero one-shot endpoints`);

    const wav = encodeWav(sound);
    const header = new DataView(wav);
    check(header.getUint16(22, true) === 1 && header.getUint16(34, true) === 24 && header.getUint32(24, true) === 48000, `${prefix}: WAV format`);
    check(header.getUint32(4, true) + 8 === wav.byteLength && wav.byteLength % 2 === 0, `${prefix}: RIFF padding/size`);
    let roundtripError = 0;
    for (let i = 0; i < samples.length; i++) {
      const offset = 44 + i * 3;
      let v = header.getUint8(offset) | header.getUint8(offset + 1) << 8 | header.getUint8(offset + 2) << 16;
      if (v & 0x800000) v -= 0x1000000;
      roundtripError = Math.max(roundtripError, Math.abs(v / (v < 0 ? 8388608 : 8388607) - samples[i]));
    }
    check(roundtripError < 1.3e-7, `${prefix}: WAV sample round-trip`);
    if (loop) {
      const at = 44 + samples.length * 3 + (samples.length * 3 % 2);
      check(header.getUint32(at + 36, true) === 1 && header.getUint32(at + 52, true) === 0 && header.getUint32(at + 56, true) === samples.length - 1, `${prefix}: loop markers`);
    }
    return wav;
  }

  let recipes;
  if (recipeIndex >= 0) {
    const doc = JSON.parse(readFileSync(resolve(args[recipeIndex + 1]), "utf8"));
    if (doc.recipe && doc.rendererVersion !== RENDERER_VERSION) throw new Error("Unsupported renderer version");
    recipes = [parseRecipe(doc.recipe ?? doc)];
  } else {
    recipes = SOUND_PRESETS.flatMap((preset) => Array.from({ length: preset.variants }, (_, i) => ({ ...createRecipe(preset.id), seed: 24017 + i })));
  }
  if (!checkOnly) mkdirSync(output, { recursive: true });
  const started = performance.now();
  for (const recipe of recipes) {
    const start = performance.now();
    const sound = renderSound(recipe);
    const renderMs = performance.now() - start;
    const wav = inspect(sound);
    const name = soundFilename(sound);
    report.push({ file: `${name}.wav`, renderMs: Math.round(renderMs), ...recipeDocument(sound) });
    if (!checkOnly) {
      writeFileSync(join(output, `${name}.wav`), new Uint8Array(wav));
      writeFileSync(join(output, `${name}.recipe.json`), JSON.stringify(recipeDocument(sound), null, 2) + "\n");
    }
  }

  // Exercise exposed boundaries, determinism, variations, validation and silence.
  if (checkOnly) {
    for (const preset of SOUND_PRESETS) {
      const base = createRecipe(preset.id);
      for (const high of [false, true]) {
        const edge = { ...base, duration: durationRange(preset)[high ? 1 : 0], pitch: high ? 12 : -12, brightness: high ? 1 : 0, motion: high ? 1 : 0 };
        inspect(renderSound(edge));
      }
      const a = renderSound(base), b = renderSound(base), c = renderSound({ ...base, seed: base.seed + 1 });
      check(a.samples.every((s, i) => Math.abs(s - b.samples[i]) < 1e-7), `${preset.id}: same-runtime reproducibility`);
      check(a.samples.some((s, i) => Math.abs(s - c.samples[i]) > 1e-4), `${preset.id}: seed has no effect`);
    }
    const base = createRecipe(SOUND_PRESETS[0].id);
    check(renderSound({ ...base, body: 0, texture: 0, detail: 0 }).stats.silent, "all layers off must be silent");
    for (const invalid of [null, {}, { ...base, duration: Infinity }, { ...base, duration: -1 }, { ...base, duration: 3600 }, { ...base, seed: 0.5 }, { ...base, seed: -1 }, { ...base, pitch: NaN }, { ...base, version: 99 }, { ...base, presetId: "unknown" }]) {
      assert.throws(() => parseRecipe(invalid)); assertions++;
    }
    // Odd frame count tests RIFF byte padding too.
    inspect(renderSound({ ...createRecipe("click.soft"), duration: 3601 / 48000 }));
  }

  const summary = { rendererVersion: RENDERER_VERSION, assertions, files: report.length, elapsedMs: Math.round(performance.now() - started), results: report };
  if (!checkOnly) writeFileSync(join(output, "report.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`${checkOnly ? "Checked" : "Generated"} ${report.length} assets; ${assertions} assertions passed in ${summary.elapsedMs} ms.${checkOnly ? "" : `\nOutput: ${output}`}`);
} catch (error) {
  if (error.stdout) console.error(error.stdout.toString());
  if (error.stderr) console.error(error.stderr.toString());
  throw error;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
