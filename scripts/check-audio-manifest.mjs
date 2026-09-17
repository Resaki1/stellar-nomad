#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TIER-1 AUDIO CONTRACT TESTS — docs/AUDIO_PLAN.md §10.1.
//
// Static checks over the catalogue and the source tree. NO AudioContext, no
// browser, no network, instant, CI-safe. These catch the majority of real audio
// bugs, and they are the checks an agent can run before asking a human to
// listen to anything.
//
//   node scripts/check-audio-manifest.mjs
//
// ⚠ ZERO NPM DEPENDENCIES BY DESIGN. Adding a test runner is flagged in
// CLAUDE.md as something to call out rather than do silently, so this uses the
// `tsc` already in devDependencies to transpile the (deliberately
// self-contained) catalogue, then imports it. ffprobe is used for the audio
// header checks when available, and skipped with a warning when not.
//
// ⚠ A CONTRACT TEST ONLY CATCHES WHAT THE SCHEMA ENCODES. The schema is the
// actual gate; extend it deliberately.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const CATALOGUE = "src/data/audioEvents.ts";
const PUBLIC_DIR = "public";
const AUDIO_DIR = "public/audio";

/** Total budget for all SFX/UI/ambience, §6.8. Music streams and is excluded. */
const TOTAL_SFX_BUDGET_MB = 25;
/** No single one-shot should be this big; it usually means a WAV got committed. */
const MAX_ONESHOT_KB = 512;
const MAX_LOOP_KB = 2048;

const problems = [];
const warnings = [];
const fail = (m) => problems.push(m);
const warn = (m) => warnings.push(m);

// ── load the catalogue ─────────────────────────────────────────────────────
function transpileCatalogue() {
  const out = mkdtempSync(join(tmpdir(), "sn-audio-"));
  try {
    execFileSync(
      "node",
      [
        join("node_modules", "typescript", "bin", "tsc"),
        CATALOGUE,
        "--outDir", out,
        "--module", "es2022",
        "--target", "es2022",
        "--moduleResolution", "bundler",
        "--skipLibCheck",
      ],
      { cwd: ROOT, stdio: "pipe" },
    );
  } catch (err) {
    const msg = [err.stdout?.toString(), err.stderr?.toString()]
      .filter(Boolean)
      .join("\n");
    console.error(`Could not transpile ${CATALOGUE}:\n${msg}`);
    console.error(
      "\nIf that file gained an import, it broke the self-contained rule " +
        "documented in its header — this checker depends on it.",
    );
    process.exit(2);
  }
  // The emitted file uses ESM `export`, but a bare .js in a temp dir outside
  // this package resolves as CommonJS and throws "Unexpected token 'export'".
  // This marker is what makes the dynamic import below work.
  writeFileSync(join(out, "package.json"), '{"type":"module"}');
  return { dir: out, file: join(out, "audioEvents.js") };
}

