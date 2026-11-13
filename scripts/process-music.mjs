#!/usr/bin/env node
// ---------------------------------------------------------------------------
// MUSIC PIPELINE — docs/AUDIO_PLAN.md §7.4.
//
//   node scripts/process-music.mjs          process AUDIO/music → public/audio/music
//   node scripts/process-music.mjs --check  re-measure the shipped files, change nothing
//
// The manifest `src/data/musicTracks.json` holds both halves of each entry:
// AUTHORED fields (source, title, artist, mood, weight) that a human writes,
// and MEASURED fields (durationSec, startSec, endSec, lufs, truePeakDb, gainDb)
// that only this script writes.
//
// 🔑 LOSSLESS WHEN THE SOURCE IS ALREADY OPUS. Suno's "M4A" is Opus-in-MP4 at
// ~145 kbps; re-encoding it would add a second generation of loss. So an Opus
// source is REMUXED (stream copy) into Ogg, and everything a re-encode would
// have baked in — loudness gain, edge-silence trim, fades — is applied at
// runtime from the manifest instead. Only non-Opus sources are encoded.
//
// ⚠ Metadata is stripped on purpose: Suno embeds a generation id and creation
// timestamp in the comment tag. Credits live in the manifest and CREDITS.md.
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = "AUDIO/music";
const DEST = "public/audio/music";
const MANIFEST = "src/data/musicTracks.json";
/** Integrated loudness every track is brought to, LUFS. Under the -16 SFX pack. */
const TARGET_LUFS = -18;
const TRUE_PEAK_CEILING = -1;
/** Below this, an edge is digital silence and gets skipped at playback. */
const SILENCE_DB = -60;

const check = process.argv.includes("--check");
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1048576 });
// ffmpeg prints filter analysis on stderr even on success; fold it into stdout.
function ffmpegStderr(file, filter) {
  return execFileSync("sh", ["-c", 'ffmpeg -hide_banner -nostats -i "$0" -af "$1" -f null - 2>&1', file, filter], {
    encoding: "utf8", maxBuffer: 64 * 1048576,
  });
}

function probe(file) {
  const json = JSON.parse(run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]));
  const audio = json.streams.find((s) => s.codec_type === "audio");
  return { codec: audio?.codec_name, channels: audio?.channels, rate: Number(audio?.sample_rate),
    duration: Number(json.format.duration), formatTags: json.format.tags ?? {}, streamTags: audio?.tags ?? {} };
}

function loudness(file) {
  const out = ffmpegStderr(file, `loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK_CEILING}:print_format=json`);
  const json = JSON.parse(out.slice(out.lastIndexOf("{"), out.lastIndexOf("}") + 1));
  return { lufs: Number(json.input_i), truePeakDb: Number(json.input_tp) };
}

function edges(file, duration) {
  const out = ffmpegStderr(file, `silencedetect=noise=${SILENCE_DB}dB:d=0.1`);
  const starts = [...out.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...out.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  // Leading silence: a run that starts at ~0. Trailing: a run that reaches the end
  // (silencedetect omits silence_end for a run still open at EOF).
  const startSec = starts.length && starts[0] < 0.05 && ends.length ? ends[0] : 0;
  const lastStart = starts.at(-1);
  const openAtEnd = lastStart !== undefined && starts.length > ends.length;
  const closedAtEnd = lastStart !== undefined && ends.length && Math.abs(ends.at(-1) - duration) < 0.1;
  const endSec = lastStart !== undefined && lastStart > startSec && (openAtEnd || closedAtEnd) ? lastStart : duration;
  return { startSec: round(startSec), endSec: round(endSec) };
}

const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
if (!check) mkdirSync(DEST, { recursive: true });
let failures = 0;
const fail = (msg) => { failures++; console.error(`✗ ${msg}`); };

for (const track of manifest.tracks) {
  if (!/^[a-z0-9_]+$/.test(track.id)) { fail(`${track.id}: id must be [a-z0-9_]`); continue; }
  const output = join(DEST, `${track.id}.opus`);

  if (!check) {
    const input = join(SOURCE, track.source);
    if (!existsSync(input)) { fail(`${track.id}: missing source ${input}`); continue; }
    const src = probe(input);
    const strip = ["-map", "0:a:0", "-map_metadata", "-1", "-map_chapters", "-1", "-fflags", "+bitexact"];
    const codec = src.codec === "opus" ? ["-c:a", "copy"] : ["-c:a", "libopus", "-b:a", "160k", "-vbr", "on", "-ar", "48000"];
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", input, ...strip, ...codec, "-f", "ogg", output]);
    track.encoded = src.codec === "opus" ? "remux" : `libopus 160k from ${src.codec}`;
  }

  if (!existsSync(output)) { fail(`${track.id}: ${output} missing`); continue; }
  const out = probe(output);
  if (out.codec !== "opus") fail(`${track.id}: shipped codec ${out.codec}, expected opus`);
  if (out.rate !== 48000) fail(`${track.id}: sample rate ${out.rate}`);
  // Only a container-level `encoder` may remain; any other tag is leaked metadata.
  const leaked = [...Object.keys(out.formatTags), ...Object.keys(out.streamTags)].filter((k) => k.toLowerCase() !== "encoder");
  if (leaked.length) fail(`${track.id}: metadata not stripped: ${leaked.join(", ")}`);

  const { lufs, truePeakDb } = loudness(output);
  const { startSec, endSec } = edges(output, out.duration);
  // Bring every track to the same integrated loudness, but never push the true
  // peak over the ceiling to get there.
  const gainDb = round(Math.min(TARGET_LUFS - lufs, TRUE_PEAK_CEILING - truePeakDb), 2);
  const measured = { durationSec: round(out.duration), startSec, endSec, lufs, truePeakDb, gainDb };

  if (check) {
    for (const [k, v] of Object.entries(measured)) {
      const tol = k === "lufs" || k === "truePeakDb" || k === "gainDb" ? 0.15 : 0.05;
      if (typeof track[k] !== "number" || Math.abs(track[k] - v) > tol) fail(`${track.id}: ${k} manifest ${track[k]} vs measured ${v}`);
    }
  } else {
    Object.assign(track, measured);
  }
  const kb = Math.round(statSync(output).size / 1024);
  console.log(`${check ? "checked" : "processed"} ${track.id.padEnd(22)} ${lufs.toFixed(1)} LUFS → gain ${gainDb >= 0 ? "+" : ""}${gainDb.toFixed(2)} dB · TP ${truePeakDb.toFixed(1)} · play ${startSec}–${endSec}s of ${round(out.duration, 1)}s · ${kb} kB · ${track.encoded ?? ""}`);
}

if (!check) writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
if (failures) { console.error(`${failures} problem(s)`); process.exit(1); }
console.log(`${manifest.tracks.length} tracks ${check ? "verified" : "processed"}: target ${TARGET_LUFS} LUFS, TP ≤ ${TRUE_PEAK_CEILING} dBTP, metadata stripped.`);
