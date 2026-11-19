// Node module hooks: run the headless sim TypeScript under plain Node, zero new deps.
// `@/` → src/, extensionless → .ts/.tsx/index.ts, .json → ES module, .ts → ts.transpileModule.
// Usage: `register(new URL("./lib/ts-hooks.mjs", import.meta.url))` before importing any .ts.
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = resolvePath(ROOT, "src");
const require = createRequire(resolvePath(ROOT, "package.json"));
let ts = null;

const EXTS = [".ts", ".tsx", "/index.ts", "/index.tsx"];
const isFile = (p) => existsSync(p) && statSync(p).isFile();

function probe(base) {
  if (isFile(base)) return base;
  for (const e of EXTS) if (isFile(base + e)) return base + e;
  return null;
}

export async function resolve(specifier, context, next) {
  let base = null;
  if (specifier.startsWith("@/")) base = resolvePath(SRC, specifier.slice(2));
  else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const parent = fileURLToPath(context.parentURL);
    if (/\.tsx?$/.test(parent)) base = resolvePath(dirname(parent), specifier);
  }
  if (base) {
    const hit = probe(base);
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith("file:") && /\.tsx?$/.test(url)) {
    ts ??= require("typescript");
    const file = fileURLToPath(url);
    const src = await readFile(file, "utf8");
    const out = ts.transpileModule(src, {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        isolatedModules: true,
        sourceMap: false,
        inlineSourceMap: true,
      },
    });
    return { format: "module", source: out.outputText, shortCircuit: true };
  }
  if (url.startsWith("file:") && url.endsWith(".json")) {
    const src = await readFile(fileURLToPath(url), "utf8");
    return { format: "module", source: `export default ${src};`, shortCircuit: true };
  }
  return next(url, context);
}
