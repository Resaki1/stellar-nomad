#!/usr/bin/env node
/**
 * drive-coop.mjs — two headless, muted Chromes (host + guest) over raw CDP, for the co-op gates.
 * Zero npm dependencies. Separate profiles, CDP ports and pidfiles (the same ones
 * `DRIVE_PROFILE=host|guest pnpm drive` uses), so either page can also be poked with drive.mjs.
 *
 *   pnpm drive:coop -- --url http://127.0.0.1:3001/ run:scripts/drive-examples/coop-check.mjs
 *   pnpm drive:coop -- --stop          stop both Chromes
 *
 * Options: --url URL (default http://127.0.0.1:3001/), --size WxH (1280x720), --out DIR
 * (.captures), --keep (leave both Chromes running for the next call), --fresh (wipe both profiles).
 * A run: script's default export gets { host, guest, sleep, out, log }; each page has
 * evaluate, send, load(query), ready(), frames, sleep, press, keyDown, keyUp, shot, canvas.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (typeof WebSocket === "undefined") {
  console.error("drive-coop.mjs needs a global WebSocket: run with `node --experimental-websocket` (Node 20) or Node ≥ 22.");
  process.exit(2);
}

const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ROLES = { host: 9341, guest: 9342 };

const argv = process.argv.slice(2);
const opt = { url: "http://127.0.0.1:3001/", size: "1280x720", out: ".captures", keep: false, stop: false, fresh: false };
const steps = [];
if (argv.includes("--four")) Object.assign(ROLES, { guest2: 9343, guest3: 9344 });
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--" || a === "--four" || a === "--perf") continue;
  if (a === "--keep") opt.keep = true;
  else if (a === "--stop") opt.stop = true;
  else if (a === "--fresh") opt.fresh = true;
  else if (["--url", "--size", "--out"].includes(a)) opt[a.slice(2)] = argv[++i];
  else steps.push(a);
}
const OUT = path.resolve(ROOT, opt.out);
mkdirSync(OUT, { recursive: true });
const [VW, VH] = opt.size.split("x").map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => console.log(JSON.stringify(o));
const profileDir = (role) => path.join(ROOT, ".captures", `.chrome-profile-${role}`);
const pidFile = (role) => path.join(ROOT, ".captures", `.chrome-${role}.pid`);

async function cdpAlive(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
  } catch {
    return false;
  }
}

async function closeOverCdp(port) {
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const s = new WebSocket(webSocketDebuggerUrl);
    await new Promise((res, rej) => ((s.onopen = res), (s.onerror = rej)));
    s.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    await sleep(300);
  } catch {
    /* already gone */
  }
}

/** Stop one role's Chrome: pidfile first, then CDP (an orphan without a pidfile). */
async function stopRole(role) {
  const port = ROLES[role];
  let killed = false;
  if (existsSync(pidFile(role))) {
    try {
      process.kill(Number(readFileSync(pidFile(role), "utf8").split(" ")[0]));
      killed = true;
    } catch {
      /* gone */
    }
    rmSync(pidFile(role), { force: true });
  }
  if (await cdpAlive(port)) {
    await closeOverCdp(port);
    killed = true;
  }
  for (let i = 0; i < 50 && (await cdpAlive(port)); i++) await sleep(100);
  return killed;
}

if (opt.stop) {
  log({ step: "stop", ok: true, host: await stopRole("host"), guest: await stopRole("guest") });
  process.exit(0);
}

