#!/usr/bin/env node
/**
 * drive.mjs — drive the running game in HEADLESS Chrome (real Metal WebGPU) over raw
 * CDP. Zero npm dependencies. See docs/AUTOMATED_TESTING.md.
 *
 * Why headless: the in-app browser pane throttles rAF to ~2/s whenever it is hidden,
 * so unattended loops can't rely on it. MEASURED 2026-11-13: headless Chrome gets an
 * apple/metal-3 adapter with timestamp-query and runs the game uncapped (~110 rAF/s).
 *
 *   node --experimental-websocket scripts/drive.mjs [options] <step> <step> …
 *   pnpm drive -- scene:earth_horizon_8 settle canvas:horizon stats
 *
 * Options
 *   --url URL       dev server (default: first of 127.0.0.1:3001/:3002 that answers; :3000 is the owner's)
 *   --size WxH      viewport, CSS px (default 1280x720)
 *   --dpr N         pins render resolution via ?dpr (default 1)
 *   --perf          load with ?perf (per-pass GPU timers)
 *   --keep          leave Chrome running; the next call reuses the loaded page (fast)
 *   --stop          kill a kept Chrome and exit
 *   --fresh         wipe the test profile (localStorage etc.) before launch
 *   --no-isolate    don't enter bench mode (comms + save writes stay live)
 *   --out DIR       capture directory (default .captures)
 *   --title         load the title screen (no ?autostart=1); steps start at the title.
 *                   A run: script starts a world (UI or __test.app.start()) then calls
 *                   `d.enterGame()` to wait for the loading gate and apply the usual setup.
 *   --query K=V     extra URL parameter, repeatable (e.g. nogate=1, nocompile=1)
 *
 * Steps (run in order; each prints one JSON line)
 *   reload                      reload page and wait for __test (picks up code changes)
 *   scene:<id>                  bench scenario id, e.g. scene:earth_650
 *   scene:<body>:<altKm>[:look][:phaseDeg]   ad-hoc, look ∈ body|up|horizon
 *   settle[:maxFrames]          __test.settled()
 *   frames:N | wait:MS
 *   hold:<key>:<ms>             trusted CDP key hold (W/S throttle, A/D strafe, arrows pitch/yaw …)
 *   press:<key>                 tap (Enter, Escape, Tab, m, t, …)
 *   click:<x>:<y>               mouse click at CSS px
 *   hud:on | hud:off
 *   shot:<name>                 full page screenshot incl. HUD → <out>/<name>.png
 *   canvas:<name>               rendered frame only, HUD excluded → <out>/<name>.png
 *   stats[:x0,y0,x1,y1]         __test.image.stats (normalised region)
 *   state                       __test.state()
 *   eval:<js>                   evaluate an expression (awaited), print result
 *   bench:<id>[,<id>…]          __bench.runMany → compact per-pass table (needs --perf)
 *   audio:<name>[:ms][:event]   record master bus (optionally firing an audio event
 *                               id at the start) → <name>.webm + EBU R128 loudness
 *                               + <name>.spectrogram.png
 *   compare:<a>:<b>             SSIM/PSNR of <out>/a.png vs b.png + a__b.diff.png (×4)
 *   run:<file.mjs>              import file, call its default export with the driver API
 */

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (typeof WebSocket === "undefined") {
  console.error("drive.mjs needs a global WebSocket: run with `node --experimental-websocket` (Node 20) or Node ≥ 22.");
  process.exit(2);
}

const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.DRIVE_CDP_PORT ?? 9333);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = { size: "1280x720", dpr: "1", out: ".captures", url: null, perf: false, keep: false, stop: false, fresh: false, isolate: true, title: false, query: [] };
const steps = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--") continue;
  if (a === "--perf") opt.perf = true;
  else if (a === "--keep") opt.keep = true;
  else if (a === "--stop") opt.stop = true;
  else if (a === "--fresh") opt.fresh = true;
  else if (a === "--no-isolate") opt.isolate = false;
  else if (a === "--title") opt.title = true;
  else if (a === "--query") opt.query.push(argv[++i]);
  else if (["--url", "--size", "--dpr", "--out"].includes(a)) opt[a.slice(2)] = argv[++i];
  else steps.push(a);
}
const OUT = path.resolve(ROOT, opt.out);
// DRIVE_PROFILE runs a second, isolated Chrome (co-op: host + guest); pair it with DRIVE_CDP_PORT.
const PROFILE_NAME = process.env.DRIVE_PROFILE ?? "";
const PROFILE = path.join(ROOT, ".captures", PROFILE_NAME ? `.chrome-profile-${PROFILE_NAME}` : ".chrome-profile");
const PIDFILE = path.join(ROOT, ".captures", PROFILE_NAME ? `.chrome-${PROFILE_NAME}.pid` : ".chrome.pid");
mkdirSync(OUT, { recursive: true });
const [VW, VH] = opt.size.split("x").map(Number);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => console.log(JSON.stringify(o));

