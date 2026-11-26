#!/usr/bin/env node
// The headless physics sim (`simulatePhysics`, same Rapier WASM as the browser) under plain Node, with the
// starter ship's authored collision proxy. For iterating on physics gates without Chrome.
// Usage: node scripts/physics-node.mjs <scenario.mjs> [args...]
//   The scenario's default export receives { sim, shipParts, args } and returns JSON-able results.
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(new URL("./lib/ts-hooks.mjs", import.meta.url));
const S = (p) => import(new URL(`../src/${p}`, import.meta.url).href);
const [{ simulatePhysics }, { nearField }] = await Promise.all([S("sim/physics/physicsSim.ts"), S("sim/physics/nearField.ts")]);

/** Convex pieces of an untransformed-node GLB (the collision exports), metres, model frame. */
export function glbPieces(path) {
  const b = readFileSync(path);
  const jsonLen = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + jsonLen).toString());
  const binStart = 20 + jsonLen + 8;
  return j.nodes.filter((n) => n.mesh !== undefined).map((n) => {
    if (n.translation || n.rotation || n.scale || n.matrix) throw new Error(`${n.name}: node transforms unsupported`);
    const acc = j.accessors[j.meshes[n.mesh].primitives[0].attributes.POSITION];
    const view = j.bufferViews[acc.bufferView];
    const off = binStart + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = view.byteStride ?? 12;
    const out = new Float32Array(acc.count * 3);
    for (let i = 0; i < acc.count; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = b.readFloatLE(off + i * stride + k * 4);
    return out;
  });
}

const shipParts = glbPieces(new URL("../public/models/ships/starter-survey-collision.glb", import.meta.url));
nearField.setShipShape({ kind: "compoundHull", pieces: shipParts }, "mesh");

const [file, ...args] = process.argv.slice(2);
if (!file) throw new Error("usage: node scripts/physics-node.mjs <scenario.mjs> [args...]");
const scenario = (await import(pathToFileURL(file).href)).default;
console.log(JSON.stringify(await scenario({ sim: simulatePhysics, shipParts, args }), null, 1));