const children = [];
async function launch(role) {
  const port = ROLES[role];
  if (await cdpAlive(port)) {
    if (!opt.fresh) return false;
    await stopRole(role);
  }
  if (opt.fresh) rmSync(profileDir(role), { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  const c = spawn(
    CHROME,
    [
      "--headless=new",
      "--enable-unsafe-webgpu",
      "--use-angle=metal",
      ...(argv.includes("--perf") ? [] : ["--disable-gpu-vsync", "--disable-frame-rate-limit"]),
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
      // Two local Chromes must see each other's real host candidates (no mDNS names).
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir(role)}`,
      `--window-size=${VW},${VH}`,
      "about:blank",
    ],
    { stdio: "ignore", detached: opt.keep },
  );
  if (opt.keep) {
    c.unref();
    writeFileSync(pidFile(role), `${c.pid} fast`);
  } else children.push(c);
  for (let i = 0; i < 100 && !(await cdpAlive(port)); i++) await sleep(100);
  if (!(await cdpAlive(port))) throw new Error(`${role} Chrome did not open CDP on :${port}`);
  return true;
}

const SPECIAL = { Enter: [13, "Enter"], Escape: [27, "Escape"] };
function keyParams(key) {
  const sp = SPECIAL[key];
  if (sp) return { key, code: sp[1], windowsVirtualKeyCode: sp[0], text: key === "Enter" ? "\r" : undefined };
  const up = key.toUpperCase();
  return { key, code: /[0-9]/.test(key) ? `Digit${key}` : `Key${up}`, windowsVirtualKeyCode: up.charCodeAt(0), text: key.length === 1 ? key : undefined };
}

/** One page's CDP client and driver API. */
async function attach(role) {
  const port = ROLES[role];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  let target = targets.find((t) => t.type === "page");
  if (!target) target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    } else if (d.method === "Runtime.exceptionThrown") {
      errors.push(d.params.exceptionDetails?.exception?.description?.split("\n")[0] ?? d.params.exceptionDetails?.text);
    } else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") {
      const t = d.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300);
      if (!errors.includes(t)) errors.push(t);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, (d) => (d.error ? reject(new Error(`${role} ${method}: ${d.error.message}`)) : resolve(d.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  async function evaluate(expression, timeoutMs = 300_000) {
    const r = await Promise.race([
      send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
      sleep(timeoutMs).then(() => {
        throw new Error(`${role} eval timed out after ${timeoutMs} ms: ${expression.slice(0, 80)}`);
      }),
    ]);
    if (r.exceptionDetails) throw new Error(`${role}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });

  const outPath = (name) => path.join(OUT, name.endsWith(".png") ? name : `${name}.png`);
  const keyDown = (k) => send("Input.dispatchKeyEvent", { type: "keyDown", ...keyParams(k) });
  const keyUp = (k) => {
    const p = keyParams(k);
    delete p.text;
    return send("Input.dispatchKeyEvent", { type: "keyUp", ...p });
  };
  const page = {
    role,
    errors,
    evaluate,
    send,
    sleep,
    keyDown,
    keyUp,
    async press(k) {
      await keyDown(k);
      await sleep(30);
      await keyUp(k);
    },
    /** Navigate to the dev server with `query` (autostart unless `query.title` / `query.join`). */
    async load(query = {}) {
      const u = new URL(opt.url);
      u.searchParams.set("dpr", "1");
      if (!query.join && !query.title) u.searchParams.set("autostart", "1");
      for (const [k, v] of Object.entries(query)) if (k !== "title") u.searchParams.set(k, String(v));
      await evaluate("window.__driveStale = true", 5000).catch(() => {});
      await send("Page.navigate", { url: u.toString() });
      const t0 = Date.now();
      for (;;) {
        const ok = await evaluate("!window.__driveStale && !!window.__test", 5000).catch(() => false);
        if (ok) break;
        if (Date.now() - t0 > 180_000) throw new Error(`${role}: __test never appeared`);
        await sleep(250);
      }
      return u.toString();
    },
    /** Loading gate open + the usual setup (AI named, audio unlocked; no bench isolation). */
    async ready() {
      await evaluate("__test.ready()");
      await evaluate("__test.nameAi()");
      await evaluate("__test.audio.unlock()");
    },
    frames: (n) => evaluate(`__test.frames(${Number(n)}).then(()=>__test.frameCount)`),
    async shot(name) {
      // At the title only the stub harness exists (no frame loop yet); an open Settings menu stops it.
      await evaluate("typeof __test.frames === 'function' && !document.querySelector('.settings-menu') ? __test.frames(2) : new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
      const r = await send("Page.captureScreenshot", { format: "png" });
      mkdirSync(path.dirname(outPath(name)), { recursive: true });
      writeFileSync(outPath(name), Buffer.from(r.data, "base64"));
      return path.relative(ROOT, outPath(name));
    },
    async canvas(name) {
      const b64 = await evaluate("__test.image.png()");
      mkdirSync(path.dirname(outPath(name)), { recursive: true });
      writeFileSync(outPath(name), Buffer.from(b64, "base64"));
      return path.relative(ROOT, outPath(name));
    },
    close: () => ws.close(),
  };
  return page;
}

let failed = false;
let pages = [];
try {
  await Promise.all(Object.keys(ROLES).map(launch));
  pages = await Promise.all(Object.keys(ROLES).map(attach));
  const [host, guest] = pages;
  for (const s of steps) {
    const t0 = Date.now();
    const [cmd, ...rest] = s.split(":");
    try {
      if (cmd !== "run") throw new Error(`unknown step "${s}" (only run:<file.mjs>)`);
      const mod = await import(pathToFileURL(path.resolve(process.cwd(), rest.join(":"))).href);
      const result = await mod.default({ host, guest, extraGuests: pages.slice(2), sleep, out: OUT, log });
      log({ step: s, ok: true, ms: Date.now() - t0, result });
      if (result && result.pass === false) failed = true;
    } catch (e) {
      failed = true;
      log({ step: s, ok: false, ms: Date.now() - t0, error: String(e.message ?? e).split("\n")[0] });
      break;
    }
  }
  for (const p of pages) if (p.errors.length) log({ role: p.role, consoleErrors: p.errors.slice(0, 20) });
} catch (e) {
  failed = true;
  log({ step: "setup", ok: false, error: String(e.message ?? e).split("\n")[0] });
} finally {
  pages.forEach((p) => p.close());
  if (!opt.keep) {
    children.forEach((c) => c.kill());
    // A Chrome reused from an earlier --keep run is not our child: stop it too.
    await Promise.all(Object.keys(ROLES).map(stopRole));
  }
}
process.exit(failed ? 1 : 0);
