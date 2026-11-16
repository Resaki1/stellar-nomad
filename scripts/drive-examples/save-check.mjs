/**
 * Save exit gates (M0.3; schema-2 expectations since M3.1) (ROADMAP M0.3) for scripts/drive.mjs. Needs --no-isolate (gameplay and
 * saving live); split parts to stay under a couple of minutes per run:
 *
 *   SAVE_PARTS=fresh,legacy pnpm drive -- --keep --no-isolate run:scripts/drive-examples/save-check.mjs
 *   SAVE_PARTS=roundtrip,reload,isolation pnpm drive -- --keep --no-isolate run:…
 *
 * Parts: fresh (a), legacy (b), roundtrip (c), reload (d), isolation (f).
 */
const IDB = `(async () => {
  const db = await new Promise((res, rej) => { const q = indexedDB.open("stellar-nomad"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const all = (s) => new Promise((res) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); });
  const keys = (s) => new Promise((res) => { const q = db.transaction(s).objectStore(s).getAllKeys(); q.onsuccess = () => res(q.result); });
  const out = { meta: await all("worldMeta"), dataKeys: await keys("worldData"), data: await all("worldData") };
  db.close();
  return out;
})()`;

const LEGACY_KEYS = [
  "cargo", "research-v1", "modules-v2", "modules-v1", "ship-config-v1", "ship-state-v1", "death-v1",
  "asteroid-deltas-v1", "asteroids-mined-lifetime-v1", "comms-played-v1", "star-markers-v1", "ai-name-v1",
];

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const close = (a, b, tol) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** Deep diff paths (first 10), for a readable failure. */
function diff(a, b, path = "", out = []) {
  if (out.length >= 10) return out;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || a === null || b === null || typeof a !== "object") {
    if (!eq(a, b)) out.push(`${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`);
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${path}.${k}`, out);
  return out;
}

export default async function saveCheck(d) {
  const ev = (js) => d.evaluate(js);
  const wait = (ms) => ev(`new Promise(r => setTimeout(r, ${ms}))`);
  const parts = (process.env.SAVE_PARTS ?? "fresh,legacy,roundtrip,reload,isolation").split(",");
  const out = {};
  const pid = () => ev("localStorage.getItem('player-id-v1')");
  const player = async () => (await ev("__test.save.data()")).players[await pid()];
  const reload = async () => {
    await d.reload();
    await d.frames(5);
  };
  /** Wait for a loaded asteroid near the ship (chunks stream in after load). */
  const nearest = async (n = 3) => {
    for (let i = 0; i < 40; i++) {
      const a = await ev(`__test.world.asteroidsNearShip(${n})`);
      if (a.length >= n) return a;
      await wait(250);
    }
    throw new Error("no asteroids loaded near the ship");
  };
  const waitChunk = async (a) => {
    for (let i = 0; i < 40; i++) {
      const r = await ev(`__test.world.instanceLoaded(${JSON.stringify(a.fieldId)}, ${JSON.stringify(a.chunkKey)}, ${a.instanceId})`);
      if (r !== null) return r;
      await wait(250);
    }
    return null;
  };

  if (parts.includes("fresh")) {
    // Wipe everything, then boot as a first-time player.
    await ev("__test.isolate(true)");
    await ev(`new Promise(r => { const q = indexedDB.deleteDatabase("stellar-nomad"); q.onsuccess = q.onerror = q.onblocked = () => r(); })`);
    await ev(`(${JSON.stringify(LEGACY_KEYS)}).forEach(k => localStorage.removeItem(k)), localStorage.removeItem("last-world-id")`);
    await reload();
    const info = await ev("__test.save.info()");
    const db = await ev(IDB);
    out.fresh = {
      info,
      worlds: db.meta.map((m) => m.name),
      pass: info.name === "World 1" && db.meta.length === 1 && db.meta[0].id === info.id && db.dataKeys[0] === info.id,
    };
  }

  if (parts.includes("legacy")) {
    const frames = (await ev("__test.frameList()")).map((f) => f.id);
    const frameId = frames.includes("earth") ? "earth" : frames[0];
    const hotbar = Array(10).fill(null);
    const legacy = {
      cargo: { capacityUnits: 2000, items: { fe_ni_metal: 42, silicates: 7 } },
      "research-v1": { assaySamples: 13, completedNodes: ["r0_microlab_boot"], activeResearch: null },
      "modules-v1": { ownedModules: ["module_cargo_rack_mk1"], consumables: { consumable_hull_patch_kit: 2 }, consumableCooldowns: {}, hotbar },
      "ship-config-v1": { maxHealth: 120 },
      "ship-state-v1": { version: 2, frameId, positionKm: [7000.5, 10.25, -20.125], quaternion: [0, 0.6, 0, 0.8] },
      "death-v1": { isDead: false, wrecks: [{ id: "wreck-legacy-1", frameId, positionKm: [7100, 1, 2], items: { fe_ni_metal: 5 }, createdAt: 123 }] },
      "asteroid-deltas-v1": { version: 1, fields: { legacy_field: { destroyed: [111, 222, 333] } } },
      "asteroids-mined-lifetime-v1": 4,
      "comms-played-v1": ["ai_greeting_001", "ai_intro_001"],
      "star-markers-v1": ["proxima"],
      "ai-name-v1": "HAL",
    };
    await ev("__test.isolate(true)"); // no pagehide flush may recreate the DB we delete
    await ev(`new Promise(r => { const q = indexedDB.deleteDatabase("stellar-nomad"); q.onsuccess = q.onerror = q.onblocked = () => r(); })`);
    await ev(`Object.entries(${JSON.stringify(legacy)}).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v)))`);
    await reload();
    const data = await ev("__test.save.data()");
    const p = data.players[await pid()];
    const keysLeft = await ev(`(${JSON.stringify(LEGACY_KEYS)}).filter(k => localStorage.getItem(k) !== null)`);
    const info1 = await ev("__test.save.info()");
    const worldsAfterImport = (await ev(IDB)).meta.map((m) => m.name);
    const checks = {
      cargo: eq(p.cargo, legacy.cargo),
      // Schema 2: completions are world-owned; assay samples and the timer stay with the player.
      research: eq(p.research, { assaySamples: 13, activeResearch: null }) && eq(data.world.research.completedNodes, ["r0_microlab_boot"]),
      tanksFull: p.propellant.ordinaryKg > 0 && p.propellant.protectedKg > 0 && p.processing === null,
      modulesOwned: eq(p.modules.ownedModules, ["module_cargo_rack_mk1"]),
      modulesAutoEquipped: p.modules.equippedModules.cargo === "module_cargo_rack_mk1",
      consumables: eq(p.modules.consumables, { consumable_hull_patch_kit: 2 }),
      shipConfigMaxHealth: p.shipConfig.maxHealth === 120 && p.shipConfig.speedMult === 1,
      shipPose: p.ship && p.ship.frameId === frameId &&
        close(p.ship.positionKm, legacy["ship-state-v1"].positionKm, 1e-9) &&
        close(p.ship.quaternion, legacy["ship-state-v1"].quaternion, 1e-9),
      wreck: eq(data.world.wrecks, legacy["death-v1"].wrecks.map(({ id, frameId, positionKm, items, createdAt }) => ({ id, frameId, positionKm, items, fuelKg: 0, consumables: {}, createdAt }))),
      deltas: eq(data.world.asteroidDeltas, { legacy_field: { unchunked: [111, 222, 333] } }),
      minedLifetime: p.minedLifetime === 4,
      comms: eq(p.commsPlayed, legacy["comms-played-v1"]),
      starMarkers: eq(p.starMarkers, ["proxima"]),
      aiName: p.aiName === "HAL",
      legacyKeysRemoved: keysLeft.length === 0,
    };
    await reload();
    const keysAfterSecondReload = await ev(`(${JSON.stringify(LEGACY_KEYS)}).filter(k => localStorage.getItem(k) !== null)`);
    const db2 = await ev(IDB);
    const info2 = await ev("__test.save.info()");
    checks.noSecondImport = db2.meta.length === 1 && info2.id === info1.id;
    out.legacy = { checks, keysLeft, worldsAfterImport, keysAfterSecondReload, worldsAfterSecondReload: db2.meta.map((m) => m.name), ids: [info1.id, info2.id], pass: Object.values(checks).every(Boolean) };
  }

  if (parts.includes("roundtrip")) {
    await ev("__test.isolate(false)");
    await d.scene("belt");
    await d.frames(30);
    const [a] = await nearest(1);
    const epoch = Date.UTC(2031, 6, 4, 12, 0, 0);
    await ev(`__dev.grantCargo("fe_ni_metal", 77)`);
    await ev(`__dev.grantAssay(9)`);
    await ev(`__dev.unlockAll()`);
    const destroyed = await ev(`__test.world.submit(${JSON.stringify({ type: "asteroid.destroy", fieldId: a.fieldId, chunkKey: a.chunkKey, instanceId: a.instanceId, cause: "mined" })})`);
    await ev(`__test.world.submit({ type: "time.set", epochMs: ${epoch}, rate: 0 })`);
    await d.scene("luna:500");
    await d.frames(20);
    const json = await ev("__test.save.export()");
    const snap = JSON.parse(json).data;
    await ev("__test.save.reset()");
    await reload();
    const fresh = await ev("__test.save.data()");
    const fp = fresh.players[await pid()];
    const defaults = {
      cargoEmpty: Object.keys(fp.cargo.items).length === 0,
      researchEmpty: fresh.world.research.completedNodes.length === 0 && fresh.world.receipts.length === 0,
      deltasEmpty: Object.keys(fresh.world.asteroidDeltas).length === 0,
      epochDefault: fresh.world.simEpochMs !== epoch,
    };
    const newId = await ev(`__test.save.importAndActivate(${JSON.stringify(json)})`);
    await reload();
    await ev("__test.save.flush()");
    const info = await ev("__test.save.info()");
    const db = await ev(IDB);
    const stored = db.data[db.dataKeys.indexOf(newId)];
    const mem = await ev("__test.save.data()");
    // The ship keeps flying at its residual speed after load: compare its position separately.
    const id = await pid();
    const posDeltaM = (x) => Math.hypot(...x.players[id].ship.positionKm.map((v, i) => v - snap.players[id].ship.positionKm[i])) * 1000;
    const strip = (x) => {
      const c = structuredClone(x);
      c.players[id].ship.positionKm = null;
      return c;
    };
    out.roundtrip = {
      destroyed,
      defaults,
      activeIsImported: info.id === newId,
      diffStored: diff(strip(stored), strip(snap)),
      diffMemory: diff(strip(mem), strip(snap)),
      shipDriftM: { stored: +posDeltaM(stored).toFixed(2), memory: +posDeltaM(mem).toFixed(2) },
      pass: destroyed && Object.values(defaults).every(Boolean) && info.id === newId &&
        eq(strip(stored), strip(snap)) && eq(strip(mem), strip(snap)) && posDeltaM(stored) < 200,
    };
  }

  if (parts.includes("reload")) {
    await ev("__test.isolate(false)");
    await d.scene("belt");
    await d.frames(30);
    const [a] = await nearest(1);
    const epoch = Date.UTC(2030, 0, 1, 0, 0, 0);
    const ok = await ev(`__test.world.submit(${JSON.stringify({ type: "asteroid.destroy", fieldId: a.fieldId, chunkKey: a.chunkKey, instanceId: a.instanceId, cause: "collision" })})`);
    const goneBefore = (await waitChunk(a)) === false;
    await ev(`__test.world.submit({ type: "time.set", epochMs: ${epoch}, rate: 1 })`);
    await d.frames(10);
    await ev("__test.save.flush()");
    const t0 = Date.now();
    // No frames wait: read the record the old page flushed at pagehide before this page's
    // first flush (≥ 3 s after boot), and the ship is at rest after load (throttle 0, sim frozen behind the loading gate).
    await d.reload();
    await d.frames(2);
    const s1 = (await d.state()).ship;
    const rec = await ev(IDB);
    const id = await pid();
    const info = await ev("__test.save.info()");
    const saved = rec.data[rec.dataKeys.indexOf(info.id)];
    const pose = saved.players[id].ship;
    const gone = await waitChunk(a);
    const elapsedS = (Date.now() - t0) / 1000;
    out.reload = {
      asteroid: a,
      accepted: ok,
      goneBefore,
      presentAfterReload: gone,
      savedFrame: pose.frameId,
      shipFrame: s1.frameId,
      shipStepsSinceLoad: s1.steps,
      spawnVsSavedM: +(Math.hypot(...pose.positionKm.map((v, i) => v - s1.relPosKm[i])) * 1000).toFixed(3),
      quatDelta: Math.max(...pose.quaternion.map((v, i) => Math.abs(v - s1.quat[i]))),
      savedEpochMinusSet_s: (saved.world.simEpochMs - epoch) / 1000,
      wallElapsed_s: +elapsedS.toFixed(1),
    };
    out.reload.pass = ok && goneBefore && gone === false && pose.frameId === s1.frameId &&
      out.reload.spawnVsSavedM < Math.max(1, s1.steps) * 1.0 && // ≤ 1 m/step: accelerating from rest
      out.reload.quatDelta < 1e-6 &&
      saved.world.simEpochMs >= epoch && saved.world.simEpochMs - epoch < 120_000;
  }

  if (parts.includes("isolation")) {
    await ev("__test.isolate(false)");
    await d.frames(10);
    await ev("__test.save.flush()");
    await ev("__test.isolate(true)");
    const i0 = await ev("__test.save.info()");
    const db0 = await ev(IDB);
    const s0 = (await d.state()).ship;
    await d.hold("w", 2000);
    await wait(3000);
    const s1 = (await d.state()).ship;
    const i1 = await ev("__test.save.info()");
    const db1 = await ev(IDB);
    await d.hold("s", 2500);
    await ev("__test.isolate(false)");
    out.isolation = {
      movedKm: s0.frameId === s1.frameId ? Math.hypot(...s1.relPosKm.map((v, i) => v - s0.relPosKm[i])) : null,
      frames: [s0.frameId, s1.frameId],
      lastFlushedAt: [i0.lastFlushedAt, i1.lastFlushedAt],
      idbUnchanged: eq(db0, db1),
      pass: i0.lastFlushedAt === i1.lastFlushedAt && eq(db0, db1),
    };
  }

  // Leave a default world behind: other drive scripts' baselines assume un-upgraded stats.
  await ev("__test.save.reset()");
  await d.reload();
  return out;
}
