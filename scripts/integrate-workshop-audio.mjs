#!/usr/bin/env node
// Promote the reproducible workshop pack without changing its authored balance.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const source = "AUDIO/workshop";
const destination = "public/audio/workshop";
const report = JSON.parse(readFileSync(join(source, "report.json"), "utf8"));
const checkOnly = process.argv.includes("--check");
mkdirSync(destination, { recursive: true });
let bytes = 0;
for (const entry of report.results) {
  if (!/^[a-z0-9_]+\.wav$/.test(entry.file)) throw new Error("Invalid workshop filename");
  if (!entry.stats.finite || entry.stats.silent) throw new Error(`Invalid render: ${entry.file}`);
  const input = join(source, entry.file);
  const output = join(destination, entry.file.replace(/\.wav$/, entry.loop ? ".wav" : ".opus"));
  // Lossless loops preserve exact periods and correlated engine-layer phase.
  // No trimming, edge fades or loudnorm: these would break the authored loop/mix.
  if (!checkOnly && entry.loop) copyFileSync(input, output);
  else if (!checkOnly) execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input,
    "-map_metadata", "-1", "-ac", "1", "-c:a", "libopus", "-b:a", "96k", output]);
  // Verify the actual shipping decode, not just the uncompressed source report.
  const decoded = execFileSync("ffmpeg", ["-v", "error", "-i", output,
    "-f", "f32le", "-ar", "48000", "-ac", "1", "pipe:1"], { maxBuffer: 8 * 1048576 });
  const frames = decoded.length / 4;
  assert.ok(Math.abs(frames - Math.round(entry.recipe.duration * 48000)) <= 48, `${output}: duration`);
  let peak = 0;
  for (let i = 0; i < decoded.length; i += 4) {
    const sample = decoded.readFloatLE(i);
    assert.ok(Number.isFinite(sample), `${output}: nonfinite sample`);
    peak = Math.max(peak, Math.abs(sample));
  }
  assert.ok(peak > 0.001 && peak < 0.9, `${output}: silent or insufficient headroom (${peak})`);
  if (entry.loop) assert.ok(readFileSync(input).equals(readFileSync(output)), `${output}: changed loop samples/markers`);
  bytes += statSync(output).size;
}
console.log(`${checkOnly ? "Verified" : "Integrated and verified"} ${report.results.length} workshop assets (${(bytes / 1048576).toFixed(2)} MiB): decoded duration, finite samples, headroom, lossless loop identity.`);
