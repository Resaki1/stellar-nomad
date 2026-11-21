// Offline workshop entry point. All candidate files and verbose logs stay in one run folder.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import validator from "gltf-validator";
import { checkWebGPU } from "./webgpu.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const captures = path.resolve(here, "../../.captures/models");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    collection: { type: "string", default: "EXPORT_LOD0" },
    views: { type: "string", default: "front,side,top,chase" },
    size: { type: "string", default: "256" },
    light: { type: "string", default: "studio" },
    asset: { type: "string" },
    budget: { type: "string" },
    webgpu: { type: "boolean" },
    help: { type: "boolean" },
  },
});
const [command, input] = positionals;
const usage = `pnpm model smoke
pnpm model build <source.blend> [--collection EXPORT_LOD0]
pnpm model review <candidate.glb>
pnpm model check <candidate.glb>
Options: --views front,side,top,chase | all | <comma-separated views>
         --size 256 (pixels per view, 64–2048)   --light studio | sun | clay
         --asset <stable-id>   --budget <limits.json>   --webgpu (local Chrome compatibility check)`;

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

async function inspect(file, out) {
  const bytes = readFileSync(file);
  const result = await validator.validateBytes(bytes, { format: "glb", uri: path.basename(file) });
  writeJson(path.join(out, "validation.json"), result);
  const { issues, info } = result;
  if (issues.numErrors) {
    const first = issues.messages.find((m) => m.severity === 0);
    throw new Error(`${issues.numErrors} glTF errors. ${first?.message ?? ""} See validation.json.`);
  }
  if (info.resources.some((r) => r.storage === "external")) throw new Error("Pack external resources into the GLB.");
  if (!info.totalTriangleCount) throw new Error("Expected renderable triangles.");
  const images = info.resources.filter((r) => r.pointer.startsWith("/images/"));
  const sizes = images.map((r) => [r.image?.width ?? null, r.image?.height ?? null]);
  const metrics = {
    triangles: info.totalTriangleCount, vertices: info.totalVertexCount, primitives: info.drawCallCount,
    materials: info.materialCount, bytes: bytes.length,
    textureEdge: sizes.flat().includes(null) ? null : Math.max(0, ...sizes.flat()),
  };
  const report = { ...metrics, images: images.map((r, i) => ({ type: r.mimeType, size: sizes[i] })),
    requiredExtensions: info.extensionsRequired ?? [], warnings: issues.numWarnings };
  writeJson(path.join(out, "metrics.json"), report);
  console.log(JSON.stringify(report));
  if (values.budget) {
    const limits = JSON.parse(readFileSync(values.budget, "utf8"));
    if (!limits || Array.isArray(limits) || typeof limits !== "object" || !Object.keys(limits).length) {
      throw new Error("Expected an object with metric limits in --budget.");
    }
    for (const [key, limit] of Object.entries(limits)) {
      if (!Object.hasOwn(metrics, key) || !Number.isSafeInteger(limit) || limit < 0) {
        throw new Error(`Invalid budget entry: ${key}=${limit}`);
      }
      if (metrics[key] === null || metrics[key] > limit) {
        throw new Error(`${key}: ${metrics[key] ?? "unknown"} (budget ${limit})`);
      }
    }
  }
  return report;
}

function blender(out, stage, ...args) {
  const mac = [homedir(), ""].map((root) => path.join(root || "/", "Applications/Blender.app/Contents/MacOS/Blender")).find(existsSync);
  const bin = process.env.BLENDER_BIN || (process.platform === "darwin" && mac ? mac : "blender");
  const log = path.join(out, stage + ".log");
  const fd = openSync(log, "w");
  let result;
  try {
    result = spawnSync(bin, ["-b", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1",
      "--python", path.join(here, "blender.py"), "--", stage, ...args], { stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  if (result.error || result.status !== 0) {
    const diagnostic = readFileSync(log, "utf8").split("\n").findLast((line) => /^\w*Error:/.test(line));
    throw new Error(`Blender ${stage}: ${result.error?.message ?? diagnostic ?? result.signal ?? result.status}. See ${log}`);
  }
}

async function main() {
  if (values.help || !command) return console.log(usage);
  if (!["smoke", "build", "review", "check"].includes(command) ||
      positionals.length !== (command === "smoke" ? 1 : 2)) throw new Error(usage);
  const size = Number(values.size);
  if (!Number.isInteger(size) || size < 64 || size > 2048) throw new Error("Use --size 64–2048.");
  if (!["studio", "sun", "clay"].includes(values.light)) throw new Error("Use --light studio, sun or clay.");
  if (values.asset !== undefined && !/^[a-z0-9][a-z0-9_-]*$/i.test(values.asset)) throw new Error("Use a simple asset ID.");
  mkdirSync(captures, { recursive: true });
  const name = input ? path.parse(input).name : "smoke";
  const out = mkdtempSync(path.join(captures, name + "-"));
  console.log(out);
  const source = input ? path.resolve(input) : path.join(out, "smoke.blend");
  if (command === "smoke") blender(out, "fixture", source);
  let glb = source;
  if (command === "build" || command === "smoke") {
    glb = path.join(out, name + ".glb");
    blender(out, "export", source, values.collection, glb);
  }
  const metrics = await inspect(glb, out);
  if (values.webgpu) await checkWebGPU(glb, out);
  if (command === "check") return;
  blender(out, "review", glb, out, String(size), values.views, values.light);
  const qa = JSON.parse(readFileSync(path.join(out, "geometry.json"), "utf8"));
  if (command === "smoke" && (metrics.images.length !== 1 || qa.meshObjects !== 1 ||
      qa.sockets.socket_test?.[2]?.[3] !== -2 || qa.dimensionsMetres.join() !== "2,1,4")) {
    throw new Error("Fixture round trip lost its image, scale, axes, socket or collection isolation.");
  }
  const identity = path.relative(path.resolve(here, "../.."), source);
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  const asset = values.asset ?? (command === "smoke" ? "smoke" : name + "-" + hash);
  const latest = path.join(captures, "latest", asset + ".json");
  mkdirSync(path.dirname(latest), { recursive: true });
  const pending = path.join(out, "latest.tmp");
  writeJson(pending, { run: path.basename(out), sheet: path.relative(captures, path.join(out, "sheet.png")), lighting: values.light });
  renameSync(pending, latest);
  console.log(latest);
  console.log(`GLB bounds (X/Y/Z metres): ${qa.dimensionsMetres.join(" × ")}. Sheet: ${path.join(out, "sheet.png")}`);
}
main().catch((error) => { console.error(error.message ?? error); process.exitCode = 1; });