async function cdpAlive() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return r.ok;
  } catch {
    return false;
  }
}

const MODE = opt.perf ? "perf" : "fast";
function keptMode() {
  return existsSync(PIDFILE) ? readFileSync(PIDFILE, "utf8").split(" ")[1] : null;
}
function killKept() {
  if (!existsSync(PIDFILE)) return false;
  const pid = Number(readFileSync(PIDFILE, "utf8").split(" ")[0]);
  try {
    process.kill(pid);
  } catch {
    /* already gone */
  }
  rmSync(PIDFILE, { force: true });
  return true;
}

if (opt.stop) {
  log({ step: "stop", ok: true, killed: killKept() });
  process.exit(0);
}

async function pickUrl() {
  if (opt.url) return opt.url;
  // 127.0.0.1, not localhost: another app on the owner's Mac answers localhost over IPv6.
  // :3000 is left to the owner; the dev server for testing runs on :3001.
  for (const p of [3001, 3002]) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(20000) });
      if (r.status < 500) return `http://127.0.0.1:${p}/`;
    } catch {
      /* next */
    }
  }
  throw new Error("no dev server on 127.0.0.1:3001/:3002 — start it with `pnpm start -p 3001` or pass --url");
}

// ── Chrome ──────────────────────────────────────────────────────────────────
let chrome = null;
let reused = await cdpAlive();
// Pacing flags differ between modes (see below), so a kept Chrome in the other mode
// must be relaunched rather than reused.
if (reused && keptMode() && keptMode() !== MODE) {
  killKept();
  for (let i = 0; i < 50 && (await cdpAlive()); i++) await sleep(100);
  reused = false;
}
// --fresh must not reuse: a live Chrome keeps the HTTP and GPU shader caches (and may be
// an orphan with no pidfile), so close it over CDP.
if (reused && opt.fresh) {
  killKept();
  await closeBrowserOverCdp();
  for (let i = 0; i < 50 && (await cdpAlive()); i++) await sleep(100);
  reused = false;
}
async function closeBrowserOverCdp() {
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const s = new WebSocket(webSocketDebuggerUrl);
    await new Promise((res, rej) => ((s.onopen = res), (s.onerror = rej)));
    s.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    await sleep(300);
  } catch {
    /* already gone */
  }
}
if (!reused) {
  // Retries: an exiting Chrome still flushes into the profile after its CDP port closes.
  if (opt.fresh) rmSync(PROFILE, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--enable-unsafe-webgpu",
      "--use-angle=metal",
      // Uncapped pacing (~110 rAF/s MEASURED) — but NOT under --perf: submitting faster
      // than the GPU completes overflows three's timestamp query pool ("Maximum number
      // of queries exceeded") and per-pass GPU samples silently stop arriving.
      ...(opt.perf ? [] : ["--disable-gpu-vsync", "--disable-frame-rate-limit"]),
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--autoplay-policy=no-user-gesture-required",
      // Silent speakers: the Web Audio graph and __test.audio.record still run.
      "--mute-audio",
      // Co-op: two local Chromes must see each other's real host candidates (no mDNS names).
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      `--window-size=${VW},${VH}`,
      "about:blank",
    ],
    { stdio: "ignore", detached: opt.keep },
  );
  if (opt.keep) {
    chrome.unref();
    writeFileSync(PIDFILE, `${chrome.pid} ${MODE}`);
  }
  for (let i = 0; i < 100 && !(await cdpAlive()); i++) await sleep(100);
  if (!(await cdpAlive())) throw new Error(`Chrome did not open CDP on :${PORT}`);
}

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
let page = targets.find((t) => t.type === "page");
if (!page) page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const consoleWarnings = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d);
    pending.delete(d.id);
  } else if (d.method === "Runtime.exceptionThrown") {
    consoleErrors.push(d.params.exceptionDetails?.exception?.description?.split("\n")[0] ?? d.params.exceptionDetails?.text);
  } else if (d.method === "Runtime.consoleAPICalled" && (d.params.type === "error" || d.params.type === "warning")) {
    const text = d.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300);
    const bucket = d.params.type === "error" ? consoleErrors : consoleWarnings;
    if (!bucket.includes(text)) bucket.push(text);
  }
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const i = ++msgId;
    pending.set(i, (d) => (d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

/** Evaluate in the page; awaits promises; throws page exceptions. */
async function evaluate(expression, timeoutMs = 600_000) {
  const r = await Promise.race([
    send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
    sleep(timeoutMs).then(() => {
      throw new Error(`eval timed out after ${timeoutMs} ms: ${expression.slice(0, 80)}`);
    }),
  ]);
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result.value;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
// Headless pages have no focus by default; keyboard handlers on window need it.
await send("Emulation.setFocusEmulationEnabled", { enabled: true });

async function load() {
  const base = await pickUrl();
  const u = new URL(base);
  u.searchParams.set("dpr", opt.dpr);
  if (opt.perf) u.searchParams.set("perf", "");
  // Every script but a --title one skips the title screen (it still passes the loading gate).
  if (!opt.title) u.searchParams.set("autostart", "1");
  for (const q of opt.query) {
    const [k, ...v] = q.split("=");
    u.searchParams.set(k, v.join("="));
  }
  // Mark the outgoing document: Page.navigate returns before it is replaced, and
  // the old page's __test would otherwise satisfy waitHarness (seen: steps ran on it).
  await evaluate("window.__driveStale = true", 5000).catch(() => {});
  await send("Page.navigate", { url: u.toString() });
  await waitHarness();
  return u.toString();
}

async function waitHarness() {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = await evaluate("!window.__driveStale && !!window.__test", 5000);
    } catch {
      /* navigating */
    }
    if (ok) break;
    if (Date.now() - t0 > 180_000) throw new Error("__test never appeared (is this a dev build?)");
    await sleep(250);
  }
  if (opt.title) {
    await evaluate(`new Promise((res, rej) => { const t0 = performance.now(); const f = () => __test.app.phase() === "title" && document.querySelector(".shell-menu__item") ? res(true) : performance.now() - t0 > 60000 ? rej(new Error("title never became interactive")) : setTimeout(f, 50); f(); })`);
    return;
  }
  await enterGame();
}

/** Wait for the loading gate to open, then the standard setup (AI named, isolation, audio). */
async function enterGame() {
  await evaluate("__test.ready()");
  // Not a localStorage seed: "ai-name-v1" is a legacy key the save would re-import.
  await evaluate("__test.nameAi()");
  if (opt.isolate) await evaluate("__test.isolate(true)");
  await evaluate("__test.audio.unlock()");
}

// Load unless we're reusing a kept page that already has the harness.
let currentUrl = page.url;
const hasHarness = reused ? await evaluate("!!window.__test?.settled", 5000).catch(() => false) : false;
const perfMatches = reused ? currentUrl.includes("perf") === opt.perf : true;
const queryMatches = opt.query.every((q) => currentUrl.includes(q));
if (opt.title || !hasHarness || !perfMatches || !queryMatches) {
  const t0 = Date.now();
  currentUrl = await load();
  log({ step: "load", ok: true, url: currentUrl, ms: Date.now() - t0, reusedChrome: reused });
} else {
  if (opt.isolate) await evaluate("__test.isolate(true)");
  log({ step: "attach", ok: true, url: currentUrl });
}

// ── keys ────────────────────────────────────────────────────────────────────
const SPECIAL = {
  Enter: [13, "Enter"], Escape: [27, "Escape"], Tab: [9, "Tab"], Shift: [16, "ShiftLeft"],
  Control: [17, "ControlLeft"], Alt: [18, "AltLeft"], " ": [32, "Space"], Space: [32, "Space"],
  ArrowUp: [38, "ArrowUp"], ArrowDown: [40, "ArrowDown"], ArrowLeft: [37, "ArrowLeft"], ArrowRight: [39, "ArrowRight"],
};
function keyParams(key) {
  if (key === "Space") key = " ";
  const sp = SPECIAL[key];
  // Enter needs its text ("\r") or Chrome does not activate buttons / submit forms.
  if (sp) return { key, code: sp[1], windowsVirtualKeyCode: sp[0], text: key === "Enter" ? "\r" : undefined };
  const up = key.toUpperCase();
  const code = /[0-9]/.test(key) ? `Digit${key}` : `Key${up}`;
  return { key, code, windowsVirtualKeyCode: up.charCodeAt(0), text: key.length === 1 ? key : undefined };
}
async function keyDown(key) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...keyParams(key) });
}
async function keyUp(key) {
  const p = keyParams(key);
  delete p.text; // keyUp must not insert text
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...p });
}

