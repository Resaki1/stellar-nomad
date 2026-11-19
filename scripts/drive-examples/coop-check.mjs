/**
 * M4.0 exit gate in two real browsers (docs/M4_COOP_PLAN.md §1). Run with drive-coop.mjs:
 *   COOP_PARTS=presence,race,raceRev,dropReply,restart,lunar,joinCard,reloadPose,lateName,writeGate,exportHidden,cancelJoin,handoff,hostFail,leave \
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
/** The co-op pill's box against every other top-of-screen HUD region: overlaps must be empty. */
const PILL_LAYOUT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" ? r : null; };
  const pill = document.querySelector(".coop-pill");
  const p = pill && vis(pill);
  if (!p) return { pill: null, overlaps: [] };
  const sel = [".hud__panel-btn", ".objective-tracker", ".settings__open-button", ".notif-stack__item", ".hint-strip", ".coop-marker"];
  const overlaps = [];
  for (const s of sel) for (const el of document.querySelectorAll(s)) {
    const r = vis(el);
    if (r && r.left < p.right && p.left < r.right && r.top < p.bottom && p.top < r.bottom) overlaps.push(s);
  }
  const box = (r) => r && [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  const t = document.querySelector(".objective-tracker");
  return { pill: box(p), tracker: t ? box(vis(t)) : null, trackerText: t?.textContent.trim().slice(0, 40) ?? null, overlaps };
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

export default async function coopCheck({ host, guest, log }) {
  const parts = (process.env.COOP_PARTS ?? "presence,race,raceRev,dropReply,restart,lunar,joinCard,reloadPose,lateName,writeGate,exportHidden,cancelJoin,handoff,hostFail,leave").split(",");
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
  async function joinByCard(c = code) {
    const t0 = Date.now();
    await guest.load({ join: c });
    const card = await waitFor(async () => {
      const k = await guest.evaluate(CARD);
      return k && k.state === "room" && k.joinEnabled ? k : null;
    }, 30_000, 250);
    if (!card) throw new Error(`join card never offered Join: ${J(await guest.evaluate(CARD))}`);
    const clicked = Date.now();
    await guest.evaluate(`document.querySelector("[data-coop-join]").click(), true`);
    await guest.ready();
    const ready = Date.now();
    const st = await waitFor(async () => {
      const g = await guest.evaluate(`${C}.status()`);
      return g.status === "joined" ? g : null;
    }, 30_000, 250);
    if (!st) throw new Error(`guest never joined: ${J(await guest.evaluate(`${C}.log()`))}`);
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

  /** Direct writes to host-owned slices are inert in a session, on both tabs. */
  async function writeGate() {
    const out = {};
    for (const [role, page, pid] of [["guest", guest, ids.guest], ["host", host, ids.host]]) {
      const before = { mirror: (await page.evaluate(`${C}.mirror()`)).cargo.items, record: (await record(pid)).cargo.items, w: await page.evaluate(`${C}.writes()`) };
      const res = Object.keys(before.mirror)[0] ?? "silicates";
      await page.evaluate(`__test.gameplay.jettison(${J(res)}, 1)`);
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
    const checks = {
      wasSending: live,
      nothingSentAfterLeave: res.after === res.at,
      disconnected: !res.connected && res.role === "solo" && res.remotes === 0,
      mirrorGone: phase === "title" && Array.isArray(idb) && !idb.includes(worldId),
      hostDropped: !!hostGone,
    };
    return { pass: Object.values(checks).every(Boolean), checks, leave: res, phase, ms: Date.now() - p0 };
  }

  try {
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
    await host.evaluate(`${C}.name(${J(HOST_NAME)})`);
    code = await host.evaluate(`${C}.host()`);
    await guest.load({ title: 1 });
    await guest.evaluate(`localStorage.setItem("coop-name", ${J(GUEST_NAME)}); true`);
    await joinByCard(code);
    const joined = await waitFor(async () => {
      const [h, g] = [await host.evaluate(`${C}.status()`), await guest.evaluate(`${C}.status()`)];
      return g.status === "joined" && h.remotes.length === 1 && g.remotes.length === 1 ? { h, g } : null;
    }, 60_000, 500);
    if (!joined) throw new Error(`guest never joined: ${J(await guest.evaluate(`${C}.log()`))}`);
    ids.host = joined.h.playerId;
    ids.guest = joined.g.playerId;
    log({ part: "setup", ok: true, worldId, code, ids, ms: Date.now() - s0 });

    const run = {
      presence,
      race: () => race("host", "race"),
      raceRev: () => race("guest", "raceRev"),
      dropReply,
      restart,
      lunar,
      joinCard,
      reloadPose,
      lateName,
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
  const pass = parts.every((p) => results[p]?.pass);
  return { pass, parts: Object.fromEntries(parts.map((p) => [p, !!results[p]?.pass])), ms: Date.now() - t0 };
}