const { dir: tmpDir, file: jsFile } = transpileCatalogue();
let mod;
try {
  mod = await import(pathToFileURL(jsFile).href);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

const EVENTS = mod.AUDIO_EVENTS;
if (!Array.isArray(EVENTS) || EVENTS.length === 0) {
  console.error("AUDIO_EVENTS is empty or not an array.");
  process.exit(2);
}

// ── schema + referential checks ────────────────────────────────────────────
const VALID_BUSES = new Set(["music", "ambience", "sfxShip", "sfxWorld", "ui"]);
const VALID_TIERS = new Set(["ship", "world", "ui"]);
const VALID_NET = new Set(["predicted", "confirmed"]);

const seenIds = new Set();
const referenced = new Set();

for (const e of EVENTS) {
  const where = `event "${e.id}"`;

  if (seenIds.has(e.id)) fail(`${where}: duplicate id`);
  seenIds.add(e.id);

  if (!VALID_BUSES.has(e.bus)) fail(`${where}: invalid bus "${e.bus}"`);
  if (!VALID_TIERS.has(e.tier)) fail(`${where}: invalid tier "${e.tier}"`);
  if (e.netClass && !VALID_NET.has(e.netClass))
    fail(`${where}: invalid netClass "${e.netClass}"`);

  if (!Array.isArray(e.variants) || e.variants.length === 0)
    fail(`${where}: no variants`);
  if (!Number.isFinite(e.priority)) fail(`${where}: priority must be a number`);
  if (!(e.maxInstances >= 1)) fail(`${where}: maxInstances must be >= 1`);
  if (!(e.cooldownMs >= 0)) fail(`${where}: cooldownMs must be >= 0`);
  if (![0, 1, 2].includes(e.preloadTier))
    fail(`${where}: preloadTier must be 0, 1 or 2`);

  // A loop played at N>1 instances needs decorrelated start offsets or it sums
  // coherently (+9.5 dB at N=3, not the +4.8 dB of incoherent summation).
  // registerEmitter() randomises the offset; playAudio() does not.
  if (e.loop && e.maxInstances > 1 && !e.clusterKey)
    warn(
      `${where}: looping with maxInstances ${e.maxInstances} and no clusterKey — ` +
        `start it via registerEmitter (which randomises the start offset), not playAudio`,
    );

  if (e.tier !== "ship" && e.localOffsetM)
    fail(`${where}: localOffsetM is only meaningful for ship-tier events`);

  if (e.coupling && !["air", "contact"].includes(e.coupling))
    fail(`${where}: invalid coupling "${e.coupling}"`);
  if (e.coupling && e.tier !== "world")
    fail(`${where}: coupling is only meaningful for world-tier events`);
  // An air-coupled world sound falls silent in vacuum. That is correct physics
  // and a real gameplay hazard, so make it visible rather than incidental.
  if (e.tier === "world" && e.coupling === "air")
    warn(
      `${where}: coupling "air" — this event is INAUDIBLE in vacuum by design (§12.3c). ` +
        `Correct for a distant/detached source; wrong for anything touching the ship.`,
    );

  for (const v of e.variants) {
    referenced.add(v);
    if (!v.startsWith("/audio/"))
      fail(`${where}: variant "${v}" must live under /audio/`);
    const abs = join(ROOT, PUBLIC_DIR, v);
    if (!existsSync(abs)) {
      fail(`${where}: missing file ${v}`);
      continue;
    }
    const kb = statSync(abs).size / 1024;
    const cap = e.loop ? MAX_LOOP_KB : MAX_ONESHOT_KB;
    if (kb > cap)
      fail(
        `${where}: ${v} is ${kb.toFixed(0)} KB, over the ${cap} KB ${
          e.loop ? "loop" : "one-shot"
        } cap`,
      );
  }
}

// ── channel count: spatialised sources MUST be mono ────────────────────────
function haveFfprobe() {
  try {
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (haveFfprobe()) {
  for (const e of EVENTS) {
    if (e.tier !== "world") continue;
    for (const v of e.variants) {
      const abs = join(ROOT, PUBLIC_DIR, v);
      if (!existsSync(abs)) continue;
      let channels = "?";
      try {
        channels = execFileSync(
          "ffprobe",
          [
            "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=channels",
            "-of", "csv=p=0",
            abs,
          ],
          { encoding: "utf8" },
        ).trim();
      } catch {
        warn(`could not probe ${v}`);
        continue;
      }
      // ⚠ NOT a size optimisation. A stereo buffer fed to a PannerNode makes
      // Web Audio silently upmix stereo→stereo, smearing the directional cue.
      // It does not throw; it just sounds vaguely wrong forever.
      if (channels !== "1")
        fail(
          `${where(e)}: ${v} has ${channels} channels — world-tier ` +
            `(spatialised) sources must be MONO`,
        );
    }
  }
} else {
  warn("ffprobe not found — skipped the mono check on spatialised sources.");
}

function where(e) {
  return `event "${e.id}"`;
}

// ── orphan assets + payload budget ─────────────────────────────────────────
function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let totalBytes = 0;
for (const abs of walk(join(ROOT, AUDIO_DIR))) {
  const rel = "/" + relative(join(ROOT, PUBLIC_DIR), abs).split("\\").join("/");
  totalBytes += statSync(abs).size;
  // Music is streamed on demand and intentionally absent from the catalogue.
  if (rel.startsWith("/audio/music/")) continue;
  if (!referenced.has(rel))
    warn(`orphan asset not referenced by any event: ${rel}`);
}
const totalMB = totalBytes / 1024 / 1024;
if (totalMB > TOTAL_SFX_BUDGET_MB)
  fail(
    `audio payload is ${totalMB.toFixed(1)} MB, over the ` +
      `${TOTAL_SFX_BUDGET_MB} MB budget (§6.8)`,
  );

// ── bus-graph bypass grep ──────────────────────────────────────────────────
// The single most-reported audio complaint in shipped games is a volume slider
// that does not gate everything. Any path bypassing the bus graph reproduces it
// exactly, so this is enforced mechanically rather than left to review. §10.1.
const ENGINE_FILE = "src/audio/engine.ts";

function sourceFiles() {
  return walk(join(ROOT, "src")).filter((p) => /\.tsx?$/.test(p));
}

const files = sourceFiles();

for (const abs of files) {
  const rel = relative(ROOT, abs).split("\\").join("/");
  const text = readFileSync(abs, "utf8");

  if (/new\s+Audio\s*\(/.test(text))
    fail(
      `${rel}: uses \`new Audio(\` — every sound must route through the bus ` +
        `graph via playAudio()/registerEmitter(), or the volume sliders lie`,
    );

  if (
    /new\s+Ctor\s*\(|new\s+(window\.)?(webkit)?AudioContext\s*\(/.test(text) &&
    rel !== ENGINE_FILE
  )
    fail(`${rel}: constructs an AudioContext — only ${ENGINE_FILE} may (A1)`);

  if (/\.connect\(\s*[\w.]*destination\s*\)/.test(text) && rel !== ENGINE_FILE)
    fail(
      `${rel}: connects directly to the AudioContext destination — route via a bus`,
    );
}

// ── every referenced id exists ─────────────────────────────────────────────
// Catches a typo'd string id at a call site that bypassed the typed API
// (a dynamic id, a runtime-built string, `__audio.play()`).
const ID_CALL =
  /\b(?:playAudio|registerEmitter)\s*\(\s*\{?\s*(?:event:\s*)?["'`]([^"'`]+)["'`]/g;
for (const abs of files) {
  const rel = relative(ROOT, abs).split("\\").join("/");
  const text = readFileSync(abs, "utf8");
  for (const m of text.matchAll(ID_CALL)) {
    const id = m[1];
    // A template-literal interpolation is not a literal id — it is either a
    // genuinely dynamic call (which the type system covers) or, as caught on
    // this checker's first run, prose inside a console.warn that happens to
    // quote the function name.
    if (id.includes("${")) continue;
    if (!seenIds.has(id))
      fail(`${rel}: references unknown audio event id "${id}"`);
  }
}

// ── report ─────────────────────────────────────────────────────────────────
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ! ${w}`);
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    `\naudio contract: FAILED (${EVENTS.length} events, ` +
      `${referenced.size} files, ${totalMB.toFixed(2)} MB)`,
  );
  process.exit(1);
}

console.log(
  `\naudio contract: 0 problems (${EVENTS.length} events, ` +
    `${referenced.size} files, ${totalMB.toFixed(2)} MB of ` +
    `${TOTAL_SFX_BUDGET_MB} MB budget)`,
);