function ffmpeg(args) {
  try {
    return execFileSync("ffmpeg", ["-hide_banner", "-nostats", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // ffmpeg writes filter reports to stderr and may exit 0 or not; return stderr either way.
    return String(e.stderr ?? e.message);
  }
}
/** ffmpeg filter reports (ssim, psnr, ebur128) go to stderr. */
function spawnSyncStderr(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", ...args], { encoding: "utf8" });
  return (r.stderr ?? "") + (r.stdout ?? "");
}

const outPath = (name, ext) => path.join(OUT, name.endsWith(ext) ? name : `${name}${ext}`);
const rel = (p) => path.relative(ROOT, p);

// ── driver API (also handed to run:<file>) ──────────────────────────────────
const api = {
  evaluate,
  send,
  async reload() {
    return load();
  },
  enterGame,
  /** Type text into the focused element (trusted input). */
  async type(text) {
    await send("Input.insertText", { text });
  },
  async scene(arg) {
    const parts = arg.split(":");
    if (parts.length === 1) return evaluate(`__test.scene(${JSON.stringify(parts[0])})`);
    const [body, alt, look, phase] = parts;
    const spec = { body, altKm: Number(alt), look: look || "body" };
    if (phase) spec.phaseDeg = Number(phase);
    return evaluate(`__test.scene(${JSON.stringify(spec)})`);
  },
  settle(maxFrames) {
    return evaluate(`__test.settled(${maxFrames ? JSON.stringify({ maxFrames: Number(maxFrames) }) : ""})`);
  },
  frames(n) {
    return evaluate(`__test.frames(${Number(n)}).then(()=>__test.frameCount)`);
  },
  async hold(key, ms) {
    await keyDown(key);
    await sleep(Number(ms));
    await keyUp(key);
  },
  async press(key) {
    await keyDown(key);
    await sleep(30);
    await keyUp(key);
  },
  async click(x, y) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: Number(x), y: Number(y), button: "left", clickCount: 1 });
    }
  },
  hud(on) {
    return evaluate(`__test.hud(${on ? "true" : "false"})`);
  },
  async shot(name) {
    await evaluate("__test.frames ? __test.frames(2) : new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    const r = await send("Page.captureScreenshot", { format: "png" });
    const p = outPath(name, ".png");
    writeFileSync(p, Buffer.from(r.data, "base64"));
    return rel(p);
  },
  async canvas(name) {
    const b64 = await evaluate("__test.image.png()");
    const p = outPath(name, ".png");
    writeFileSync(p, Buffer.from(b64, "base64"));
    return rel(p);
  },
  stats(region) {
    if (!region) return evaluate("__test.image.stats()");
    const [x0, y0, x1, y1] = region.split(",").map(Number);
    return evaluate(`__test.image.stats(${JSON.stringify({ x0, y0, x1, y1 })})`);
  },
  state() {
    return evaluate("__test.state()");
  },
  async bench(ids) {
    const list = ids.split(",");
    await evaluate(`__bench.runMany(${JSON.stringify(list)})`);
    const report = JSON.parse(await evaluate("__bench.lastJson"));
    return report.results.map((r) => ({
      scenario: r.scenario,
      settled: r.settled,
      frameP50: +r.frameMs.p50.toFixed(2),
      gpuP50: +r.gpuTotalMs.p50.toFixed(2),
      passes: Object.fromEntries(r.passes.filter((p) => p.meanMs > 0.05).map((p) => [p.label, +p.meanMs.toFixed(2)])),
    }));
  },
  async audio(name, ms = 2000, event) {
    const r = await evaluate(`__test.audio.record(${Number(ms)}, true${event ? `, ${JSON.stringify(event)}` : ""})`);
    const p = outPath(name, r.mime.includes("mp4") ? ".mp4" : ".webm");
    writeFileSync(p, Buffer.from(r.base64, "base64"));
    delete r.base64;
    const spec = outPath(`${name}.spectrogram`, ".png");
    ffmpeg(["-y", "-i", p, "-lavfi", "showspectrumpic=s=1024x512:legend=1:scale=log:fscale=log", spec]);
    const ebu = spawnSyncStderr(["-i", p, "-af", "ebur128=peak=true", "-f", "null", "-"]);
    const sum = ebu.slice(ebu.lastIndexOf("Summary:"));
    const num = (re) => {
      const m = sum.match(re);
      return m ? Number(m[1]) : null;
    };
    return {
      ...r,
      file: rel(p),
      spectrogram: rel(spec),
      lufsIntegrated: num(/I:\s+(-?[\d.]+) LUFS/),
      loudnessRangeLU: num(/LRA:\s+(-?[\d.]+) LU/),
      truePeakDbfs: num(/Peak:\s+(-?[\d.]+) dBFS/),
    };
  },
  compare(a, b) {
    const pa = outPath(a, ".png");
    const pb = outPath(b, ".png");
    const ssimOut = spawnSyncStderr(["-i", pa, "-i", pb, "-lavfi", "ssim;[0:v][1:v]psnr", "-f", "null", "-"]);
    const ssim = ssimOut.match(/SSIM .*All:([\d.]+)/);
    const psnr = ssimOut.match(/PSNR .*average:([\d.inf]+)/);
    const diff = outPath(`${path.basename(a, ".png")}__${path.basename(b, ".png")}.diff`, ".png");
    ffmpeg(["-y", "-i", pa, "-i", pb, "-filter_complex", "[0:v]format=rgb24[a];[1:v]format=rgb24[b];[a][b]blend=all_mode=difference,lutrgb=r='min(val*4,255)':g='min(val*4,255)':b='min(val*4,255)'", "-frames:v", "1", diff]);
    return {
      ssim: ssim ? Number(ssim[1]) : null,
      psnrDb: psnr ? (psnr[1] === "inf" ? Infinity : Number(psnr[1])) : null,
      diff: rel(diff),
    };
  },
  sleep,
  out: OUT,
};

