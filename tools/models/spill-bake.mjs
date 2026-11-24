#!/usr/bin/env node
/**
 * S3 lamp-spill bake (docs/VFX_REALISM_PLAN.md §4): bakes the steady lamps' diffuse light into
 * one lightmap per render LOD of a station master, on a second UV map ("Spill lightmap",
 * glTF TEXCOORD_1), and saves the master. Lamp photometry comes from emissivePhotometry.ts, so
 * the bake and the game's light points cannot drift.
 *
 *   node tools/models/spill-bake.mjs art/stations/base-depot/base-depot.blend base-depot [--sizes 512,256,128] [--samples 256]
 *
 * Writes public/models/stations/<name>-spill-lod{N}.hdr (irradiance, game units, before
 * pre-exposure) and <name>-spill.json (calibration). Re-export the GLBs afterwards with
 * `pnpm model build` (the new UV map rides along). Run outside Seatbelt.
 */
import { register } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

register(new URL("../../scripts/lib/ts-hooks.mjs", import.meta.url));
const { EMITTERS, emitterColor } = await import("../../src/components/space/emissivePhotometry.ts");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { sizes: { type: "string", default: "512,256,128" }, samples: { type: "string", default: "256" }, out: { type: "string", default: "public/models/stations" } },
});
const [blend, name] = positionals;
if (!blend || !name) throw new Error("usage: spill-bake.mjs <master.blend> <asset-name> [--sizes 512,256,128] [--samples 256]");

// Game units × m² per m² of lamp face, per channel (readLightTemplate: emitterColor × area).
const emitters = {};
for (const id of Object.keys(EMITTERS)) {
  const c = emitterColor(id);
  emitters[id] = [c.r, c.g, c.b];
}
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const out = path.resolve(ROOT, values.out);
mkdirSync(out, { recursive: true });
const cfgDir = path.resolve(ROOT, ".captures/models/spill");
mkdirSync(cfgDir, { recursive: true });
const cfg = path.join(cfgDir, `${name}.json`);
writeFileSync(cfg, JSON.stringify({
  name, out, emitters,
  sizes: values.sizes.split(",").map(Number),
  samples: Number(values.samples),
}, null, 1));

const candidates = [process.env.BLENDER_BIN, path.join(process.env.HOME ?? "", "Applications/Blender.app/Contents/MacOS/Blender"),
  "/Applications/Blender.app/Contents/MacOS/Blender", "blender"].filter(Boolean);
const bin = candidates.find((c) => c === "blender" || existsSync(c));
execFileSync(bin, ["-b", path.resolve(ROOT, blend), "--factory-startup", "--disable-autoexec", "--python-exit-code", "1",
  "--python", path.join(ROOT, "tools/models/bake_spill.py"), "--", cfg], { stdio: "inherit" });
