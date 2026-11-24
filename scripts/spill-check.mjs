#!/usr/bin/env node
/**
 * S3 guard (docs/VFX_REALISM_PLAN.md §4): every runtime model with steady lamps ships a
 * current lamp-spill bake. Plain Node, no browser; runs as `prebuild` and `pnpm check:spill`.
 *
 * For each public/models/**\/<asset>[-lodN].glb (collision proxies skipped) whose nodes carry
 * a steady lamp (extras.emitter, blink 0):
 *   - <asset>-spill.json and <asset>-spill-lod{N}.hdr exist for that LOD,
 *   - every primitive has TEXCOORD_1 (the "Spill lightmap" UV),
 *   - the bake is current: the GLB's triangle count and steady-lamp list (emitter, area,
 *     position) equal what the bake recorded. Re-bake: node tools/models/spill-bake.mjs …
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MODELS = path.join(ROOT, "public/models");

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function gltfJson(file) {
  const b = readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString("utf8"));
}

// Column-major 4×4 from a glTF node (matrix or TRS).
function local(n) {
  if (n.matrix) return n.matrix.slice();
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

function inspect(j) {
  const lamps = [];
  let triangles = 0;
  let missingUv1 = 0;
  const visit = (i, parent) => {
    const n = j.nodes[i];
    const m = mul(parent, local(n));
    const e = n.extras ?? {};
    if (typeof e.emitter === "string" && Number(e.area_m2) > 0 && !(Number(e.blink) > 0)) {
      lamps.push([e.emitter, Math.round(Number(e.area_m2) * 1e4) / 1e4, ...[m[12], m[13], m[14]].map((v) => Math.round(v * 1e3) / 1e3)]);
    }
    if (n.mesh !== undefined) {
      for (const p of j.meshes[n.mesh].primitives) {
        if ((p.mode ?? 4) !== 4) continue;
        const count = p.indices !== undefined ? j.accessors[p.indices].count : j.accessors[p.attributes.POSITION].count;
        triangles += count / 3;
        // Lamp meshes (emissive, untextured) carry no lightmap: only receivers need TEXCOORD_1.
        const mat = p.material !== undefined ? j.materials[p.material] : null;
        const emissive = (mat?.emissiveFactor ?? [0, 0, 0]).some((v) => v > 0);
        if (!emissive && p.attributes.TEXCOORD_1 === undefined) missingUv1++;
      }
    }
    for (const c of n.children ?? []) visit(c, m);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const r of j.scenes[j.scene ?? 0].nodes) visit(r, I);
  return { lamps, triangles, missingUv1 };
}

// One numeric order on both sides (Array#sort would compare the rows as strings).
const byLamp = (p, q) => {
  for (let k = 0; k < p.length; k++) {
    if (p[k] === q[k]) continue;
    return typeof p[k] === "number" ? p[k] - q[k] : String(p[k]) < String(q[k]) ? -1 : 1;
  }
  return 0;
};
const sameLamps = (a, b) => {
  if (a.length !== b.length) return false;
  const x = [...a].sort(byLamp), y = [...b].sort(byLamp);
  return x.every((l, i) => l.every((v, k) => typeof v === "number" ? Math.abs(v - y[i][k]) <= 2e-3 : v === y[i][k]));
};

const problems = [];
let checked = 0;
for (const file of walk(MODELS).filter((f) => f.endsWith(".glb") && !f.endsWith("-collision.glb"))) {
  const base = file.replace(/(-lod(\d))?\.glb$/, "");
  const lod = Number(file.match(/-lod(\d)\.glb$/)?.[1] ?? 0);
  const rel = path.relative(ROOT, file);
  const g = inspect(gltfJson(file));
  if (g.lamps.length === 0) continue;
  checked++;
  const meta = `${base}-spill.json`;
  const hdr = `${base}-spill-lod${lod}.hdr`;
  const fix = `re-bake: node tools/models/spill-bake.mjs <master.blend> ${path.basename(base)} --out ${path.relative(ROOT, path.dirname(file))}, then re-export the LODs`;
  if (!existsSync(meta) || !existsSync(hdr)) { problems.push(`${rel}: ${g.lamps.length} steady lamps but no spill bake (${path.basename(existsSync(meta) ? hdr : meta)} missing); ${fix}`); continue; }
  if (g.missingUv1) problems.push(`${rel}: ${g.missingUv1} primitives without TEXCOORD_1 (the lightmap UV); export from the baked master`);
  const rec = JSON.parse(readFileSync(meta, "utf8")).lods?.[lod];
  if (!rec?.lampList || rec.triangles === undefined) { problems.push(`${rel}: ${path.basename(meta)} predates the staleness record; ${fix}`); continue; }
  if (rec.triangles !== g.triangles) problems.push(`${rel}: geometry changed since the bake (${g.triangles} triangles, baked ${rec.triangles}); ${fix}`);
  if (!sameLamps(g.lamps, rec.lampList)) problems.push(`${rel}: steady lamps changed since the bake (${g.lamps.length} now, ${rec.lampList.length} baked); ${fix}`);
}

if (problems.length) {
  console.error(`spill-check: ${problems.length} problem(s) in ${checked} lamp-carrying GLB(s)\n- ` + problems.join("\n- "));
  process.exit(1);
}
console.log(`spill-check: ${checked} lamp-carrying GLB(s), all baked and current`);
