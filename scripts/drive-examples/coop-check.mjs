/**
 * M4.0 exit gate in two real browsers (docs/M4_COOP_PLAN.md §1). Run with drive-coop.mjs:
 *   COOP_PARTS=settingsSpawn,presence,jitter,race,raceRev,dropReply,restart,lunar,joinCard,reloadPose,lateName,remoteFx,crash,pilotMarker,rename,pilotActions,joinLifecycle,writeGate,exportHidden,cancelJoin,handoff,hostFail,leave \
 *     pnpm drive:coop -- --url http://127.0.0.1:3001/ run:scripts/drive-examples/coop-check.mjs
 * The host opens a fresh disposable `[gc] coop` world to friends; the guest joins through the join
 * card (invite link, Join button). cancelJoin, handoff, hostFail and leave change the session: keep them last. Mining
 * goes through the mining UI (aim, focus, the [M] key into MiningSystem). Each part prints one
 * pass/fail JSON line: grants per player, depletions, host-worker record vs mirror cargo,
 * revision, timings. Captures land in .captures/coop/. The world is deleted afterwards.
 */
const J = JSON.stringify;
const R = "__test.gameplay.res";
const C = "__test.coop";
const OFFSET_MS = Number(process.env.COOP_RACE_OFFSET_MS ?? 300);
// The loser's incoming messages are held this long (a latency spike), so its claim still reaches
// the host after the winner's commit instead of its beam being cut by the vanishing rock.
const HOLD_MS = Number(process.env.COOP_RACE_HOLD_MS ?? 2000);

const ref = (r) => ({ fieldId: r.fieldId, chunkKey: r.chunkKey, instanceId: r.instanceId });
const sameItems = (a, b) => {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) if ((a?.[k] ?? 0) !== (b?.[k] ?? 0)) return false;
  return true;
};
const delta = (after, before) => {
  const out = {};
  for (const k of new Set([...Object.keys(after ?? {}), ...Object.keys(before ?? {})])) {
    const d = (after?.[k] ?? 0) - (before?.[k] ?? 0);
    if (d) out[k] = d;
  }
  return out;
};
const empty = (o) => Object.keys(o).length === 0;
const HOST_NAME = "Vega";
const GUEST_NAME = "Orion";
const GUEST_RENAME = "Lyra";
const DESKTOP = { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true };

/** What the join card shows (DOM, as a player reads it). */
const CARD = `(() => {
  const q = (s) => document.querySelector(s);
  const card = q("[data-coop-card]");
  if (!card) return null;
  return {
    state: card.dataset.coopCard, world: q("[data-coop-world]")?.textContent.trim() ?? "",
    host: q("[data-coop-host]")?.textContent.trim() ?? "", slots: q("[data-coop-slots]")?.dataset.coopSlots ?? "",
    version: q("[data-coop-version]")?.dataset.coopVersion ?? "", refusal: q("[data-coop-refusal]")?.dataset.coopRefusal ?? null,
    message: q("[data-coop-refusal]")?.textContent.trim() ?? null, action: q("[data-coop-action]")?.dataset.coopAction ?? null,
    joinEnabled: !!q("[data-coop-join]") && !q("[data-coop-join]").disabled,
  };
})()`;
/** Type into the code field the way React sees typing (native setter + input event). */
const typeCode = (c) => `(() => {
  const el = document.querySelector("[data-coop-code]");
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  set.call(el, ""); el.dispatchEvent(new Event("input", { bubbles: true }));
  set.call(el, ${JSON.stringify(c)}); el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;
/** Check the crew pill against nearby HUD regions, and every toolbar control against its peers. */
const PILL_LAYOUT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" ? r : null; };
  const pill = document.querySelector(".coop-pill");
  const p = pill && vis(pill);
  if (!p) return { pill: null, overlaps: [] };
  const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const onScreen = r => r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
  const sel = [".hud__panel-btn", ".cargo-hud", ".objective-tracker", ".settings__open-button", ".notif-stack__item", ".hint-strip", ".poi-marker--pilot"];
  const overlaps = [];
  for (const s of sel) for (const el of document.querySelectorAll(s)) {
    const r = vis(el);
    if (r && hit(r, p)) overlaps.push(s);
  }
  const box = (r) => r && [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  const t = document.querySelector(".objective-tracker");
  const menu = document.querySelector(".settings__open-button").getBoundingClientRect();
  const gap = Math.round(Math.max(menu.left - p.right, p.left - menu.right));
  const controls = [...document.querySelectorAll(".cargo-hud, .hud__panel-btn, .settings__open-button")]
    .map(el => ({ el, r: vis(el), label: el.getAttribute("aria-label") || "Cargo" }))
    .filter(({ r }) => r);
  const controlOverlaps = [];
  for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
    const a = controls[i];
    const b = controls[j];
    if (hit(a.r, b.r)) controlOverlaps.push([a.label, b.label]);
  }
  const outside = controls.filter(({ r }) => !onScreen(r)).map(({ label }) => label);
  const occluded = controls.filter(({ el, r }) => !el.contains(document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2)))
    .map(({ label }) => label);
  const quickActions = controls.filter(({ el }) => el.matches(".hud__panel-btn")).map(({ label }) => label);
  return { width: innerWidth, pill: box(p), gap, onScreen: onScreen(p), tracker: t ? box(vis(t)) : null, trackerText: t?.textContent.trim().slice(0, 40) ?? null,
    overlaps, controlOverlaps, outside, occluded, quickActions };
})()`;
const LOCAL_STORAGE = `JSON.stringify(Object.fromEntries(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)])))`;
const IDB_WORLDS = `new Promise((res) => { const r = indexedDB.open("stellar-nomad"); r.onsuccess = () => { const db = r.result;
  if (!db.objectStoreNames.contains("worldMeta")) { db.close(); return res([]); }
  const g = db.transaction("worldMeta").objectStore("worldMeta").getAllKeys(); g.onsuccess = () => { db.close(); res(g.result); }; };
  r.onerror = () => res(null); })`;

/** WebGPU pipeline errors either page logged so far (a pending pipeline drawn: setPipeline TypeError). */
const pipelineErrors = (...pages) => pages.flatMap((p) => (p.errors ?? []).filter((e) => /setPipeline|GPURenderPipeline/.test(e)).map((e) => `${p.role}: ${e.slice(0, 120)}`));

/** The world's stored record in this page's IndexedDB (revision + meta), or null when none. */
const IDB_RECORD = (id) => `new Promise((res) => { const r = indexedDB.open("stellar-nomad"); r.onsuccess = () => { const db = r.result;
  if (!db.objectStoreNames.contains("worldData")) { db.close(); return res(null); }
  const tx = db.transaction(["worldData", "worldMeta"]); const d = tx.objectStore("worldData").get(${JSON.stringify(id)}); const m = tx.objectStore("worldMeta").get(${JSON.stringify(id)});
  tx.oncomplete = () => { db.close(); res(d.result ? { revision: d.result.world?.revision ?? null, lastPlayedAt: m.result?.lastPlayedAt ?? null } : null); }; };
  r.onerror = () => res(null); })`;

/** Settings → Dev, as a player opens it: which save buttons are on screen. Closes the menu again. */
async function saveButtons(page) {
  const open = () => page.evaluate("!!document.querySelector('.settings-menu')");
  if (!(await open())) await page.press("Escape");
  await page.sleep(300);
  await page.evaluate(`[...document.querySelectorAll(".settings-menu__button")].find((e) => e.textContent.trim().toLowerCase().startsWith("dev"))?.click(), true`);
  await page.sleep(300);
  const ui = await page.evaluate(`(() => { const t = [...document.querySelectorAll("button")].map((b) => b.textContent.trim().toLowerCase());
    return { dev: document.body.textContent.includes("audio workshop"), exportSave: t.includes("export save"), importSave: t.includes("import save"), resetWorld: t.includes("reset world") }; })()`);
  for (let i = 0; i < 3 && (await open()); i++) {
    await page.press("Escape");
    await page.sleep(250);
  }
  return { ...ui, closed: !(await open()) };
}

async function waitFor(fn, ms, step = 200) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, step));
  }
}