async function runStep(s) {
  const [cmd, ...rest] = s.split(":");
  const arg = rest.join(":");
  switch (cmd) {
    case "reload": return api.reload();
    case "scene": return api.scene(arg);
    case "settle": return api.settle(arg);
    case "frames": return api.frames(arg);
    case "wait": return sleep(Number(arg)).then(() => Number(arg));
    case "hold": return api.hold(rest[0], rest[1]);
    case "press": return api.press(arg);
    case "click": return api.click(rest[0], rest[1]);
    case "hud": return api.hud(arg !== "off");
    case "shot": return api.shot(arg || `shot_${Date.now()}`);
    case "canvas": return api.canvas(arg || `canvas_${Date.now()}`);
    case "stats": return api.stats(arg);
    case "state": return api.state();
    case "eval": return evaluate(arg);
    case "bench": return api.bench(arg);
    case "audio": return api.audio(rest[0], rest[1], rest[2]);
    case "compare": return api.compare(rest[0], rest[1]);
    case "run": {
      const mod = await import(pathToFileURL(path.resolve(process.cwd(), arg)).href);
      return mod.default(api);
    }
    default:
      throw new Error(`unknown step "${s}"`);
  }
}

let failed = false;
for (const s of steps) {
  const t0 = Date.now();
  try {
    const result = await runStep(s);
    log({ step: s, ok: true, ms: Date.now() - t0, result });
  } catch (e) {
    failed = true;
    log({ step: s, ok: false, ms: Date.now() - t0, error: String(e.message ?? e).split("\n")[0] });
    break;
  }
}
if (consoleErrors.length) log({ consoleErrors: consoleErrors.slice(0, 20) });
if (consoleWarnings.length) log({ consoleWarnings: consoleWarnings.slice(0, 20) });

ws.close();
if (!opt.keep && chrome) chrome.kill();
process.exit(failed ? 1 : 0);
