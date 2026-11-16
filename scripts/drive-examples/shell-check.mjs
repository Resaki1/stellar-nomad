/**
 * M0.4 title screen + loading gate exit gates (ROADMAP M0.4) for scripts/drive.mjs.
 * Starts at the title, so run with --title; split parts to stay under ~2 min per run:
 *
 *   SHELL_PARTS=title,newworld pnpm drive -- --title run:scripts/drive-examples/shell-check.mjs
 *   SHELL_PARTS=continue,list   pnpm drive -- --title run:…
 *   SHELL_PARTS=exit            pnpm drive -- --title --no-isolate run:…
 *   SHELL_PARTS=frames          pnpm drive -- --fresh [--query nogate=1] run:…   (cold cache)
 *   SHELL_PARTS=shots,keys      pnpm drive -- --title [--size 390x844] run:…
 *
 * Parts: title (a), newworld (b), continue (c), frames (d), list (e), exit (f), shots + keys (g).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

const IDB = `(async () => {
  const db = await new Promise((res, rej) => { const q = indexedDB.open("stellar-nomad"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const has = (s) => db.objectStoreNames.contains(s);
  const all = (s) => has(s) ? new Promise((res) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); }) : [];
  const keys = (s) => has(s) ? new Promise((res) => { const q = db.transaction(s).objectStore(s).getAllKeys(); q.onsuccess = () => res(q.result); }) : [];
  const out = { meta: await all("worldMeta"), dataKeys: await keys("worldData"), data: await all("worldData") };
  db.close();
  return out;
})()`;

const PROBE = `(() => {
  window.__probe = { audioCtx: 0, gpuAdapter: 0, gpuDevice: 0 };
  const AC = window.AudioContext;
  if (AC) window.AudioContext = class extends AC { constructor(...a) { super(...a); window.__probe.audioCtx++; } };
  const gpu = navigator.gpu;
  if (gpu) {
    const ra = gpu.requestAdapter.bind(gpu);
    gpu.requestAdapter = async (...a) => {
      window.__probe.gpuAdapter++;
      const ad = await ra(...a);
      if (ad) { const rd = ad.requestDevice.bind(ad); ad.requestDevice = async (...b) => { window.__probe.gpuDevice++; return rd(...b); }; }
      return ad;
    };
  }
})()`;

const HEAVY = /\.(ktx2|glb|gltf|bin|opus|webm|ogg|mp3|wasm)(\?|$)|basis|transcoder/i;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export default async function shellCheck(d) {
  const ev = (js, t) => d.evaluate(js, t);
  const wait = (ms) => d.sleep(ms);
  const parts = (process.env.SHELL_PARTS ?? "title,newworld,continue,list").split(",");
  const out = {};
  const narrow = (await ev("innerWidth")) < 600;
  const shotName = (n) => (narrow ? `${n}-narrow` : n);
  /** Panels fade in over $dur-slow (400 ms): let it finish before capturing. */
  const shot = async (n) => {
    await wait(600);
    return d.shot(shotName(n));
  };
  const base = new URL(await ev("location.href"));
  const log = (...a) => console.log("[shell-check]", ...a);

  /** Navigate with the given extra params and wait for the title (or the harness when autostarting). */
  const go = async (params = {}) => {
    const u = new URL(base.origin + "/");
    u.searchParams.set("dpr", base.searchParams.get("dpr") ?? "1");
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    await ev("window.__driveStale = true", 5000).catch(() => {});
    await d.send("Page.navigate", { url: u.toString() });
    for (let i = 0; i < 600; i++) {
      await wait(100);
      const ok = await ev(
        `!window.__driveStale && !!window.__test?.app && (__test.app.phase() !== "title" || !!document.querySelector(".shell-menu__item"))`,
        3000,
      ).catch(() => false);
      if (ok) return;
    }
    throw new Error("page never reached the title");
  };
  const title = () => go({});
  const click = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error("no ${sel.replace(/"/g, "'")}"); e.click(); return true; })()`);
  const clickText = (sel, text) =>
    ev(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.includes(${JSON.stringify(text)})); if (!e) throw new Error("no ${sel} with ${text}"); e.click(); return true; })()`);
  const menu = () => ev(`[...document.querySelectorAll(".shell-menu__item")].map((b) => ({ text: b.querySelector(".shell-menu__label").textContent, primary: b.classList.contains("shell-menu__item--primary") }))`);
  const active = () => ev(`(() => { const a = document.activeElement; return a ? (a.getAttribute("aria-label") || a.textContent || a.tagName).trim().slice(0, 40) + "|" + a.tagName : null; })()`);
  const waitFor = async (js, ms = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await ev(js).catch(() => false)) return true;
      await wait(50);
    }
    throw new Error(`timed out waiting for ${js.slice(0, 80)}`);
  };
  const playing = async () => {
    await waitFor(`!!window.__test?.settled`, 60000);
    await d.enterGame();
  };

  if (parts.includes("title")) {
    const { identifier } = await d.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
    await title(); // warms the HTTP cache
    await title();
    const atTitle = await ev(`({
      timings: __test.app.timings(),
      nav: (() => { const n = performance.getEntriesByType("navigation")[0]; return { domInteractive: Math.round(n.domInteractive), loadEvent: Math.round(n.loadEventEnd) }; })(),
      probe: window.__probe,
      resources: performance.getEntriesByType("resource").map((r) => r.name.replace(location.origin, "")),
    })`);
    await wait(3000); // idle at the title: nothing more may load
    const idle = await ev(`({ probe: window.__probe, resources: performance.getEntriesByType("resource").map((r) => r.name.replace(location.origin, "")),
      big: performance.getEntriesByType("resource").filter((r) => r.decodedBodySize > 2e6).map((r) => ({ url: r.name.replace(location.origin, ""), bytes: r.decodedBodySize })) })`);
    // The title may load its own audio (UI sounds, the title theme) and nothing else heavy.
    const heavy = idle.resources.filter((r) => HEAVY.test(r) && !r.startsWith("/audio/"));
    const threeAfterIdle = idle.resources.filter((r) => /three/.test(r));
    // M2: the physics engine (Rapier, ~4.6 MB of inlined wasm) loads with the game chunk only.
    const physicsAfterIdle = idle.resources.filter((r) => /rapier|dimforge|sim_physics/i.test(r));
    // Name-independent backstop: no >2 MB non-audio body at the title (Rapier's chunk is ~4.6 MB).
    const bigAfterIdle = idle.big.filter((r) => !r.url.startsWith("/audio/"));
    // The driver's Chrome allows autoplay, so "silent before a gesture" cannot be tested here.
    const musicBefore = await ev(`__test.titleMusic().playing`);
    await d.press("ArrowDown");
    await wait(1500);
    const musicAfter = await ev(`__test.titleMusic().playing`);
    const js = idle.resources.filter((r) => r.endsWith(".js"));
    const threeAtInteractive = atTitle.resources.filter((r) => /three/.test(r));
    await d.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    out.title = {
      titleInteractiveMs: atTitle.timings.titleInteractiveMs,
      nav: atTitle.nav,
      resourcesAtInteractive: atTitle.resources.length,
      threeChunksAtInteractive: threeAtInteractive.length,
      jsAfterIdle: js.length,
      heavy,
      probe: idle.probe,
      threeChunksAfterIdle: threeAfterIdle.length,
      physicsChunksAfterIdle: physicsAfterIdle,
      bigAfterIdle,
      titleMusic: { beforeGesture: musicBefore, afterKey: musicAfter },
      pass:
        heavy.length === 0 && threeAtInteractive.length === 0 && threeAfterIdle.length === 0 && physicsAfterIdle.length === 0 && bigAfterIdle.length === 0 &&
        idle.probe.audioCtx <= 1 && idle.probe.gpuAdapter === 0 && idle.probe.gpuDevice === 0 &&
        musicAfter?.id === "glacial_pads" && musicAfter.paused === false,
    };
    log("title", JSON.stringify(out.title));
  }

  if (parts.includes("newworld")) {
    await title();
    await ev(`new Promise(r => { const q = indexedDB.deleteDatabase("stellar-nomad"); q.onsuccess = q.onerror = q.onblocked = () => r(); })`);
    await ev(`localStorage.removeItem("last-world-id")`);
    await title();
    const m = await menu();
    await clickText(".shell-menu__item", "New world");
    await waitFor(`!!document.querySelector("#shell-new-world")`);
    // Name field is focused and selected: typing replaces it.
    await d.type("Kepler Drift");
    await ev(`(() => { const s = document.querySelector("#shell-seed"); s.focus(); s.select(); })()`);
    await d.type("424242");
    await click(`input[name="difficulty"][value="hard"]`);
    await shot("shell-newworld");
    await click(`button[form="shell-new-world"]`);
    await playing();
    const db = await ev(IDB);
    const info = await ev("__test.save.info()");
    const w = db.meta.find((x) => x.id === info.id);
    out.newworld = {
      menuBefore: m,
      world: w && { name: w.name, seed: w.seed, difficulty: w.difficulty },
      worldsInDb: db.meta.length,
      pass: !m.some((x) => x.text === "Continue") && m[0].text === "New world" && m[0].primary &&
        db.meta.length === 1 && w?.name === "Kepler Drift" && w?.seed === 424242 && w?.difficulty === "hard" && db.dataKeys.includes(info.id),
    };
    log("newworld", JSON.stringify(out.newworld));
  }

  if (parts.includes("continue")) {
    await title();
    const clickedAt = await ev("performance.now()");
    await clickText(".shell-menu__item", "Continue");
    const samples = [];
    let shotTaken = false;
    for (let i = 0; i < 400; i++) {
      const s = await ev(`(() => {
        const ph = __test.app.phase();
        const st = typeof __test.state === "function" && __test.frameCount > 0 ? __test.state() : null;
        return { ph, stage: __test.app.progress().stage, rel: st && st.ship.relPosKm, frameId: st && st.ship.frameId, epoch: st && st.simEpochMs, steps: st && st.ship.steps, frames: st && st.frames };
      })()`);
      if (s.ph !== "loading") break;
      if (s.rel && s.frameId) samples.push(s); // frameId "" = the ship has not published yet
      if (!shotTaken && s.stage === "assets" && s.frames > 5) {
        shotTaken = true;
        await shot("shell-loading");
      }
      await wait(150);
    }
    await playing();
    const at0 = await d.state();
    // M2: when the physics engine starts/finishes loading relative to the click (ms).
    const phys = await ev(`(() => { const l = __phys.stats().load; return { state: l.state, startMs: Math.round(l.startedAtMs - ${clickedAt}), readyMs: Math.round(l.startedAtMs + l.loadMs - ${clickedAt}),
      chunks: performance.getEntriesByType("resource").filter((e) => /dimforge|rapierBackend/.test(e.name)).map((e) => ({ url: e.name.split("/").pop(), bytes: e.decodedBodySize, transfer: e.transferSize, startMs: Math.round(e.startTime - ${clickedAt}), endMs: Math.round(e.responseEnd - ${clickedAt}) })) }; })()`);
    await wait(3000);
    const at3 = await d.state();
    const distinct = (k) => new Set(samples.map((s) => JSON.stringify(s[k]))).size;
    out.continue = {
      physicsLoad: phys,
      loadingSamples: samples.length,
      distinctRelPos: distinct("rel"),
      relValues: [...new Set(samples.map((s) => JSON.stringify([s.rel, s.frameId, s.frames])))].slice(0, 4),
      distinctEpoch: distinct("epoch"),
      distinctSteps: distinct("steps"),
      framesDuringLoading: samples.length ? [samples[0].frames, samples[samples.length - 1].frames] : null,
      afterGate: { throttle: at0.throttle, speedMps: at0.speedMps },
      after3s: { throttle: at3.throttle, speedMps: at3.speedMps, movedKm: Math.hypot(...at3.ship.relPosKm.map((v, i) => v - at0.ship.relPosKm[i])) },
      timings: await ev("__test.app.timings()"),
    };
    out.continue.pass = samples.length >= 3 && out.continue.distinctRelPos === 1 && out.continue.distinctEpoch === 1 &&
      at0.throttle === 0 && at0.speedMps === 0 && at3.speedMps === 0 && out.continue.after3s.movedKm < 1e-6;
    log("continue", JSON.stringify(out.continue));
  }

  if (parts.includes("frames")) {
    // Already loaded by the driver (autostart): wait for the 10 s window after the gate.
    await waitFor("!!__test.app.timings().afterGate", 30000);
    out.frames = { url: await ev("location.search"), timings: await ev("__test.app.timings()") };
    log("frames", JSON.stringify(out.frames));
  }

  if (parts.includes("list")) {
    await title();
    let db = await ev(IDB);
    if (db.meta.length < 2) {
      await clickText(".shell-menu__item", "New world");
      await waitFor(`!!document.querySelector("#shell-new-world")`);
      await d.type("Second Light");
      await click(`button[form="shell-new-world"]`);
      await playing();
      await ev("__test.save.flush()");
      await title();
      db = await ev(IDB);
    }
    await clickText(".shell-menu__item", "Load world");
    await waitFor(`!!document.querySelector(".shell-world")`);
    const rows = await ev(`[...document.querySelectorAll(".shell-world")].map((r) => ({ name: r.querySelector(".shell-world__name").textContent, meta: r.querySelector(".shell-world__meta").textContent }))`);
    const metaSorted = [...db.meta].sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
    const DIFF = { explorer: "Explorer", standard: "Standard", hard: "Hard" };
    const rowsMatch = rows.length === metaSorted.length && rows.every((r, i) => r.name === metaSorted[i].name && r.meta.includes(DIFF[metaSorted[i].difficulty]));
    await shot("shell-load");
    // Play the second row.
    const secondId = metaSorted[1].id;
    await ev(`document.querySelectorAll(".shell-world [data-nav]")[1].click()`);
    await playing();
    const playedId = (await ev("__test.save.info()")).id;
    // Export (intercept the download blob) then import through the file input.
    await title();
    await ev(`(() => { const o = URL.createObjectURL; URL.createObjectURL = (b) => { window.__blob = b; return o.call(URL, b); }; })()`);
    await clickText(".shell-menu__item", "Load world");
    await waitFor(`!!document.querySelector(".shell-world")`);
    const exportedName = await ev(`document.querySelectorAll(".shell-world")[0].querySelector(".shell-world__name").textContent`);
    const exportedId = (await ev(IDB)).meta.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)[0].id;
    await ev(`[...document.querySelectorAll(".shell-world")[0].querySelectorAll("button")].find((b) => b.textContent === "Export").click()`);
    await waitFor("!!window.__blob");
    const json = await ev("window.__blob.text()");
    const file = path.join(d.out, "shell-export.json");
    writeFileSync(file, json);
    await d.press("Escape");
    const before = await ev(IDB);
    const { root } = await d.send("DOM.getDocument", {});
    const { nodeId } = await d.send("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[type="file"]' });
    await d.send("DOM.setFileInputFiles", { nodeId, files: [file] });
    await waitFor(`/Imported/.test(document.querySelector(".shell-title__status").textContent)`);
    const after = await ev(IDB);
    const newMeta = after.meta.find((m) => !before.meta.some((b) => b.id === m.id));
    const orig = before.data[before.dataKeys.indexOf(exportedId)];
    const copy = newMeta && after.data[after.dataKeys.indexOf(newMeta.id)];
    const origMeta = before.meta.find((m) => m.id === exportedId);
    const strip = (m) => ({ ...m, id: null });
    // Delete the imported copy through the confirmation dialog.
    await clickText(".shell-menu__item", "Load world");
    await waitFor(`!!document.querySelector(".shell-world")`);
    await click(`[data-delete="${newMeta.id}"]`);
    await waitFor(`!!document.querySelector(".shell-confirm")`);
    const dialog = await ev(`document.querySelector(".shell-confirm").textContent`);
    const focusInDialog = await active();
    await shot("shell-delete-confirm");
    await clickText(".panel__action--danger", "Delete");
    await waitFor(`!document.querySelector(".shell-confirm")`);
    await wait(300);
    const afterDelete = await ev(IDB);
    out.list = {
      rows,
      rowsMatch,
      played: { expected: secondId, got: playedId },
      exported: exportedName,
      imported: newMeta && { name: newMeta.name, idDiffers: newMeta.id !== exportedId },
      dataIdentical: eq(copy, orig),
      metaIdentical: newMeta ? eq({ ...strip(newMeta), schemaVersion: 0 }, { ...strip(origMeta), schemaVersion: 0 }) : false,
      worlds: [before.meta.length, after.meta.length, afterDelete.meta.length],
      dialog,
      focusInDialog,
      deletedGone: !afterDelete.meta.some((m) => m.id === newMeta.id) && !afterDelete.dataKeys.includes(newMeta.id),
    };
    out.list.pass = rowsMatch && playedId === secondId && out.list.dataIdentical && after.meta.length === before.meta.length + 1 &&
      out.list.deletedGone && afterDelete.meta.length === before.meta.length;
    log("list", JSON.stringify(out.list));
  }

  if (parts.includes("exit")) {
    await title();
    await clickText(".shell-menu__item", "Continue");
    await playing();
    log("exit: playing");
    await d.scene("luna:500");
    await d.frames(30);
    await ev(`__dev.grantCargo("fe_ni_metal", 55)`);
    await d.frames(10);
    const s0 = await d.state();
    const cargo0 = (await ev("__test.save.data()")).players[await ev("localStorage.getItem('player-id-v1')")].cargo.items;
    const id0 = (await ev("__test.save.info()")).id;
    log("exit: state before", JSON.stringify({ frame: s0.ship.frameId, cargo0 }));
    await click(".settings__open-button");
    await waitFor(`!!document.querySelector(".settings-menu__button--exit")`);
    await click(".settings-menu__button--exit");
    for (let i = 0; i < 200; i++) {
      await wait(100);
      const at = await ev(`!!window.__test?.app && __test.app.phase() === "title" && !!document.querySelector(".shell-menu__item")`, 3000).catch(() => false);
      if (at) break;
    }
    const url = await ev("location.search");
    log("exit: at title", url);
    await clickText(".shell-menu__item", "Continue");
    await playing();
    const s1 = await d.state();
    const cargo1 = (await ev("__test.save.data()")).players[await ev("localStorage.getItem('player-id-v1')")].cargo.items;
    const id1 = (await ev("__test.save.info()")).id;
    out.exit = {
      titleUrl: url,
      sameWorld: id0 === id1,
      frame: [s0.ship.frameId, s1.ship.frameId],
      posDeltaM: +(Math.hypot(...s1.ship.relPosKm.map((v, i) => v - s0.ship.relPosKm[i])) * 1000).toFixed(3),
      cargo: [cargo0.fe_ni_metal ?? 0, cargo1.fe_ni_metal ?? 0],
    };
    out.exit.pass = id0 === id1 && s0.ship.frameId === s1.ship.frameId && out.exit.posDeltaM < 1 && eq(cargo0, cargo1) && (cargo0.fe_ni_metal ?? 0) >= 55;
    log("exit", JSON.stringify(out.exit));
  }

  if (parts.includes("shots")) {
    await title();
    await shot("shell-title");
    await clickText(".shell-menu__item", "New world");
    await waitFor(`!!document.querySelector("#shell-new-world")`);
    await shot("shell-newworld");
    await d.press("Escape");
    await clickText(".shell-menu__item", "Load world");
    await waitFor(`!!document.querySelector(".shell-world")`);
    await shot("shell-load");
    await ev(`document.querySelector("[data-delete]").click()`);
    await waitFor(`!!document.querySelector(".shell-confirm")`);
    await shot("shell-delete-confirm");
    await clickText(".panel__action--secondary", "Cancel");
    await d.press("Escape");
    await clickText(".shell-menu__item", "Settings");
    await waitFor(`!!document.querySelector(".settings-menu__nav")`);
    await shot("shell-settings");
    await d.press("Escape");
    await clickText(".shell-menu__item", "Continue");
    for (let i = 0; i < 200; i++) {
      const s = await ev(`({ ph: __test.app.phase(), stage: __test.app.progress().stage, loaded: __test.app.progress().assets.loaded })`);
      if (s.ph === "loading" && s.stage === "assets" && s.loaded > 5) break;
      await wait(100);
    }
    await shot("shell-loading");
    await playing();
    out.shots = { pass: true };
  }

  if (parts.includes("keys")) {
    await title();
    const trail = [];
    const step = async (key, note) => {
      await d.press(key);
      await wait(120);
      trail.push(`${note ?? key} → ${await active()}`);
    };
    trail.push(`start → ${await active()}`);
    await step("ArrowDown");
    await step("ArrowDown");
    await step("ArrowUp");
    await step("Enter", "Enter (New world)");
    await d.type("Keyboard Run");
    await step("Escape");
    const escBack = !(await ev(`!!document.querySelector("#shell-new-world")`));
    await step("ArrowDown", "ArrowDown (Load)");
    await step("Enter", "Enter (Load world)");
    await step("ArrowDown");
    await step("Escape");
    await step("ArrowUp", "ArrowUp (New world)");
    await step("Enter", "Enter (New world)");
    await d.type("Keyboard Run");
    await step("Tab");
    await d.type("777");
    await step("Tab");
    await step("Tab");
    await step("ArrowDown", "ArrowDown (difficulty)");
    const diff = await ev(`document.querySelector('input[name="difficulty"]:checked').value`);
    for (let i = 0; i < 8; i++) {
      if ((await active())?.startsWith("Launch")) break;
      await step("Tab");
    }
    await step("Enter", "Enter (Launch)");
    await playing();
    const info = await ev("__test.save.info()");
    const w = (await ev(IDB)).meta.find((m) => m.id === info.id);
    out.keys = { trail, escBack, difficultyByArrow: diff, world: w && { name: w.name, seed: w.seed, difficulty: w.difficulty } };
    out.keys.pass = escBack && w?.name === "Keyboard Run" && w?.difficulty === diff && diff !== "standard";
    log("keys", JSON.stringify(out.keys));
  }

  return out;
}