export default async function coopCheck({ host, guest, extraGuests = [], log }) {
  const parts = (process.env.COOP_PARTS ?? "settingsSpawn,presence,jitter,race,raceRev,dropReply,restart,lunar,joinCard,reloadPose,lateName,remoteFx,crash,pilotMarker,rename,pilotActions,joinLifecycle,writeGate,exportHidden,cancelJoin,handoff,hostFail,leave").split(",");
  const results = {};
  const t0 = Date.now();
  let worldId = null;
  let prevWorld = null;
  let code = null;

  const ids = { host: null, guest: null };
  const record = (pid) => host.evaluate(`${C}.hostRecord(${J(pid)})`);
  const session = () => host.evaluate(`${C}.hostRecord()`);

  /** Both sides' durable view: host-worker records, both mirrors, depletions, revisions. */
  async function snapshot() {
    const [hr, gr, info, hm, gm, hs, gs, gd] = await Promise.all([
      record(ids.host), record(ids.guest), session(), host.evaluate(`${C}.mirror()`), guest.evaluate(`${C}.mirror()`),
      host.evaluate(`${C}.status()`), guest.evaluate(`${C}.status()`), guest.evaluate(`${C}.destroyedCount()`),
    ]);
    return {
      host: { record: hr.cargo.items, mined: hr.minedLifetime, stream: hr.stream, mirror: hm.cargo.items },
      guest: { record: gr.cargo.items, mined: gr.minedLifetime, stream: gr.stream, mirror: gm.cargo.items },
      destroyed: info.destroyed, guestDestroyed: gd, revision: info.revision, gen: info.gen,
      clientRevision: { host: hs.session?.revision ?? null, guest: gs.session?.revision ?? null },
    };
  }

  /** Aim at a rock until MiningSystem focuses it; then wait for a cold laser. */
  async function aim(page, r) {
    const t = J(ref(r));
    const ok = await waitFor(async () => {
      await page.evaluate(`${R}.face(${t})`);
      const m = await page.evaluate(`${R}.mining()`);
      return m.focused && m.targetId === r.instanceId;
    }, 15_000);
    if (!ok) throw new Error(`${page.role} could not focus rock ${r.instanceId}`);
    await waitFor(async () => (await page.evaluate(`${R}.state()`)).heat01 < 0.05, 30_000, 500);
    await page.evaluate(`${R}.face(${t})`);
  }

  /** Wait for the beam to stop and the claim to settle. */
  async function settle(page) {
    await waitFor(async () => !(await page.evaluate(`${R}.mining()`)).mining, 30_000);
    return waitFor(async () => (await page.evaluate(`${C}.pending()`)) === null, 30_000);
  }

  /** Guest: open the invite link, wait for a good card, press Join, wait for the game and the session. */
  async function joinByCard(c = code, page = guest) {
    const t0 = Date.now();
    await page.load({ join: c });
    const card = await waitFor(async () => {
      const k = await page.evaluate(CARD);
      return k && k.state === "room" && k.joinEnabled ? k : null;
    }, 30_000, 250);
    if (!card) throw new Error(`join card never offered Join: ${J(await page.evaluate(CARD))}`);
    const clicked = Date.now();
    await page.evaluate(`document.querySelector("[data-coop-join]").click(), true`);
    await page.ready();
    const ready = Date.now();
    const st = await waitFor(async () => {
      const g = await page.evaluate(`${C}.status()`);
      return g.status === "joined" ? g : null;
    }, 30_000, 250);
    if (!st) throw new Error(`guest never joined: ${J(await page.evaluate(`${C}.log()`))}`);
    return { card, status: st, ms: { card: clicked - t0, toReady: ready - clicked }, readyAt: ready };
  }

  /** Host sees the guest's pose fresh (≤ 300 ms old) for player `pid`. */
  const hostSees = async (pid) => (await host.evaluate(`${C}.status()`)).remotes.find((r) => r.id === pid && r.ageMs !== null && r.ageMs < 300) ?? null;

  /** A mineable rock near `page` (beam 3–12 s, still standing everywhere). */
  async function pickRock(page, fieldId, minS = 3) {
    const rocks = await waitFor(async () => {
      const rs = await page.evaluate(`${C}.rocks(${fieldId ? J(fieldId) : "undefined"}, 80)`);
      return rs.length > 20 ? rs : null;
    }, 30_000, 500);
    if (!rocks) throw new Error(`${page.role}: no rocks loaded`);
    // Solo (hostFail): no host session to ask, this page's own view decides.
    const destroyed = (await session())?.destroyed ?? [];
    for (const r of rocks) {
      if (r.mineS < minS || r.mineS > 12) continue;
      if ((await page.evaluate(`${C}.rockState(${J(ref(r))})`)).destroyed) continue;
      if (destroyed.includes(`${r.fieldId}:${r.chunkKey}:${r.instanceId}`)) continue;
      return r;
    }
    throw new Error(`${page.role}: no rock with a 3–12 s beam`);
  }

  async function warpTo(page, r, factor = 1) {
    const standoff = Math.max(0.6, (r.radiusM / 1000) * 4) * factor;
    if (!(await page.evaluate(`${R}.warpNear(${J(ref(r))}, ${standoff})`))) throw new Error(`${page.role}: rock not loaded for warp`);
    await page.frames(30);
    await page.sleep(1000);
  }

  /** Bring the guest into the rock's chunk (meet the host first when the guest streams elsewhere). */
  async function guestTo(r) {
    if (!(await guest.evaluate(`${C}.rockState(${J(ref(r))})`)).loaded) {
      await guest.evaluate(`${C}.meetRemote(0.3)`);
      await guest.frames(30);
      if (!(await waitFor(async () => (await guest.evaluate(`${C}.rockState(${J(ref(r))})`)).loaded, 30_000, 500))) {
        throw new Error("guest never streamed the rock");
      }
    }
    await warpTo(guest, r, 1.4);
  }

  const menu = (page, open) => page.evaluate(`${R}.setSettingsOpen(${open}), true`);
  const pauseChecks = {};
  async function framesWhilePaused() {
    await host.sleep(350);
    const before = await host.evaluate("__test.frameCount");
    await host.sleep(400);
    return await host.evaluate("__test.frameCount") === before;
  }

  async function settingsSpawn() {
    const [h, g] = await Promise.all([host, guest].map(p => p.evaluate("__test.state()")));
    const separationM = Math.hypot(...g.ship.relPosKm.map((x, i) => x - h.ship.relPosKm[i])) * 1000;
    try {
      await menu(host, true);
      await menu(guest, true);
      await Promise.all([host.frames(10), guest.frames(10)]);
      const [afterH, afterG] = await Promise.all([host, guest].map(p => p.evaluate("__test.state()")));
      const checks = { ...pauseChecks,
        nearbyDistinctSpawn: h.ship.frameId === g.ship.frameId && separationM >= 35 && separationM < 250,
        hostAdvanced: afterH.ship.steps > h.ship.steps && afterH.simEpochMs > h.simEpochMs,
        guestAdvanced: afterG.ship.steps > g.ship.steps && afterG.simEpochMs > g.simEpochMs,
      };
      return { pass: Object.values(checks).every(Boolean), checks, separationM };
    } finally {
      await Promise.all([host, guest].map(p => menu(p, false)));
    }
  }

  async function presence() {
    const p0 = Date.now();
    await guest.evaluate(`${C}.meetRemote(0.06)`);
    await guest.frames(30);
    await guest.sleep(1500);
    for (const p of [host, guest]) {
      await p.evaluate(`${C}.faceRemote()`);
      await p.frames(10);
      await p.evaluate(`${C}.faceRemote()`);
    }
    await host.sleep(500);
    const shots = { host: await host.shot("coop/presence-host"), guest: await guest.shot("coop/presence-guest") };
    const fresh = (s) => s.remotes.length === 1 && s.remotes[0].ageMs !== null && s.remotes[0].ageMs < 1500;
    // First sight once compiled the other ship's pipelines mid-frame on both pages (a ~3 s pose
    // stall, full2.log); CoopLayer now precompiles it at session start. The first sample must be fresh.
    const first = [await host.evaluate(`${C}.status()`), await guest.evaluate(`${C}.status()`)];
    const both = await waitFor(async () => {
      const x = [await host.evaluate(`${C}.status()`), await guest.evaluate(`${C}.status()`)];
      return fresh(x[0]) && fresh(x[1]) ? x : null;
    }, 8000, 250);
    const [hs, gs] = both ?? [await host.evaluate(`${C}.status()`), await guest.evaluate(`${C}.status()`)];
    const firstAgeMs = { host: first[0].remotes[0]?.ageMs ?? null, guest: first[1].remotes[0]?.ageMs ?? null };
    const dist = { host: await host.evaluate(`${C}.remoteDistanceKm()`), guest: await guest.evaluate(`${C}.remoteDistanceKm()`) };
    const errs = pipelineErrors(host, guest);
    const checks = {
      fresh: fresh(hs) && fresh(gs),
      near: dist.host < 1 && dist.guest < 1,
      // Precompiled remote ship (CoopLayer): first sight neither stalls poses nor draws a pending pipeline.
      firstLookFresh: firstAgeMs.host !== null && firstAgeMs.guest !== null && firstAgeMs.host < 200 && firstAgeMs.guest < 200,
      noPipelineErrors: errs.length === 0,
    };
    return {
      pass: Object.values(checks).every(Boolean), checks,
      remotes: { host: hs.remotes, guest: gs.remotes }, firstAgeMs, distKm: dist, pipelineErrors: errs.length ? errs : undefined, shots, ms: Date.now() - p0,
    };
  }

  /**
   * The other ship as drawn, per frame (CoopLayer probe). Parked: it must not move at all (the
   * co-op clock once re-solved the ephemeris mid-frame: 1–10 m jumps every frame). Flying: the
   * residual against a ±50 ms straight-line fit is the visible twitch.
   */
  async function jitter() {
    const p0 = Date.now();
    await guest.evaluate(`${C}.meetRemote(0.06)`);
    await guest.frames(30);
    await guest.sleep(2000);
    const pos = (rows) => rows.map((r) => [r[0], r[2], r[3], r[4]]);
    const maxDev = (rows) => {
      const P = pos(rows);
      if (P.length < 10) return null;
      const m = [1, 2, 3].map((i) => P.reduce((a, r) => a + r[i], 0) / P.length);
      return Math.max(...P.map((r) => Math.hypot(r[1] - m[0], r[2] - m[1], r[3] - m[2])));
    };
    const residual = (rows) => {
      const P = pos(rows);
      const res = [];
      for (let i = 0; i < P.length; i++) {
        const w = P.filter((r) => Math.abs(r[0] - P[i][0]) <= 50);
        if (P[i][0] - P[0][0] < 50 || P[P.length - 1][0] - P[i][0] < 50) continue;
        // Local straight-line fit in time, evaluated at this frame's own time (frames are uneven).
        const tm = w.reduce((a, r) => a + r[0], 0) / w.length;
        const stt = w.reduce((a, r) => a + (r[0] - tm) ** 2, 0) || 1;
        const m = [1, 2, 3].map((k) => {
          const xm = w.reduce((a, r) => a + r[k], 0) / w.length;
          const slope = w.reduce((a, r) => a + (r[0] - tm) * (r[k] - xm), 0) / stt;
          return xm + slope * (P[i][0] - tm);
        });
        res.push(Math.hypot(P[i][1] - m[0], P[i][2] - m[1], P[i][3] - m[2]));
      }
      res.sort((a, b) => a - b);
      const dt = (P[P.length - 1][0] - P[0][0]) / 1000;
      const d = Math.hypot(P[P.length - 1][1] - P[0][1], P[P.length - 1][2] - P[0][2], P[P.length - 1][3] - P[0][3]);
      return res.length ? { p50: +res[res.length >> 1].toFixed(3), p95: +res[Math.floor(res.length * 0.95)].toFixed(3), max: +res[res.length - 1].toFixed(3), speedMps: +(d / dt).toFixed(1), n: P.length } : null;
    };
    const [hs, gs] = await Promise.all([host.evaluate(`${C}.probe(3000)`), guest.evaluate(`${C}.probe(3000)`)]);
    const still = { host: maxDev(hs), guest: maxDev(gs) };
    // Guest flies past the parked host for a few seconds.
    await guest.keyDown("w");
    await guest.sleep(1500);
    const moving = residual(await host.evaluate(`${C}.probe(3000)`));
    await guest.keyUp("w");
    const checks = {
      stillHost: still.host !== null && still.host < 0.01,
      stillGuest: still.guest !== null && still.guest < 0.01,
      movingSmooth: moving !== null && moving.speedMps > 5 && moving.p95 < 0.25,
    };
    return { pass: Object.values(checks).every(Boolean), checks, stillMaxDevM: still, moving, ms: Date.now() - p0 };
  }

  /** Both pilots beam the same rock; `first` starts OFFSET_MS earlier and must win. */
  async function race(firstRole, name) {
    const p0 = Date.now();
    // ≥ 5 s: on a 3.9 s beam the first pilot's 300 ms head start once lost to frame jitter
    // (full1.log: guest-first, host won; one depletion, one correct grant all the same).
    const r = await pickRock(host, undefined, 5);
    const t = ref(r);
    await warpTo(host, r);
    await guestTo(r);
    await Promise.all([aim(host, r), aim(guest, r)]);
    const predicted = await host.evaluate(`${C}.predict(${J({ ...t, radiusM: r.radiusM })})`);
    const before = await snapshot();
    const shotsBefore = { host: await host.shot(`coop/${name}-host-before`), guest: await guest.shot(`coop/${name}-guest-before`) };
    const [first, second] = firstRole === "host" ? [host, guest] : [guest, host];
    const m0 = Date.now();
    await first.press("m");
    await first.sleep(OFFSET_MS);
    await second.press("m");
    if (HOLD_MS > 0) {
      // Just before the winner's beam ends, hold the loser's incoming messages.
      await second.sleep(Math.max(0, m0 + r.mineS * 1000 - 800 - Date.now()));
      if (!(await second.evaluate(`${C}.holdIncoming(${HOLD_MS})`))) throw new Error("no link to delay");
    }
    // Loser's beam as it ran (diagnostic: progress, focus, its pending claim).
    const trace = [];
    let tracing = true;
    const tracer = (async () => {
      while (tracing && trace.length < 120) {
        const m = await second.evaluate(`[${R}.mining(), ${C}.pending()]`);
        trace.push([Date.now() - m0, m[0].mining ? 1 : 0, +m[0].progress.toFixed(2), m[0].targetId === r.instanceId ? 1 : 0, m[1] ? m[1].seq : null]);
        await second.sleep(150);
      }
    })();
    const settled = await Promise.all([settle(host), settle(guest)]);
    tracing = false;
    await tracer;
    const mineMs = Date.now() - m0;
    // The loser's view of the commit lands within a few frames; give it a moment.
    await waitFor(async () => (await guest.evaluate(`${C}.destroyedCount()`)) > before.guestDestroyed, 10_000);
    await host.frames(20);
    await guest.frames(20);
    const after = await snapshot();
    const shotsAfter = { host: await host.shot(`coop/${name}-host-after`), guest: await guest.shot(`coop/${name}-guest-after`) };
    const rock = { host: await host.evaluate(`${C}.rockState(${J(t)})`), guest: await guest.evaluate(`${C}.rockState(${J(t)})`) };
    const grants = { host: delta(after.host.record, before.host.record), guest: delta(after.guest.record, before.guest.record) };
    const winner = !empty(grants.host) && empty(grants.guest) ? "host" : empty(grants.host) && !empty(grants.guest) ? "guest" : null;
    const loser = firstRole === "host" ? "guest" : "host";
    // How the loser ended: a claim the host rejected, or a beam cut when the rock vanished.
    const loserStream = after[loser].stream;
    const loserClaim = loserStream.seq > before[loser].stream.seq ? `${loserStream.outcome?.status}:${loserStream.outcome?.reason ?? ""}` : "beam cut (rock vanished)";
    const firstStream = after[firstRole].stream;
    const firstClaim = firstStream.seq > before[firstRole].stream.seq ? `${firstStream.outcome?.status}:${firstStream.outcome?.reason ?? ""}` : "no claim (beam cut)";
    const key = `${t.fieldId}:${t.chunkKey}:${t.instanceId}`;
    const depletions = after.destroyed.length - before.destroyed.length;
    const checks = {
      settled: settled.every(Boolean),
      oneWinner: winner === firstRole,
      loserRejected: HOLD_MS > 0 ? loserClaim === "rejected:already_done" : true,
      yieldOk: winner ? sameItems(grants[winner], predicted.solo) : false,
      oneDepletion: depletions === 1 && after.destroyed.includes(key),
      guestSawDepletion: after.guestDestroyed - before.guestDestroyed === 1,
      vanishedBoth: !rock.host.loaded && !rock.guest.loaded && rock.host.destroyed && rock.guest.destroyed,
      mirrorsMatch: sameItems(after.host.mirror, after.host.record) && sameItems(after.guest.mirror, after.guest.record),
      // Only accepted commits bump the revision; both clients must have caught up to it.
      revision: after.revision === before.revision + 1 && after.clientRevision.guest === after.revision && after.clientRevision.host === after.revision,
      noPipelineErrors: pipelineErrors(host, guest).length === 0,
    };
    return {
      pass: Object.values(checks).every(Boolean), checks, rock: { ...t, radiusM: r.radiusM, mineS: r.mineS }, first: firstRole, winner, loserClaim, firstClaim,
      grants, predicted: predicted.solo, depletions, revision: [before.revision, after.revision], clientRevision: after.clientRevision,
      cargo: { hostRecord: after.host.record, hostMirror: after.host.mirror, guestRecord: after.guest.record, guestMirror: after.guest.mirror },
      shots: { before: shotsBefore, after: shotsAfter }, mineMs, ms: Date.now() - p0,
      loserTrace: checks.loserRejected ? undefined : trace,
    };
  }

  /** Guest mines with the host's `settled` reply dropped; `recover` brings the link back. */
  async function guestMineDropped(name, recover, fieldId) {
    const p0 = Date.now();
    const r = await pickRock(guest, fieldId);
    const t = ref(r);
    await warpTo(guest, r);
    await aim(guest, r);
    const predicted = await guest.evaluate(`${C}.predict(${J({ ...t, radiusM: r.radiusM })})`);
    const before = await snapshot();
    if (recover && !(await guest.evaluate(`${C}.cutAfterCommit()`))) throw new Error("no guest link to fault");
    const m0 = Date.now();
    await guest.press("m");
    await waitFor(async () => !(await guest.evaluate(`${R}.mining()`)).mining, 30_000);
    let fault = null;
    if (recover) {
      await guest.sleep(2000);
      const stuck = await guest.evaluate(`${C}.pending()`);
      const mid = await snapshot();
      fault = { pendingAfterDrop: stuck ? { seq: stuck.seq, opId: stuck.opId } : null, hostGrantedBeforeRetry: delta(mid.guest.record, before.guest.record), mirrorBeforeRetry: delta(mid.guest.mirror, before.guest.mirror) };
      Object.assign(fault, await recover(t));
    }
    const settled = await waitFor(async () => (await guest.evaluate(`${C}.pending()`)) === null, 60_000);
    const mineMs = Date.now() - m0;
    await guest.frames(20);
    const after = await snapshot();
    const rock = { host: await host.evaluate(`${C}.rockState(${J(t)})`), guest: await guest.evaluate(`${C}.rockState(${J(t)})`) };
    const grant = delta(after.guest.record, before.guest.record);
    const key = `${t.fieldId}:${t.chunkKey}:${t.instanceId}`;
    const checks = {
      settled: !!settled,
      accepted: after.guest.stream.outcome?.status === "accepted",
      grantedOnce: sameItems(grant, predicted.solo) && after.guest.mined === before.guest.mined + 1,
      yieldEqualsPreview: sameItems(predicted.solo, predicted.preview),
      hostUntouched: sameItems(after.host.record, before.host.record),
      oneDepletion: after.destroyed.length - before.destroyed.length === 1 && after.destroyed.includes(key),
      vanished: !rock.guest.loaded && rock.guest.destroyed,
      mirrorsMatch: sameItems(after.guest.mirror, after.guest.record) && sameItems(after.host.mirror, after.host.record),
    };
    if (recover) {
      checks.replyWasLost = !!fault.pendingAfterDrop && empty(fault.mirrorBeforeRetry) && sameItems(fault.hostGrantedBeforeRetry, predicted.solo);
      checks.sameIntentRetried = fault.pendingAfterDrop?.seq === after.guest.stream.seq && fault.pendingAfterDrop?.opId === after.guest.stream.opId;
    }
    return {
      pass: Object.values(checks).every(Boolean), checks, rock: { ...t, radiusM: r.radiusM, mineS: r.mineS }, grant, predicted, fault,
      stream: after.guest.stream, revision: [before.revision, after.revision], gen: [before.gen, after.gen], clientRevision: after.clientRevision,
      cargo: { guestRecord: after.guest.record, guestMirror: after.guest.mirror }, mineMs, ms: Date.now() - p0, rockState: rock,
    };
  }

  async function dropReply() {
    return guestMineDropped("dropReply", async () => {
      await guest.evaluate(`${C}.forceReconnect()`);
      return {};
    });
  }

  async function restart() {
    const out = await guestMineDropped("restart", async (t) => {
      const g0 = (await session()).gen;
      const r0 = Date.now();
      // Host restart = page reload: solo boot from IDB, then hosting reopens on the same code.
      await host.load();
      await host.ready();
      const solo = await host.evaluate(`${C}.rockState(${J(t)})`);
      const soloWorld = await host.evaluate(`${C}.worldId()`);
      const code2 = await host.evaluate(`${C}.host()`);
      const rejoined = await waitFor(async () => {
        const s = await guest.evaluate(`${C}.status()`);
        return s.status === "joined" && s.session?.gen === g0 + 1 ? s : null;
      }, 60_000, 500);
      return { durableAfterReload: solo.destroyed, soloWorld: soloWorld === worldId, sameCode: code2 === code, genBefore: g0, rejoinedGen: rejoined?.session?.gen ?? null, restartMs: Date.now() - r0 };
    });
    out.checks.durable = out.fault.durableAfterReload && out.fault.soloWorld && out.fault.sameCode && out.fault.rejoinedGen === out.fault.genBefore + 1;
    out.pass = Object.values(out.checks).every(Boolean);
    return out;
  }

  async function lunar() {
    const p0 = Date.now();
    const hostBefore = await host.evaluate("__test.state()");
    await guest.evaluate(`__phys.asteroids.warpToField("luna_belt", [1200, 300, -1200])`);
    await guest.frames(30);
    const out = await guestMineDropped("lunar", null, "luna_belt");
    const t = out.rock;
    const hostAfter = await host.evaluate("__test.state()");
    const hostLuna = { chunks: await host.evaluate(`${C}.loadedChunks("luna_belt")`), rock: out.rockState.host };
    const guestFrame = (await guest.evaluate("__test.state()")).ship.frameId;
    const hostFrames0 = await host.frames(30);
    const shots = { host: await host.shot("coop/lunar-host"), guest: await guest.shot("coop/lunar-guest") };
    out.checks.lunarField = t.fieldId === "luna_belt";
    out.checks.hostNotStreaming = hostLuna.chunks === 0 && !hostLuna.rock.chunkLoaded;
    out.checks.hostStillAtEarth = hostAfter.ship.frameId === hostBefore.ship.frameId && hostFrames0 > hostBefore.frames;
    out.checks.identity = out.predicted.frameId === "luna" && out.predicted.radiusM === t.radiusM;
    out.pass = Object.values(out.checks).every(Boolean);
    return { ...out, hostFrame: hostAfter.ship.frameId, guestFrame, hostLuna, shots, ms: Date.now() - p0 };
  }

  /** Invite link → card (name/host/slots/version), refusals with no state change, then Join. */
  async function joinCard() {
    const p0 = Date.now();
    const hostInfo = { worldName: await host.evaluate(`${C}.worldName()`) };
    const hostStatus0 = await host.evaluate(`${C}.status()`);
    await guest.load({ join: code });
    // The guest left by reloading: wait for the host to count one pilot (the card reads the room).
    await waitFor(async () => (await host.evaluate(`${C}.status()`)).players === 1, 15_000, 250);
    await guest.evaluate(typeCode(code));
    const ok = await waitFor(async () => {
      const k = await guest.evaluate(CARD);
      return k && k.state === "room" ? k : null;
    }, 20_000, 250);
    const shots = { desktop: await guest.shot("coop/joincard-1280") };
    await guest.send("Emulation.setDeviceMetricsOverride", PHONE);
    await guest.sleep(400);
    shots.phone = await guest.shot("coop/joincard-390");
    await guest.send("Emulation.setDeviceMetricsOverride", DESKTOP);
    await guest.sleep(200);
    const expectSlots = `${(await host.evaluate(`${C}.status()`)).players}/4`;

    // Refusals: each one line + one action, and none may touch storage, the room or the host.
    const ls0 = await guest.evaluate(LOCAL_STORAGE);
    const idb0 = await guest.evaluate(IDB_WORLDS);
    const hostLog0 = (await host.evaluate(`${C}.log()`)).filter((l) => / (join|offer|answer)$/.test(l)).length;
    const refusal = async (setup, c, want, shot) => {
      await guest.evaluate(`window.__coopFault = ${J(setup)}; true`);
      await guest.evaluate(typeCode(c));
      const k = await waitFor(async () => {
        const x = await guest.evaluate(CARD);
        return x && x.refusal === want ? x : null;
      }, 15_000, 250);
      const shotPath = shot ? await guest.shot(`coop/joincard-${shot}`) : undefined;
      if (shot === "version") {
        await guest.send("Emulation.setDeviceMetricsOverride", PHONE);
        await guest.sleep(400);
        shots.versionPhone = await guest.shot("coop/joincard-version-390");
        await guest.send("Emulation.setDeviceMetricsOverride", DESKTOP);
        await guest.sleep(200);
      }
      return k ? { ...k, shot: shotPath } : { refusal: null, card: await guest.evaluate(CARD) };
    };
    const refusals = {
      version: await refusal({ content: true }, code, "version", "version"),
      no_room: await refusal({}, "ZZZZZ9", "no_room", "noroom"),
      unreachable: await refusal({ signalingDown: true }, code, "unreachable", "unreachable"),
      full: await refusal({ full: true }, code, "full", null),
    };
    const ls1 = await guest.evaluate(LOCAL_STORAGE);
    const idb1 = await guest.evaluate(IDB_WORLDS);
    const hostStatus1 = await host.evaluate(`${C}.status()`);
    const hostLog1 = (await host.evaluate(`${C}.log()`)).filter((l) => / (join|offer|answer)$/.test(l)).length;
    const phase = await guest.evaluate("__test.app.phase()");
    await guest.evaluate(`window.__coopFault = {}; true`);

    // Back to a good code: Join.
    await guest.evaluate(typeCode(code));
    const j = await joinByCard(code);
    const checks = {
      shows: !!ok && ok.world === hostInfo.worldName && ok.host === HOST_NAME && ok.slots === expectSlots && ok.version === "ok" && ok.joinEnabled,
      versionMsg: refusals.version.refusal === "version" && refusals.version.message === "Different game version" && refusals.version.version === "bad" && !refusals.version.joinEnabled && refusals.version.action === "reload",
      noRoomMsg: refusals.no_room.refusal === "no_room" && refusals.no_room.action === "edit" && !refusals.no_room.joinEnabled,
      unreachableMsg: refusals.unreachable.refusal === "unreachable" && refusals.unreachable.action === "retry",
      fullMsg: refusals.full.refusal === "full" && !refusals.full.joinEnabled,
      distinct: new Set(Object.values(refusals).map((r) => r.message)).size === 4,
      noMutation: ls0 === ls1 && J(idb0) === J(idb1) && hostLog0 === hostLog1 && hostStatus1.players <= Number(expectSlots.split("/")[0]) && phase === "title",
      joined: j.status.status === "joined" && j.status.playerId === ids.guest,
    };
    return {
      pass: Object.values(checks).every(Boolean), checks, card: ok, expect: { world: hostInfo.worldName, host: HOST_NAME, slots: expectSlots },
      refusals, hostStatus: { before: hostStatus0.players, during: hostStatus1.players }, join: j.ms, shots, ms: Date.now() - p0,
    };
  }

  /** Guest reloads and rejoins: the host sees its ship again within 2 s of the guest playing. */
  async function reloadPose() {
    const p0 = Date.now();
    const j = await joinByCard();
    const seen = await waitFor(() => hostSees(ids.guest), 10_000, 50);
    const seenMs = seen ? Date.now() - j.readyAt : null;
    const g = await guest.evaluate("__test.state()");
    const checks = { rejoined: j.status.playerId === ids.guest, hostSeesWithin2s: seenMs !== null && seenMs <= 2000 };
    return { pass: Object.values(checks).every(Boolean), checks, seenMs, guestFrame: g.ship.frameId, hostSees: seen, join: j.ms, ms: Date.now() - p0 };
  }

  /** Guest renames and rejoins: each side's marker shows the other's chosen name. */
  async function lateName() {
    const p0 = Date.now();
    await guest.evaluate(`${C}.name(${J(GUEST_RENAME)})`);
    const j = await joinByCard();
    await waitFor(() => hostSees(ids.guest), 10_000, 100);
    await guest.evaluate(`${C}.meetRemote(0.06)`);
    await guest.frames(30);
    await guest.sleep(1000);
    const labels = await waitFor(async () => {
      for (const p of [host, guest]) {
        await p.evaluate(`${C}.faceRemote()`);
        await p.frames(5);
      }
      const l = { host: await host.evaluate(`${C}.labels()`), guest: await guest.evaluate(`${C}.labels()`) };
      return l.host.includes(GUEST_RENAME) && l.guest.includes(HOST_NAME) ? l : null;
    }, 15_000, 300);
    const last = labels ?? { host: await host.evaluate(`${C}.labels()`), guest: await guest.evaluate(`${C}.labels()`) };
    const shots = { host: await host.shot("coop/latename-host"), guest: await guest.shot("coop/latename-guest") };
    const layout = { host: await host.evaluate(PILL_LAYOUT), guest: await guest.evaluate(PILL_LAYOUT) };
    await guest.send("Emulation.setDeviceMetricsOverride", PHONE);
    await guest.sleep(600);
    layout.guestPhone = await guest.evaluate(PILL_LAYOUT);
    shots.guestPhone = await guest.shot("coop/latename-guest-390");
    await guest.send("Emulation.setDeviceMetricsOverride", DESKTOP);
    await guest.sleep(300);
    const checks = {
      pillClear: Object.values(layout).every((l) => l.pill && l.overlaps.length === 0), hostShowsGuestName: last.host.includes(GUEST_RENAME), guestShowsHostName: last.guest.includes(HOST_NAME), samePlayer: j.status.playerId === ids.guest };
    return { pass: Object.values(checks).every(Boolean), checks, labels: last, layout, shots, ms: Date.now() - p0 };
  }

  /**
   * Other pilots' activity (playtest 3): the guest beams a rock beside the host. The host draws the
   * guest's beam from its ship to the rock, the guest's plume while it thrusts, and a destruction
   * burst at the rock when the guest's mine commits (no loot for the host).
   */
  async function remoteFx() {
    const p0 = Date.now();
    const r = await pickRock(host, undefined, 6);
    const t = ref(r);
    await warpTo(host, r, 2);
    await guestTo(r);
    // Inside the starter laser range, beyond the former 5 km network cutoff.
    await guest.evaluate(`${R}.warpNear(${J(t)}, 7)`);
    await guest.frames(30);
    const hostCargo0 = (await record(ids.host)).cargo.items;
    const burstsBefore = (await host.evaluate(`${C}.bursts()`)).length;
    await aim(guest, r);
    // The host parks behind and above the guest, facing it, as a friend watching would: the beam
    // runs from the guest's nose away into the rock. fx/fxNow load their module once first.
    await host.evaluate(`${C}.fxNow()`);
    const viewed = await host.evaluate(`${C}.meetRemote(0.12)`);
    await host.frames(30);
    await host.sleep(800);
    await host.evaluate(`${C}.faceRemote()`);
    await host.frames(10);
    const rockKm = (await host.evaluate(`${C}.rocks(${J(r.fieldId)}, 400)`)).find((x) => x.chunkKey === r.chunkKey && x.instanceId === r.instanceId)?.distKm ?? null;
    const m0 = Date.now();
    await guest.press("m");
    // Poll both sides while the beam runs; capture the host's view once it draws the beam.
    const trace = [];
    const shots = {};
    let beamFx = null;
    while (Date.now() - m0 < r.mineS * 1000 + 4000) {
      const [gm, hf] = await Promise.all([guest.evaluate(`${R}.mining()`), host.evaluate(`${C}.fxNow()`)]);
      const s0 = hf.find((x) => x.id === ids.guest);
      trace.push([Date.now() - m0, gm.mining ? 1 : 0, s0?.beam ? 1 : 0, Math.round(s0?.beamLenM ?? 0)]);
      if (s0?.beam && !shots.beam) {
        await host.sleep(300);
        await host.evaluate(`${C}.faceRemote()`);
        shots.beam = await host.shot("coop/remotefx-host-beam");
        beamFx = (await host.evaluate(`${C}.fx(600)`)).find((x) => x.id === ids.guest) ?? null;
        break;
      }
      await host.sleep(150);
    }
    // The burst is short-lived: poll fast and capture as soon as it is logged.
    const burst = await waitFor(async () => {
      const b = await host.evaluate(`${C}.bursts()`);
      return b.length > burstsBefore ? b[b.length - 1] : null;
    }, r.mineS * 1000 + 15_000, 100);
    if (burst) shots.burst = await host.shot("coop/remotefx-host-burst");
    await settle(guest);
    const guestOwn = (await guest.evaluate(`${C}.bursts()`)).filter((b) => b.instanceId === r.instanceId && b.chunkKey === r.chunkKey);
    // Plume: the guest thrusts away from the rock for a moment.
    await guest.keyDown("w");
    await guest.sleep(500);
    const thrustFx = (await host.evaluate(`${C}.fx(800)`)).find((x) => x.id === ids.guest) ?? null;
    await guest.keyUp("w");
    if (thrustFx) shots.thrust = await host.shot("coop/remotefx-host-thrust");
    const hostCargo1 = (await record(ids.host)).cargo.items;
    const burstDistM = burst ? Math.hypot(...burst.position) : null;
    const checks = {
      beamDrawn: !!viewed && !!beamFx && beamFx.beamFrames > 5 && beamFx.beamLenMax > 5000 && beamFx.beamLenMax < 8000,
      burstAtRock: !!burst && burst.instanceId === r.instanceId && burst.chunkKey === r.chunkKey && rockKm !== null && Math.abs(burstDistM - rockKm * 1000) < r.radiusM + 60,
      noOwnBurstOnGuest: guestOwn.length === 0,
      exhaust: !!thrustFx && thrustFx.exhaustMax > 0.05,
      hostNoLoot: sameItems(hostCargo0, hostCargo1),
      noPipelineErrors: pipelineErrors(host, guest).length === 0,
    };
    return { pass: Object.values(checks).every(Boolean), checks, rock: { ...t, radiusM: r.radiusM, mineS: r.mineS, hostDistKm: rockKm }, trace: trace.slice(-25), beamFx, thrustFx, burst: burst && { ...burst, distM: burstDistM }, shots, ms: Date.now() - p0 };
  }

  /** Fly the guest into a loaded asteroid twice. Observe the host's actual VFX and hull visibility. */
  async function crash() {
    const rock = await pickRock(guest);
    const id = rock.instanceId;
    const approach = async (distM, holdMs) => {
      await guest.evaluate(`__phys.asteroids.standoff(${id}, ${distM})`);
      await guest.frames(10);
      if (!await waitFor(() => guest.evaluate(`__phys.asteroids.state(${id}).collider?.inEngine`), 10_000)) throw new Error("asteroid collider missing");
      await guest.evaluate("__phys.impacts.clear()");
      await guest.keyDown("w");
      await guest.sleep(holdMs);
      await guest.keyUp("w");
    };
    await guest.evaluate(`__phys.asteroids.standoff(${id}, 120)`);
    await guest.frames(30);
    await guest.sleep(500);
    await host.evaluate(`${C}.meetRemote(0.4)`);
    const visible = () => host.evaluate(`${C}.fxNow().then(slots => slots.some(s => s.id === ${J(ids.guest)} && s.shown))`);
    const shownBefore = await waitFor(visible, 10_000);
    const health = await host.evaluate("__phys.game.health().health");
    await approach(120, 100);
    const sparks = await waitFor(() => host.evaluate(`${C}.collisions().find(e => e.impactDvMps > 0 && e.shake === 0)`), 18_000, 50);
    await guest.press("x");
    const survived = !(await guest.evaluate("__phys.game.isDead()"));
    await guest.evaluate("__phys.game.setHealth(1)");
    await approach(1500, 1500);
    const burst = await waitFor(() => host.evaluate(`${C}.collisions().find(e => e.radiusM === 120 && e.shake === 0)`), 24_000, 50);
    const dead = await waitFor(() => guest.evaluate("__phys.game.isDead()"), 10_000);
    await host.sleep(700);
    const hidden = !(await visible());
    const healthyObserver = health === await host.evaluate("__phys.game.health().health");
    if (dead) await guest.evaluate("__phys.game.respawn()");
    const reappeared = await waitFor(visible, 12_000);
    const checks = { shownBefore, sparks: !!sparks, survived, burst: !!burst, dead, hidden, healthyObserver, reappeared };
    return { pass: Object.values(checks).every(Boolean), checks, sparks, burst };
  }

  /** The guest as the host sees it: a green POI marker with name and distance, and a green edge triangle when behind. */
  async function pilotMarker() {
    const p0 = Date.now();
    const guestName = await guest.evaluate(`${C}.name()`);
    await guest.evaluate(`${C}.meetRemote(0.4)`);
    await guest.frames(30);
    await guest.sleep(1000);
    const shots = {};
    const out = {};
    for (const [label, size] of [["1280", DESKTOP], ["390", PHONE]]) {
      await host.send("Emulation.setDeviceMetricsOverride", size);
      await host.sleep(500);
      const seen = await waitFor(async () => {
        await host.evaluate(`${C}.faceRemote()`);
        await host.frames(5);
        const m = await host.evaluate(`${C}.markers()`);
        const k = m.markers.find((x) => x.id === `pilot:${ids.guest}` && x.shown);
        return k && k.name ? { ...m, k } : null;
      }, 10_000, 250);
      shots[`front${label}`] = await host.shot(`coop/pilotmarker-front-${label}`);
      // Gaze stays on the pilot: it must never become a transit destination.
      await host.sleep(2000);
      const targeted = (await host.evaluate(`${C}.markers()`)).targetedId;
      const behind = await waitFor(async () => {
        await host.evaluate(`${C}.faceRemote(undefined, true)`);
        await host.frames(5);
        const m = await host.evaluate(`${C}.markers()`);
        const a = m.arrows.find((x) => x.id === `pilot:${ids.guest}` && x.shown);
        return a ? a : null;
      }, 10_000, 250);
      shots[`edge${label}`] = await host.shot(`coop/pilotmarker-edge-${label}`);
      const vw = size.width, vh = size.height;
      out[label] = {
        marker: seen?.k ?? null, arrow: behind, targeted,
        // At the edge, or slid along it out of a HUD region (POIMarkers' avoid pass).
        arrowOnEdge: !!behind && (behind.x <= 72 || behind.x >= vw - 72 || behind.y <= 72 || behind.y >= vh - 72),
      };
    }
    await host.send("Emulation.setDeviceMetricsOverride", DESKTOP);
    await host.sleep(300);
    const green = (c) => /^rgba?\(95, 211, 138/.test(c ?? "");
    const checks = {};
    for (const [label, o] of Object.entries(out)) {
      checks[`name${label}`] = !!o.marker && o.marker.name === guestName;
      checks[`distance${label}`] = !!o.marker && /\d/.test(o.marker.distance) && /(m|km|AU|ly)$/.test(o.marker.distance.trim());
      checks[`green${label}`] = !!o.marker && green(o.marker.color) && !!o.arrow && green(o.arrow.color);
      checks[`edge${label}`] = o.arrowOnEdge;
      checks[`notTargeted${label}`] = !String(o.targeted ?? "").startsWith("pilot:");
    }
    return { pass: Object.values(checks).every(Boolean), checks, guestName, out, shots, ms: Date.now() - p0 };
  }

  /** The host renames in Settings → friends while hosting; the guest's marker follows within 2 s. */
  async function rename() {
    const p0 = Date.now();
    const NEW = "Altair";
    const fallback = (await guest.evaluate(`${C}.nameInfo()`)).fallback;
    await guest.evaluate(`${C}.meetRemote(0.4)`);
    await guest.frames(30);
    const before = await waitFor(async () => {
      await guest.evaluate(`${C}.faceRemote()`);
      await guest.frames(5);
      const l = await guest.evaluate(`${C}.labels()`);
      return l.length ? l : null;
    }, 10_000, 250);
    // As a player: open Settings, Friends, type the name, press Enter.
    if (!(await host.evaluate("!!document.querySelector('.settings-menu')"))) await host.press("Escape");
    await host.sleep(300);
    await host.evaluate(`[...document.querySelectorAll(".settings-menu__button")].find((e) => e.textContent.trim().toLowerCase().startsWith("friends"))?.click(), true`);
    await host.sleep(300);
    const field = await host.evaluate(`(() => { const el = document.querySelector("[data-coop-settings-name]"); return el ? { value: el.value, placeholder: el.placeholder } : null; })()`);
    const shots = { settings: await host.shot("coop/rename-settings") };
    await host.evaluate(`(() => {
      const el = document.querySelector("[data-coop-settings-name]");
      el.focus();
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(el, ${J(NEW)}); el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await host.press("Enter");
    const t0 = Date.now();
    const seen = await waitFor(async () => {
      await guest.evaluate(`${C}.faceRemote()`);
      const l = await guest.evaluate(`${C}.labels()`);
      return l.includes(NEW) ? l : null;
    }, 5000, 100);
    const seenMs = seen ? Date.now() - t0 : null;
    shots.typed = await host.shot("coop/rename-settings-typed");
    shots.guest = await guest.shot("coop/rename-guest");
    for (let i = 0; i < 3 && (await host.evaluate("!!document.querySelector('.settings-menu')")); i++) {
      await host.press("Escape");
      await host.sleep(250);
    }
    const hostRec = (await session())?.members ?? null;
    // Back to the setup name (programmatic path: same setPilotName → session rename).
    await host.evaluate(`${C}.name(${J(HOST_NAME)})`);
    const restored = await waitFor(async () => {
      await guest.evaluate(`${C}.faceRemote()`);
      return (await guest.evaluate(`${C}.labels()`)).includes(HOST_NAME);
    }, 5000, 100);
    const checks = {
      fieldShown: !!field && field.value === HOST_NAME,
      within2s: seenMs !== null && seenMs <= 2000,
      defaultPattern: /^Replicant [0-9A-F]{4}$/.test(fallback),
      restored: !!restored,
    };
    return { pass: Object.values(checks).every(Boolean), checks, field, before, seen, seenMs, fallback, hostMembers: hostRec, shots, ms: Date.now() - p0 };
  }

  async function settledCommand(page, op) {
    const id = "drive-" + crypto.randomUUID();
    const outcome = await page.evaluate(`__test.gameplay.settled(${J({ ...op, opId: id })})`, 15_000);
    if (outcome.status !== "accepted") throw Error(op.type + " " + J(outcome));
    return outcome.result;
  }

  // Each peer receives the commit independently. The sender can settle before the recipient catches up.
  async function synchronizedSnapshot() {
    const synced = await waitFor(async () => {
      const s = await snapshot();
      return s.clientRevision.host === s.revision && s.clientRevision.guest === s.revision ? s : null;
    }, 5000, 50);
    if (!synced) throw Error("Pilots did not reach the host revision");
    return synced;
  }

  async function contentFixture() {
    const mined = await guestMineDropped("contentFixture", null, "origin_belt");
    if (!mined.pass || !(mined.grant.fixture_ore >= 1)) return { pass: false, mined };
    await guest.evaluate(`${C}.meetRemote(0.08)`);
    await guest.sleep(2500);
    await settledCommand(guest, { type: "expedition.give", to: ids.host, amount: 1, kind: "cargo", itemId: "fixture_ore" });
    await settledCommand(host, { type: "item.craft", itemId: "consumable_fixture_patch" });
    const goods = await record(ids.host);
    const stores = await synchronizedSnapshot();
    const acquired = goods.modules.consumables.consumable_fixture_patch === 1 && !goods.cargo.items.fixture_ore &&
      (stores.guest.record.fixture_ore ?? 0) === mined.grant.fixture_ore - 1;
    const rejoined = await joinByCard();
    const after = await synchronizedSnapshot();
    return { pass: acquired && rejoined.status.playerId === ids.guest && sameItems(after.guest.mirror, stores.guest.record),
      granted: mined.grant, transferred: 1, crafted: goods.modules.consumables.consumable_fixture_patch };
  }

  async function shipMenu() {
    const layout = {};
    await guest.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    for (const width of [1440, 1150, 1149, 1100, 1048, 1047, 1024, 844, 768, 681, 680, 600, 599, 450, 390, 375, 320]) {
      const phone = width < 600;
      const page = phone ? guest : host;
      await page.send("Emulation.setDeviceMetricsOverride", { ...(phone ? PHONE : DESKTOP), width });
      layout[width] = await page.evaluate(PILL_LAYOUT);
      if (width === 1440 || width === 390) await page.shot("coop/ship-menu-hud-" + width);
    }
    await guest.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    for (const page of [host, guest]) await page.send("Emulation.setDeviceMetricsOverride", DESKTOP);

    const clickAt = async (x, y) => {
      for (const type of ["mousePressed", "mouseReleased"])
        await host.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    };
    const state = () => host.evaluate(`({ title: document.querySelector("#panel-title")?.textContent ?? null,
      ...__test.input.pointerLock.state() })`);
    await host.send("Page.bringToFront");
    await clickAt(620, 320);
    await host.sleep(350);
    const initial = await state();
    await host.press("h");
    const hudHidden = await host.evaluate(`document.querySelector(".hud__toolbar").getClientRects().length === 0`);
    await host.press("h");
    await host.press("o");
    await host.sleep(500);
    const opened = await state();
    const xy = await host.evaluate(`(() => {
      const button = [...document.querySelectorAll(".settings-menu__categories button")].find(b => b.textContent === "controls");
      const r = button.getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    })()`);
    await clickAt(...xy);
    await host.sleep(300);
    const settings = await state();
    await host.press("Escape");
    await host.sleep(400);
    const back = await state();
    await host.keyDown("Escape");
    await host.sleep(180);
    const held = await state();
    await host.keyUp("Escape");
    await host.sleep(650);
    const resumed = await state();
    // Release the cursor via the flight control, then use the relocated Industry button.
    for (const type of ["mousePressed", "mouseReleased"])
      await host.send("Input.dispatchMouseEvent", { type, x: 620, y: 320, button: "right", clickCount: 1 });
    await host.sleep(200);
    const quickAction = await host.evaluate(`(() => {
      const r = document.querySelector('.hud__panel-btn[aria-label="Industry"]').getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    })()`);
    await clickAt(...quickAction);
    await host.sleep(250);
    const industry = await state();
    await host.press("Escape");
    const checks = {
      clear: Object.entries(layout).every(([width, l]) => l.width === Number(width) && l.onScreen && l.gap >= 4 && !l.overlaps.length &&
        !l.controlOverlaps.length && !l.outside.length && !l.occluded.length && l.quickActions.length === 6 && l.quickActions.includes("Industry")),
      hudHidden,
      industryAccess: industry.title === "Industry",
      fromFlight: initial.locked && opened.title === "Ship menu" && !opened.locked,
      selected: settings.title === "Controls",
      backedOut: back.title === "Ship menu" && back.cursorNeeded && !back.locked,
      heldEscape: held.title === "Ship menu" && !held.locked,
      resumed: !resumed.title && !resumed.cursorNeeded && resumed.locked,
    };
    return { pass: Object.values(checks).every(Boolean), checks, layout, initial, opened, settings, back, held, resumed };
  }

  async function crewUi() {
    await host.evaluate(`${C}.meetRemote(0.08)`);
    await guest.evaluate('__test.gameplay.res.set({ordinaryKg: 5})');
    await host.sleep(2600);
    await settledCommand(host, { type: "research.unlock", nodeId: "sv1_composition_survey" });
    const toastCount = page => page.evaluate(`[...document.querySelectorAll(".notif-stack__detail")].filter(e => e.textContent === "Composition Survey").length`);
    const [notices, sounds] = await Promise.all([
      Promise.all([host, guest].map(page => waitFor(() => toastCount(page), 2500, 40))),
      Promise.all([host, guest].map(page => waitFor(() => page.evaluate('__audio.voices().some(v => v.eventId === "research.complete")'), 2500, 40))),
    ]);
    const crewOpen = () => host.evaluate('document.querySelector("#panel-title")?.textContent === "Crew"');
    await host.press("u");
    if (!await waitFor(crewOpen, 3000)) throw Error("Default Crew shortcut did not open the roster");
    await host.press("u");
    if (!await waitFor(async () => !await crewOpen(), 3000)) throw Error("Crew shortcut did not close the roster");
    await host.press("o");
    const launcher = ".settings-menu__panels";
    if (!await waitFor(() => host.evaluate(`!!document.querySelector(${J(launcher)})`), 3000)) throw Error("Ship menu did not open");
    const titles = { cargo: "Cargo Hold", research: "Research", crafting: "Crafting", loadout: "Ship Loadout", projects: "Projects", industry: "Industry", crew: "Crew" };
    for (const [id, title] of Object.entries(titles)) {
      const shown = await host.evaluate(`document.querySelector('[data-ship-panel="${id}"] kbd')?.textContent`);
      if (!shown) throw Error("Missing shortcut for " + id);
      await host.press(shown.toLowerCase());
      if (!await waitFor(() => host.evaluate(`document.querySelector("#panel-title")?.textContent === ${J(title)}`), 3000))
        throw Error(shown + " did not open " + title);
      if (id === "crew") break; // Continue the transfer test in the roster.
      await host.press(shown.toLowerCase());
      await waitFor(() => host.evaluate('!document.querySelector("#panel-title")'), 3000);
      await host.press("o");
      await waitFor(() => host.evaluate(`!!document.querySelector(${J(launcher)})`), 3000);
    }
    const rosterTitle = await host.evaluate('document.querySelector(".crew-members h3")?.textContent');
    if (!rosterTitle?.includes("Connected replicants")) throw Error("Missing replicant roster");
    const pointer = await host.evaluate("__test.input.pointerLock.state()");
    if (!pointer.cursorNeeded || pointer.locked) throw Error("Crew did not keep the menu cursor");
    await waitFor(() => host.evaluate('!!document.querySelector("[data-give-to]")'), 4000);
    await host.sleep(450);
    await host.shot("coop/connected-crew");
    await host.evaluate('document.querySelector("[data-give-to]").click()');
    const send = await waitFor(() => host.evaluate('!!document.querySelector(".crew-send:not(:disabled)")'), 5000);
    if (!send) throw Error(await host.evaluate('document.querySelector(".coop-settings__expedition")?.innerText'));
    await host.shot("coop/crew-transfer");
    const before = await record(ids.guest);
    await host.evaluate('document.querySelector(".crew-send").click()');
    const delivered = await waitFor(async () => (await record(ids.guest)).receivedFuelKg === before.receivedFuelKg + 1, 5000);
    await host.evaluate('document.querySelector(".crew-back").click()');
    await host.evaluate('document.querySelector(".crew-actions button").click()');
    const marker = await waitFor(() => host.evaluate('document.querySelector(".coop-settings__expedition [role=status]")?.textContent === "Position shared"'), 4000);
    await host.evaluate('document.querySelector(".panel__close").click()');
    return { pass: notices.every(n => n === 1) && sounds.every(Boolean) && !!delivered && !!marker, notices, sounds, delivered, marker };
  }

  async function crewAdmin() {
    for (const page of [host, guest]) await page.evaluate(`document.querySelector('[aria-label="Crew"]').click()`);
    const roster = page => page.evaluate(`[...document.querySelectorAll(".crew-members li")].map(li => ({
      id: li.dataset.crewId, ping: li.querySelector(".crew-ping").textContent, remove: !!li.querySelector('[aria-label^="Remove "]')
    }))`);
    const lists = await Promise.all([host, guest].map(page => waitFor(async () => {
      const rows = await roster(page);
      return rows.length === 2 && rows.every(row => /^\d+ ms$/.test(row.ping)) && rows;
    }, 8000)));
    if (!lists.every(Boolean)) throw Error("Missing live roster or host ping");
    const hostOnly = lists[0].filter(row => row.remove).map(row=>row.id).join() === ids.guest && !lists[1].some(row=>row.remove);
    const remove = () => host.evaluate('document.querySelector(".crew-members button[aria-label]").click()');
    await remove();
    await host.evaluate('document.querySelector(".crew-confirm button").click()');
    const cancelled = (await roster(host)).length === 2 && !(await host.evaluate('!!document.querySelector(".crew-confirm")'));
    await remove();
    await host.evaluate('document.querySelector(".crew-remove").click()');
    const kicked = await waitFor(() => guest.evaluate('document.querySelector("#panel-title")?.textContent === "Removed by the host"'), 8000);
    const freed = await waitFor(async () => (await roster(host)).length === 1, 4000);
    await guest.load({join:code});
    await waitFor(async () => (await guest.evaluate(CARD))?.joinEnabled, 10000);
    await guest.evaluate('document.querySelector("[data-coop-join]").click()');
    const blocked = await waitFor(async () => (await guest.evaluate(CARD))?.refusal === "kicked", 12000);
    await host.evaluate('document.querySelector(".panel__close").click()');
    await host.evaluate(`${C}.close(false)`); await host.load(); await host.ready();
    code = await host.evaluate(`${C}.host()`);
    const returned = (await joinByCard(code)).status.playerId === ids.guest;
    const checks = { hostOnly, cancelled, kicked, freed, blocked, returned };
    return {pass:Object.values(checks).every(Boolean), checks, lists};
  }

  async function exchange() {
    await guest.evaluate(`${C}.meetRemote(0.08)`);
    await guest.sleep(2500);
    await settledCommand(guest, { type: "expedition.mark", name: "Crew rendezvous", sourceId: null });
    const before = await synchronizedSnapshot();
    const give = { type: "expedition.give", kind: "cargo", itemId: "silicates", amount: 1 };
    await settledCommand(host, { ...give, to: ids.guest });
    const received = await synchronizedSnapshot();
    await settledCommand(guest, { ...give, to: ids.host });
    const after = await synchronizedSnapshot();
    const checks = { received: (received.guest.mirror.silicates ?? 0) === (before.guest.mirror.silicates ?? 0) + 1,
      conserved: sameItems(before.host.record, after.host.record) && sameItems(before.guest.record, after.guest.record),
      mirrors: sameItems(after.host.mirror, after.host.record) && sameItems(after.guest.mirror, after.guest.record),
      revision: after.revision === after.clientRevision.host && after.revision === after.clientRevision.guest };
    return { pass: Object.values(checks).every(Boolean), checks };
  }

  async function roughLink() {
    // Impair the live browser data channels. Reliable messages keep order; every 50th pose is lost.
    function install() {
      const original = RTCDataChannel.prototype.send;
      const due = new WeakMap();
      const m = { poses: 0, dropped: 0, scheduled: 0, peakScheduled: 0, peakBuffered: 0, bytes: 0 };
      let sequence = 0;
      RTCDataChannel.prototype.send = function(message) {
        if (this.label !== "pose" && this.label !== "cmd") return original.call(this, message);
        if (this.label === "pose" && ++m.poses % 50 === 0) { m.dropped++; return; }
        const now = performance.now();
        let at = now + 60 + ((++sequence * 17) % 61) - 30;
        if (this.ordered) { at = Math.max(at, due.get(this) ?? 0); due.set(this, at); }
        m.peakScheduled = Math.max(m.peakScheduled, ++m.scheduled);
        setTimeout(() => {
          m.scheduled--;
          if (this.readyState !== "open") return;
          m.bytes += new TextEncoder().encode(message).byteLength;
          original.call(this, message);
          m.peakBuffered = Math.max(m.peakBuffered, this.bufferedAmount);
        }, Math.max(0, at - now));
      };
      window.__endImpairment = () => { RTCDataChannel.prototype.send = original; return m; };
    }
    for (const page of [host, guest]) await page.evaluate("(" + install.toString() + ")()");
    const start = Date.now();
    try {
      const swap = await exchange();
      const ms = Date.now();
      await settledCommand(guest, { type: "expedition.mark", name: "Latency check", sourceId: null });
      const settlementMs = Date.now() - ms;
      await guest.evaluate(`${C}.holdIncoming(2000)`);
      const outageAt = Date.now();
      await settledCommand(guest, { type: "expedition.mark", name: "After outage", sourceId: null });
      const outageSettlementMs = Date.now() - outageAt;
      const during = await exchange();
      // A longer authoritative silence crosses the HUD wait threshold and must reject new spends.
      await guest.evaluate(`${C}.holdIncoming(4500)`);
      const waiting = await waitFor(async () => (await guest.evaluate(`${C}.status()`)).session.waiting, 4200, 100);
      const refused = await guest.evaluate('__test.gameplay.submit({type:"expedition.mark", name:"stale", sourceId:null})');
      const resumed = await waitFor(async () => !(await guest.evaluate(`${C}.status()`)).session.waiting, 4000);
      const routes = await guest.evaluate(`${C}.route()`);
      const age = (await guest.evaluate(`${C}.status()`)).remotes[0]?.ageMs;
      const traffic = await Promise.all([host, guest].map(p => p.evaluate("window.__endImpairment()")));
      const elapsed = Date.now() - start;
      const checks = { conserved: swap.pass && during.pass, waited: !!waiting && !!resumed && outageSettlementMs >= 1950,
        prevented: refused.reason === "host_unavailable", impaired: traffic.every(t => t.dropped > 0) };
      return { pass: Object.values(checks).every(Boolean), checks, route: routes, settlementMs, outageSettlementMs, finalPoseAgeMs: age,
        payloadBytesPerSecond: Math.round(1000 * traffic.reduce((sum,t) => sum + t.bytes,0) / elapsed), traffic };
    } finally {
      for (const page of [host,guest]) await page.evaluate("window.__endImpairment?.(); delete window.__endImpairment; true");
    }
  }

  async function soak() {
    const start = Date.now(), duration = 30 * 60_000;
    let rounds = 0;
    while (Date.now() - start < duration) {
      const round = await exchange();
      if (!round.pass) return { pass: false, rounds, round };
      log({ part: "soak-checkpoint", rounds: ++rounds, elapsedMs: Date.now() - start });
      await host.sleep(Math.min(60_000, Math.max(0, duration - (Date.now() - start))));
    }
    const final = await exchange();
    return { pass: final.pass, rounds, elapsedMs: Date.now() - start, final };
  }

  async function capacity() {
    if (extraGuests.length !== 2) throw new Error("Use --four for the capacity run");
    try {
      const extraIds = [];
      for (const page of extraGuests) {
        await page.load({ title: 1 });
        extraIds.push(await page.evaluate(`__test.networkPilot(${J(code)})`));
      }
      const four = await waitFor(async () => {
        const st = await host.evaluate(`${C}.status()`);
        return st.players === 4 && st.remotes.filter(r => r.ageMs < 5000).length === 3;
      }, 30000);
      const revisions = await waitFor(async () => {
        const values = await Promise.all([host, guest].map(p => p.evaluate(`${C}.status().session.revision`)));
        values.push(...await Promise.all(extraGuests.map(p => p.evaluate("__test.networkRevision()"))));
        return new Set(values).size === 1 && values;
      }, 10000);
      const records = await Promise.all(extraIds.map(record));
      return { pass: !!four && new Set([ids.host, ids.guest, ...extraIds]).size === 4 && !!revisions &&
        records.every(p => p?.stream.outcome?.status === "accepted"), revisions };
    } finally {
      for (const page of extraGuests) await page.load({ title: 1 });
    }
  }

  async function pilotActions() {
    const patch = "consumable_hull_patch_kit";
    const before = await record(ids.host);
    await host.evaluate('__test.gameplay.jettison("silicates", 3)');
    const jettisoned = await waitFor(async () => (await record(ids.host)).cargo.items.silicates === before.cargo.items.silicates - 3, 5000);
    await host.evaluate(`__test.gameplay.craft(${J(patch)})`);
    const crafted = await waitFor(async () => (await record(ids.host)).modules.consumables[patch] === 1, 5000);
    await host.evaluate(`__test.gameplay.assignHotbar(6, ${J(patch)})`);
    const assigned = await waitFor(async () => (await record(ids.host)).modules.hotbar[6] === patch, 5000);
    await host.evaluate("__phys.game.setHealth(60)");
    await host.press("7");
    const used = await waitFor(async () => {
      const p = await record(ids.host);
      return !p.modules.consumables[patch] && p.health >= 75 && p.health < 77;
    }, 5000);
    const checks = { jettisoned, crafted, assigned, used };
    return { pass: Object.values(checks).every(Boolean), checks };
  }

  /** A room closes after preview. A rejected returning pilot then restores its own fixture credential. */
  async function joinLifecycle() {
    const openCard = async () => {
      await guest.load({ join: code });
      if (!await waitFor(async () => (await guest.evaluate(CARD))?.joinEnabled, 15_000)) throw new Error("no join card");
    };
    const click = () => guest.evaluate(`document.querySelector("[data-coop-join]").click(), true`);
    await openCard();
    await host.evaluate(`${C}.close(false)`);
    await click();
    const closed = await waitFor(async () => (await guest.evaluate(CARD))?.refusal === "closed", 10_000);
    await host.load();
    await host.ready();
    const sameCode = code === await host.evaluate(`${C}.host()`);
    await openCard();
    const storage = J("coop-guest:" + worldId);
    await guest.evaluate(`(() => {
      const saved = localStorage.getItem(${storage});
      sessionStorage.setItem("test-guest-backup", saved);
      localStorage.setItem(${storage}, JSON.stringify({ ...JSON.parse(saved), credential: "expired-test-credential" }));
    })()`);
    let credential;
    try {
      await click();
      credential = await waitFor(async () => (await guest.evaluate(CARD))?.refusal === "credential", 30_000);
    } finally {
      await guest.evaluate(`localStorage.setItem(${storage}, sessionStorage.getItem("test-guest-backup")); sessionStorage.removeItem("test-guest-backup"); true`);
    }
    await openCard();
    const j = await joinByCard(code);
    const checks = { closed, sameCode, credential, restored: j.status.playerId === ids.guest };
    return { pass: Object.values(checks).every(Boolean), checks };
  }

  /** Close only the invitation. The live game keeps its authority and accepts a rejoin on a fresh code. */
  async function inviteRenewal() {
    const origin = process.env.COOP_SIGNAL_ORIGIN;
    if (!origin) throw new Error("inviteRenewal needs COOP_SIGNAL_ORIGIN");
    const previous = code;
    const closed = await host.evaluate(`(async () => {
      const key = "coop-owner:" + ${J(origin)} + "/" + ${J(previous)};
      const response = await fetch(${J(origin + "/rooms/" + previous + "/close")}, {
        method: "POST", headers: { Authorization: "Bearer " + localStorage.getItem(key) }
      });
      return response.ok;
    })()`);
    const renewed = await waitFor(async () => {
      const status = await host.evaluate(`${C}.status()`);
      return status.code !== previous && status.detail !== "invites_offline" && status.code;
    }, 30_000);
    if (!renewed) throw new Error("invitation failed to renew");
    code = renewed;
    const live = await guest.evaluate(`${C}.status()`);
    const rejoined = await joinByCard(code);
    const checks = { closed, stayedJoined: live.status === "joined", samePilot: rejoined.status.playerId === ids.guest };
    return { pass: Object.values(checks).every(Boolean), checks };
  }

  /** Direct writes to host-owned slices are inert in a session, on both tabs. */
  async function writeGate() {
    const out = {};
    for (const [role, page, pid] of [["guest", guest, ids.guest], ["host", host, ids.host]]) {
      const before = { mirror: (await page.evaluate(`${C}.mirror()`)).cargo.items, record: (await record(pid)).cargo.items, w: await page.evaluate(`${C}.writes()`) };
      const res = Object.keys(before.mirror)[0] ?? "silicates";
      await page.evaluate(`__dev.grantCargo(${J(res)}, 1)`);
      await page.sleep(500);
      const after = { mirror: (await page.evaluate(`${C}.mirror()`)).cargo.items, record: (await record(pid)).cargo.items, w: await page.evaluate(`${C}.writes()`) };
      out[role] = {
        pass: after.w.inSession && sameItems(after.mirror, before.mirror) && sameItems(after.record, before.record) && after.w.blocked.count > before.w.blocked.count && after.w.blocked.last === "player.cargo",
        resource: res, blocked: after.w.blocked,
      };
    }
    return { pass: out.guest.pass && out.host.pass, ...out };
  }

  /** In a session: no export/reset in Settings → Dev, and a forced flush writes nothing. */
  async function exportHidden() {
    const p0 = Date.now();
    const out = {};
    for (const [role, page] of [["host", host], ["guest", guest]]) {
      const ui = await saveButtons(page);
      const before = await page.evaluate(IDB_RECORD(worldId));
      const w = await page.evaluate(`${C}.writes()`);
      // What export and reset world call first.
      const wrote = await page.evaluate("__test.save.flush(true)");
      await page.sleep(300);
      const after = await page.evaluate(IDB_RECORD(worldId));
      out[role] = { ui, inSession: w.inSession, wrote, before, after };
    }
    const hidden = (u) => u.dev && !u.exportSave && !u.importSave && !u.resetWorld && u.closed;
    const checks = {
      inSession: out.host.inSession && out.guest.inSession,
      buttonsAbsent: hidden(out.host.ui) && hidden(out.guest.ui),
      flushRefused: out.host.wrote === false && out.guest.wrote === false,
      // The host's stored world belongs to its worker: the forced flush left its revision alone.
      hostRecordUnchanged: !!out.host.before && out.host.before.revision === out.host.after?.revision,
      // The guest's mirror is memory only: still nothing stored for the host's world.
      guestNothingStored: out.guest.before === null && out.guest.after === null,
    };
    return { pass: Object.values(checks).every(Boolean), checks, ...out, ms: Date.now() - p0 };
  }

  /** Back while "Joining…" (snapshot held back): title, no session left running, no world stored. */
  async function cancelJoin() {
    const p0 = Date.now();
    const HOLD = 6000;
    await guest.load({ join: code });
    await waitFor(async () => (await host.evaluate(`${C}.status()`)).players === 1, 15_000, 250);
    const card = await waitFor(async () => {
      const k = await guest.evaluate(CARD);
      return k && k.state === "room" && k.joinEnabled ? k : null;
    }, 30_000, 250);
    if (!card) throw new Error(`join card never offered Join: ${J(await guest.evaluate(CARD))}`);
    await guest.evaluate(`window.__coopFault = { joinSnapshotDelayMs: ${HOLD} }; true`);
    await guest.evaluate(`document.querySelector("[data-coop-join]").click(), true`);
    // Link open, welcome/snapshot held: the player sees "Joining…".
    const joining = await waitFor(async () => {
      const a = await guest.evaluate("__test.coopTitle()");
      return a.pendingJoin && a.link ? a : null;
    }, 15_000, 100);
    const label = await guest.evaluate(`document.querySelector("[data-coop-join]")?.textContent.trim() ?? null`);
    await guest.evaluate(`document.querySelector("[data-coop-back]").click(), true`);
    await guest.sleep(300);
    const atBack = await guest.evaluate("__test.coopTitle()");
    // Past the held snapshot: it arrives at a cancelled join and must not boot anything.
    await guest.sleep(HOLD + 1500);
    const later = await guest.evaluate("__test.coopTitle()");
    const phase = await guest.evaluate("__test.app.phase()");
    const cardGone = await guest.evaluate(`!document.querySelector("[data-coop-card]")`);
    const idb = await guest.evaluate(IDB_WORLDS);
    const hostDropped = await waitFor(async () => (await host.evaluate(`${C}.status()`)).players === 1, 15_000, 250);
    const shot = await guest.shot("coop/canceljoin-title");
    const checks = {
      wasJoining: !!joining && label === "Joining…",
      title: phase === "title" && cardGone,
      noSession: !later.pendingJoin && !later.joined && !later.link && later.snapshot.role === "solo",
      nothingSentAfterBack: later.sent === atBack.sent,
      noWorldStored: Array.isArray(idb) && !idb.includes(worldId),
      hostDropped: !!hostDropped,
    };
    // Back in for the parts that follow (a fresh page: the fault is gone).
    const j = await joinByCard(code);
    checks.rejoined = j.status.playerId === ids.guest;
    return { pass: Object.values(checks).every(Boolean), checks, label, atBack, later: { ...later, log: later.log.slice(-6) }, phase, shot, ms: Date.now() - p0 };
  }

  /**
   * Host mines while "open to friends" is still starting (slow worker start): the claim is held in
   * the hand-off window, then granted once by the worker; a guest claim on the same rock is refused.
   */
  async function handoff() {
    const p0 = Date.now();
    const DELAY = 6000;
    await host.evaluate(`${C}.close(false)`);
    await host.load();
    await host.ready();
    const soloUi = await saveButtons(host);
    const r = await pickRock(host, undefined, 4);
    const t = ref(r);
    const key = `${t.fieldId}:${t.chunkKey}:${t.instanceId}`;
    await warpTo(host, r);
    await aim(host, r);
    const predicted = await host.evaluate(`${C}.predict(${J({ ...t, radiusM: r.radiusM })})`);
    const before = await host.evaluate(`${C}.mirror()`);
    await host.evaluate(`window.__coopFault = { hostStartDelayMs: ${DELAY} }; true`);
    const m0 = Date.now();
    await host.press("m");
    // Open to friends 1.5 s before the beam ends: the claim lands inside the hand-off window.
    await host.sleep(Math.max(0, m0 + r.mineS * 1000 - 1500 - Date.now()));
    await host.evaluate(`(window.__handoff = ${C}.host().then((c) => ({ ok: true, c }), (e) => ({ ok: false, e: String(e?.message ?? e) }))), true`);
    await waitFor(async () => !(await host.evaluate(`${R}.mining()`)).mining, 30_000, 100);
    const atBeamEnd = { status: (await host.evaluate(`${C}.status()`)).status, sessionRecord: await session(), beamEndMs: Date.now() - m0 };
    const hosted = await host.evaluate("window.__handoff");
    const settled = await waitFor(async () => (await host.evaluate(`${C}.pending()`)) === null, 30_000);
    await host.frames(10);
    const rec = await record(ids.host);
    const info = await session();
    const mirror = await host.evaluate(`${C}.mirror()`);
    const grant = delta(rec.cargo.items, before.cargo.items);
    // The guest's retry loop finds the room again.
    const back = await waitFor(async () => {
      const [h, g] = [await host.evaluate(`${C}.status()`), await guest.evaluate(`${C}.status()`)];
      return g.status === "joined" && h.remotes.length === 1 ? g : null;
    }, 60_000, 500);
    const guestRock = await guest.evaluate(`${C}.rockState(${J(t)})`);
    // Beside the host (parked at the rock), so the refusal is about the rock being gone, not range.
    await guest.evaluate(`${C}.meetRemote(0.3)`);
    await guest.frames(30);
    await guest.sleep(2500);
    const gBefore = await record(ids.guest);
    await guest.evaluate(`(__test.gameplay.submit(${J({ type: "asteroid.mine", ...t, beamS: r.mineS })}), true)`);
    await waitFor(async () => (await guest.evaluate(`${C}.pending()`)) === null, 20_000, 250);
    const gAfter = await record(ids.guest);
    const guestClaim = gAfter.stream.seq > gBefore.stream.seq ? `${gAfter.stream.outcome?.status}:${gAfter.stream.outcome?.reason ?? ""}` : "no claim";
    const infoAfter = await session();
    const checks = {
      soloShowsExport: soloUi.dev && soloUi.exportSave,
      claimInWindow: atBeamEnd.status === "starting" && atBeamEnd.sessionRecord === null,
      hosted: hosted?.ok === true && hosted.c === code,
      settled: !!settled,
      accepted: rec.stream.outcome?.status === "accepted",
      grantedOnce: sameItems(grant, predicted.solo) && rec.minedLifetime === before.minedLifetime + 1,
      mirrorMatches: sameItems(mirror.cargo.items, rec.cargo.items) && mirror.minedLifetime === rec.minedLifetime,
      oneDepletion: info.destroyed.filter((k) => k === key).length === 1,
      guestRejoined: !!back,
      guestSeesGone: guestRock.destroyed && !guestRock.loaded,
      guestRefused: guestClaim === "rejected:already_done" && sameItems(gAfter.cargo.items, gBefore.cargo.items) && gAfter.minedLifetime === gBefore.minedLifetime,
      stillOneDepletion: infoAfter.destroyed.filter((k) => k === key).length === 1 && infoAfter.revision === info.revision,
    };
    return {
      pass: Object.values(checks).every(Boolean), checks, rock: { ...t, radiusM: r.radiusM, mineS: r.mineS }, atBeamEnd: { status: atBeamEnd.status, beamEndMs: atBeamEnd.beamEndMs },
      hosted, grant, predicted: predicted.solo, minedLifetime: [before.minedLifetime, rec.minedLifetime], guestClaim, soloUi, revision: [info.revision, infoAfter.revision], ms: Date.now() - p0,
    };
  }

  /** Signaling down: hosting fails, the tab stays solo with writes live, a mined rock survives a reload. */
  async function hostFail() {
    const p0 = Date.now();
    await host.evaluate(`${C}.close(false)`);
    await host.load();
    await host.ready();
    await host.evaluate(`${C}.fault("signalingDown")`);
    const attempt = await host.evaluate(`${C}.host().then((c) => ({ ok: true, c }), (e) => ({ ok: false, e: String(e && e.message || e) }))`);
    const st = await host.evaluate(`${C}.status()`);
    const w = await host.evaluate(`${C}.writes()`);
    const r = await pickRock(host);
    const t = ref(r);
    await warpTo(host, r);
    await aim(host, r);
    const before = await host.evaluate(`${C}.mirror()`);
    await host.press("m");
    await waitFor(async () => !(await host.evaluate(`${R}.mining()`)).mining, 30_000);
    const mined = await waitFor(async () => (await host.evaluate(`${C}.rockState(${J(t)})`)).destroyed, 10_000);
    const afterMine = await host.evaluate(`${C}.mirror()`);
    await host.sleep(300);
    await host.load();
    await host.ready();
    const durable = await host.evaluate(`${C}.rockState(${J(t)})`);
    const afterReload = await host.evaluate(`${C}.mirror()`);
    // Hosting again (fault gone with the reload): the guest's retry loop finds the room.
    const code2 = await host.evaluate(`${C}.host()`);
    const back = await waitFor(async () => {
      const [h, g] = [await host.evaluate(`${C}.status()`), await guest.evaluate(`${C}.status()`)];
      return g.status === "joined" && h.remotes.length === 1 ? g : null;
    }, 60_000, 500);
    const grant = delta(afterMine.cargo.items, before.cargo.items);
    const checks = {
      hostingFailed: !attempt.ok,
      stayedSolo: st.role === "solo" && !st.connected && !w.suspended && !w.inSession,
      minedSolo: !!mined && !empty(grant) && afterMine.minedLifetime === before.minedLifetime + 1,
      durable: durable.destroyed && sameItems(afterReload.cargo.items, afterMine.cargo.items) && afterReload.minedLifetime === afterMine.minedLifetime,
      rehosted: code2 === code && !!back,
    };
    return { pass: Object.values(checks).every(Boolean), checks, attempt, status: { role: st.role, status: st.status, detail: st.detail }, writes: w, rock: t, grant, ms: Date.now() - p0 };
  }

  /** Guest leaves: loops stop, nothing more is sent, the mirror is gone, the host drops the pilot. */
  async function leave() {
    const p0 = Date.now();
    await waitFor(async () => (await guest.evaluate(`${C}.status()`)).status === "joined", 30_000, 500);
    if (parts.includes("settingsSpawn")) await menu(host, true);
    const sentBefore = await guest.evaluate(`${C}.sent()`);
    await guest.sleep(1500);
    const live = (await guest.evaluate(`${C}.sent()`)) > sentBefore;
    const res = await guest.evaluate(`${C}.leave(3000)`);
    await waitFor(async () => (await guest.evaluate("__test.app?.phase?.() ?? null").catch(() => null)) === "title", 30_000, 250);
    const phase = await guest.evaluate("__test.app.phase()");
    const idb = await guest.evaluate(IDB_WORLDS);
    const hostGone = await waitFor(async () => {
      const h = await host.evaluate(`${C}.status()`);
      const r = h.remotes.find((x) => x.id === ids.guest);
      return h.players === 1 && (!r || r.ageMs > 3000) ? h : null;
    }, 15_000, 500);
    const hostPausedAgain = parts.includes("settingsSpawn") ? await framesWhilePaused() : true;
    if (parts.includes("settingsSpawn")) await menu(host, false);
    const checks = {
      hostPausedAgain,
      wasSending: live,
      nothingSentAfterLeave: res.after === res.at,
      disconnected: !res.connected && res.role === "solo" && res.remotes === 0,
      mirrorGone: phase === "title" && Array.isArray(idb) && !idb.includes(worldId),
      hostDropped: !!hostGone,
    };
    return { pass: Object.values(checks).every(Boolean), checks, leave: res, phase, ms: Date.now() - p0 };
  }

  try {
    if (process.env.COOP_SIGNAL_ORIGIN || process.env.COOP_TEST_TURN_URL || process.env.COOP_FORCE_RELAY) {
      const ice = process.env.COOP_TEST_TURN_URL ? { iceTransportPolicy: "relay", iceServers: [{
        urls: process.env.COOP_TEST_TURN_URL, username: process.env.COOP_TEST_TURN_USER, credential: process.env.COOP_TEST_TURN_PASSWORD,
      }] } : null;
      const source = `window.__coopTestSignalOrigin = ${J(process.env.COOP_SIGNAL_ORIGIN ?? null)}; window.__coopTestIce = ${J(ice)}; window.__coopForceRelay = ${process.env.COOP_FORCE_RELAY === "1"};`;
      for (const page of [host, guest]) await page.send("Page.addScriptToEvaluateOnNewDocument", { source });
    }
    // ── setup: fresh disposable world on the host, guest joins by code ──
    const s0 = Date.now();
    await host.load();
    await host.ready();
    prevWorld = await host.evaluate(`${C}.worldId()`);
    worldId = await host.evaluate(`__test.gameplay.fixtures.create("coop", "new")`);
    await host.evaluate(`__test.gameplay.fixtures.activate(${J(worldId)})`);
    await host.load();
    await host.ready();
    if ((await host.evaluate(`${C}.worldId()`)) !== worldId) throw new Error("fixture world did not boot");
    if (parts.includes("industry")) {
      const { stockConstructionShip } = await import("./industry-coop.mjs");
      await stockConstructionShip(host);
    }
    await host.evaluate(`${C}.name(${J(HOST_NAME)})`);
    if (parts.some(p => ["pilotActions", "soak", "exchange", "roughLink"].includes(p))) await host.evaluate('__dev.grantCargo("fe_ni_metal", 20); __dev.grantCargo("silicates", 20); true');
    if (parts.includes("crewUi")) {
      await host.evaluate(`(() => {
        const sources = ["s_type","c_type","x_type"].map((classId,i) => ({ id: "origin_belt:0,0,0:"+i,
          fieldId:"origin_belt",chunkKey:"0,0,0",asteroidId:i,classId,frameId:"earth",positionKm:[0,0,0],
          radiusM:10,composition:{},depleted:false,foundAt:1,by:__test.gameplay.localId() }));
        __test.gameplay.m33.devSetWorld({discoveries:{sources,families:{},sites:{},trials:{}}});
        __dev.grantCargo("silicates",20);
        __test.gameplay.res.set({ordinaryKg:100});
      })()`);
    }
    if (parts.includes("settingsSpawn")) {
      await menu(host, true);
      pauseChecks.soloPaused = await framesWhilePaused();
    }
    code = await host.evaluate(`${C}.host()`);
    if (parts.includes("settingsSpawn")) pauseChecks.hostAlonePaused = await framesWhilePaused();
    await guest.load({ title: 1 });
    await guest.evaluate(`localStorage.setItem("coop-name", ${J(GUEST_NAME)}); true`);
    await joinByCard(code);
    const joined = await waitFor(async () => {
      const [h, g] = [await host.evaluate(`${C}.status()`), await guest.evaluate(`${C}.status()`)];
      return g.status === "joined" && h.remotes.length === 1 && g.remotes.length === 1 ? { h, g } : null;
    }, 60_000, 500);
    if (!joined) throw new Error(`guest never joined: ${J(await guest.evaluate(`${C}.log()`))}`);
    const route = await waitFor(() => guest.evaluate(`${C}.route()`), 5000);
    if (!route || ((process.env.COOP_TEST_TURN_URL || process.env.COOP_FORCE_RELAY === "1") && route !== "relay")) throw new Error("Unexpected ICE route: " + route);
    ids.host = joined.h.playerId;
    ids.guest = joined.g.playerId;
    log({ part: "setup", ok: true, worldId, code, ids, route, ms: Date.now() - s0 });

    const run = {
      shipLods: async () => {
        const samples = [];
        // Start close, cross both thresholds, then return through the hysteresis.
        for (const [distKm, level] of [[0.06, 0], [0.14, 1], [0.30, 2], [0.06, 0]]) {
          const warped = await guest.evaluate(`${C}.meetRemote(${distKm})`);
          if (!warped) return { pass: false, samples };
          await guest.frames(8);
          const actual = await waitFor(async () => {
            const levels = await guest.evaluate(`${C}.shipLods()`);
            return levels.length === 1 && levels[0] === level ? levels : null;
          }, 10_000, 150);
          samples.push({ distKm, level, actual, shot: await guest.canvas(`survey-remote-${level}`) });
          if (!actual) return { pass: false, samples };
        }
        return { pass: true, samples };
      },
      shipMenu, crewUi, crewAdmin, exchange, soak, capacity, contentFixture, roughLink,
      industry: async () => {
        const { supplyRoute } = await import("./industry-coop.mjs");
        return supplyRoute({ host, guest, code, worldId, settledCommand, waitFor });
      },
      settingsSpawn,
      presence,
      jitter,
      race: () => race("host", "race"),
      raceRev: () => race("guest", "raceRev"),
      dropReply,
      restart,
      lunar,
      joinCard,
      reloadPose,
      lateName,
      remoteFx,
      crash,
      pilotContact: async () => {
        const { pilotContactGate } = await import("./m5-physics.mjs");
        return pilotContactGate({ host, guest });
      },
      pilotMarker,
      rename,
      pilotActions,
      joinLifecycle,
      inviteRenewal,
      writeGate,
      exportHidden,
      cancelJoin,
      handoff,
      hostFail,
      leave,
    };
    for (const p of parts) {
      if (!run[p]) throw new Error(`unknown part ${p}`);
      try {
        results[p] = await run[p]();
      } catch (e) {
        results[p] = { pass: false, error: String(e.message ?? e).split("\n")[0], guestLog: (await guest.evaluate(`${C}.log()`).catch(() => [])).slice(-12) };
      }
      log({ part: p, ...results[p] });
    }
  } finally {
    // ── cleanup: close hosting, boot the previous world, delete the fixture ──
    let removed = false;
    try {
      if (worldId) {
        await host.evaluate(`${C}.close(false)`).catch(() => {});
        await guest.evaluate(`localStorage.removeItem(${J(`coop-guest:${worldId}`)}); true`).catch(() => {});
        await host.evaluate(`localStorage.removeItem(${J(`coop-room:${worldId}`)}); true`).catch(() => {});
        if (prevWorld && prevWorld !== worldId) await host.evaluate(`__test.gameplay.fixtures.activate(${J(prevWorld)})`);
        await host.load();
        await host.ready();
        removed = await host.evaluate(`__test.gameplay.fixtures.remove(${J(worldId)})`);
      }
    } catch (e) {
      log({ part: "cleanup", ok: false, error: String(e.message ?? e).split("\n")[0] });
    }
    log({ part: "cleanup", worldRemoved: removed });
  }
  const renderErrors = pipelineErrors(host, guest);
  const pass = parts.every((p) => results[p]?.pass) && renderErrors.length === 0;
  return { pass, renderErrors, parts: Object.fromEntries(parts.map((p) => [p, !!results[p]?.pass])), ms: Date.now() - t0 };
}
