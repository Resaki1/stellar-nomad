/**
 * M3.1 gates: migration, transactions, shared vs private, live loop. Needs --no-isolate.
 * Works only in disposable "[gc] " fixture worlds it creates, then reboots the world that was
 * active before and deletes its fixtures.
 *
 *   GAME_PARTS=migrate,tx,shared pnpm drive -- --keep --no-isolate run:scripts/drive-examples/gameplay-check.mjs
 *   GAME_PARTS=live pnpm drive -- --keep --no-isolate run:scripts/drive-examples/gameplay-check.mjs
 *   GAME_PARTS=res,m32,reach,shots   M3.2 ship-resource gates (gameplay-m32.mjs)
 *   GAME_PARTS=transit,transitLive,transitShots   M3.5 transit gates (gameplay-transit.mjs); transitNarrow with --size 390x844
 *   GAME_PARTS=audit,fit,evidence,reqs,config,migrate3 / playA / playB / m33shots   M3.3+M3.4 gates (gameplay-m33.mjs); m33narrow with --size 390x844
 *   GAME_PARTS=place,activate,death,recover,salvage,migrate4 / live36 / m36shots   M3.6 gates (gameplay-m36.mjs); m36narrow with --size 390x844
 */
import { m32Gates, reachGates, resGates, shotGates } from "./gameplay-m32.mjs";
import { transitLiveGates, transitPureGates, transitShotGates } from "./gameplay-transit.mjs";
import { activateGates, deathGates, live36Gates, m36ShotGates, migrate4Gates, placeGates, recoverGates, salvageGates } from "./gameplay-m36.mjs";
import { auditGates, configGates, fitGates, evidenceGates, m33ShotGates, migrate3Gates, playGates, reqGates } from "./gameplay-m33.mjs";
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** JSON with NaN/±Infinity kept as JS literals, for malformed fixtures. */
function js(v) {
  return JSON.stringify(v, (_k, x) => (typeof x === "number" && !Number.isFinite(x) ? `__${x}__` : x))
    .replace(/"__NaN__"/g, "NaN")
    .replace(/"__Infinity__"/g, "Infinity")
    .replace(/"__-Infinity__"/g, "-Infinity");
}

const HOTBAR = Array(10).fill(null);
const v1Player = (o = {}) => ({
  ship: null,
  health: 100,
  isDead: false,
  cargo: { capacityUnits: 2000, items: {} },
  research: { assaySamples: 0, completedNodes: [], activeResearch: null },
  modules: { ownedModules: [], equippedModules: {}, consumables: {}, consumableCooldowns: {}, hotbar: HOTBAR },
  shipConfig: { maxHealth: 100 },
  aiName: null,
  commsPlayed: [],
  starMarkers: [],
  minedLifetime: 0,
  ...o,
});
const v1World = (o = {}) => ({ simEpochMs: Date.UTC(2031, 2, 1), simRate: 1, asteroidDeltas: {}, wrecks: [], ...o });
const v1 = (players, world = {}) => ({ schemaVersion: 1, world: v1World(world), players });


export default async function gameplayCheck(d) {
  const ev = (src) => d.evaluate(src);
  const wait = (ms) => ev(`new Promise(r => setTimeout(r, ${ms}))`);
  const parts = (process.env.GAME_PARTS ?? "migrate,tx,shared").split(",");
  const out = {};
  const G = "__test.gameplay";
  const me = await ev(`${G}.localId()`);
  const original = (await ev("__test.save.info()")).id;
  const frames = (await ev("__test.frameList()")).map((f) => f.id);
  const moonFrame = frames.includes("luna") ? "luna" : frames.find((f) => f !== "earth" && f !== "sol") ?? "earth";
  const submit = (op, by) => ev(`${G}.submit(${js(op)}${by ? `, ${JSON.stringify(by)}` : ""})`);
  const player = (id) => ev(`${G}.player(${id ? JSON.stringify(id) : ""})`);
  const world = () => ev(`${G}.world()`);
  const idb = (id) =>
    ev(`(async () => {
      const db = await new Promise((res, rej) => { const q = indexedDB.open("stellar-nomad"); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const r = await new Promise((res) => { const q = db.transaction("worldData").objectStore("worldData").get(${JSON.stringify(id)}); q.onsuccess = () => res(q.result); });
      db.close();
      return r;
    })()`);
  /** Boot `id` and wait until it is the active world. */
  const boot = async (id) => {
    await ev(`${G}.fixtures.activate(${JSON.stringify(id)})`);
    await d.reload();
    await d.frames(10);
    const now = (await ev("__test.save.info()")).id;
    if (now !== id) throw new Error(`boot ${id} → ${now}`);
  };
  /** Mirrors must equal the save after every operation. */
  const mirrorsMatch = async () => {
    const m = await ev(`${G}.mirrors()`);
    const p = await player();
    const w = await world();
    return eq(m.cargo, p.cargo) && eq(m.discoveries, w.discoveries) && eq(m.bookmarks, p.bookmarks) && eq(m.modules, p.modules) && m.isDead === p.isDead &&
      m.health === p.health && m.minedLifetime === p.minedLifetime && eq(m.completedNodes, w.research.completedNodes) && eq(m.wrecks, w.wrecks);
  };
  const created = [];
  const fixture = async (name, data) => {
    const id = await ev(`${G}.fixtures.create(${JSON.stringify(name)}, ${js(data)})`);
    created.push(id);
    return id;
  };

  const ctx = { ev, wait, player, world, submit, idb, boot, fixture, me, v1, v1Player, v1World, created };
  try {
    if (parts.includes("audit")) out.audit = await auditGates(d, ctx);
    if (parts.includes("fit")) out.fit = await fitGates(d, ctx);
    if (parts.includes("evidence")) out.evidence = await evidenceGates(d, ctx);
    if (parts.includes("reqs")) out.reqs = await reqGates(d, ctx);
    if (parts.includes("config")) out.config = await configGates(d, ctx);
    if (parts.includes("migrate3")) out.migrate3 = await migrate3Gates(d, ctx);
    if (parts.includes("playA")) out.playA = await playGates(d, ctx, "A");
    if (parts.includes("playB")) out.playB = await playGates(d, ctx, "B");
    if (parts.includes("m33shots") || parts.includes("m33narrow")) out.m33shots = await m33ShotGates(d, ctx, parts.includes("m33narrow"));
    if (parts.includes("place")) out.place = await placeGates(d, ctx);
    if (parts.includes("activate")) out.activate = await activateGates(d, ctx);
    if (parts.includes("death")) out.death = await deathGates(d, ctx);
    if (parts.includes("recover")) out.recover = await recoverGates(d, ctx);
    if (parts.includes("salvage")) out.salvage = await salvageGates(d, ctx);
    if (parts.includes("migrate4")) out.migrate4 = await migrate4Gates(d, ctx);
    if (parts.includes("live36")) out.live36 = await live36Gates(d, ctx);
    if (parts.includes("m36shots") || parts.includes("m36narrow")) out.m36shots = await m36ShotGates(d, ctx, parts.includes("m36narrow"));
    if (parts.includes("res")) out.res = await resGates(d);
    if (parts.includes("transit")) out.transit = await transitPureGates(d);
    if (parts.includes("transitLive")) out.transitLive = await transitLiveGates(d, ctx);
    if (parts.includes("transitShots") || parts.includes("transitNarrow")) out.transitShots = await transitShotGates(d, ctx, parts.includes("transitNarrow"));
    if (parts.includes("m32")) out.m32 = await m32Gates(d, ctx);
    if (parts.includes("reach")) out.reach = await reachGates(d, ctx);
    if (parts.includes("shots") || parts.includes("narrow")) out.shots = await shotGates(d, ctx, parts.includes("narrow"));
    if (parts.includes("migrate")) {
      const pose = { frameId: "earth", positionKm: [7012.5, -3.25, 120.125], quaternion: [0, 0.6, 0, 0.8] };
      const moonPose = { frameId: moonFrame, positionKm: [2100.75, 15.5, -8.25], quaternion: [0, 0, 0, 1] };
      const legacyWreck = { id: "wreck-legacy-1", frameId: "earth", positionKm: [7100, 1, 2], items: { fe_ni_metal: 5 }, createdAt: 123 };
      const fx = {
        single: v1({
          [me]: v1Player({
            ship: pose, cargo: { capacityUnits: 2000, items: { fe_ni_metal: 42, silicates: 7 } },
            research: { assaySamples: 4, completedNodes: ["r0_microlab_boot"], activeResearch: null },
            modules: { ownedModules: ["module_cargo_rack_mk1"], equippedModules: { cargo: "module_cargo_rack_mk1" }, consumables: { consumable_hull_patch_kit: 2 }, consumableCooldowns: {}, hotbar: HOTBAR },
            aiName: "HAL", commsPlayed: ["ai_greeting_001"], starMarkers: ["proxima"], minedLifetime: 9,
          }),
        }, { asteroidDeltas: { origin_belt: { "1,2,3": [11, 12], unchunked: [99] } } }),
        twoPlayers: v1({
          [me]: v1Player({ research: { assaySamples: 1, completedNodes: ["r0_microlab_boot", "a1_sensor_calibration"], activeResearch: null }, cargo: { capacityUnits: 2000, items: { carbon: 3 } } }),
          "player-b": v1Player({ research: { assaySamples: 2, completedNodes: ["r0_microlab_boot", "zz_future_node"], activeResearch: null }, cargo: { capacityUnits: 2000, items: { sulfur: 8 } } }),
        }),
        dead: v1({ [me]: v1Player({ ship: pose, isDead: true, health: 0 }) }, { wrecks: [legacyWreck] }),
        moon: v1({ [me]: v1Player({ ship: moonPose }) }),
        legacyWreck: v1({ [me]: v1Player() }, { wrecks: [legacyWreck, { ...legacyWreck, id: "wreck-legacy-2", items: { silicates: 3, hydrates: 1 } }] }),
        paidResearch: v1({ [me]: v1Player({ research: { assaySamples: 13, completedNodes: ["r0_microlab_boot"], activeResearch: { nodeId: "a1_sensor_calibration", elapsedS: 30.5 } } }) }),
        malformed: v1({
          [me]: v1Player({
            ship: { frameId: "earth", positionKm: [1, NaN, 2], quaternion: [0, 0, 0, 1] },
            health: NaN,
            cargo: { capacityUnits: -5, items: { fe_ni_metal: -5, silicates: 2.7, carbon: NaN, sulfur: Infinity, hydrates: "x" } },
            research: { assaySamples: -3, completedNodes: ["r0_microlab_boot", 7, null], activeResearch: { nodeId: 5 } },
            modules: { ownedModules: "nope", consumables: { consumable_hull_patch_kit: -1, consumable_assay_probe: 1.9 }, hotbar: [1, "x"] },
            minedLifetime: -2,
          }),
          broken: "not a player",
        }, { simRate: NaN, wrecks: [{ id: "bad", frameId: "earth", positionKm: [1, NaN, 2] }, { id: "w2", frameId: "earth", positionKm: [1, 2, 3], items: { fe_ni_metal: -1, silicates: 3 } }, 7] }),
        unknownIds: v1({
          [me]: v1Player({
            research: { assaySamples: 0, completedNodes: ["r0_microlab_boot", "zz_unknown_node"], activeResearch: null },
            cargo: { capacityUnits: 2000, items: { unobtanium: 4 } },
            modules: { ownedModules: ["module_from_future"], equippedModules: { scanner: "module_from_future" }, consumables: { consumable_unknown: 3 }, consumableCooldowns: {}, hotbar: HOTBAR },
          }),
        }, { wrecks: [{ ...legacyWreck, id: "w-unknown", items: { unobtanium: 2 } }] }),
      };
      const res = {};
      for (const [name, raw] of Object.entries(fx)) {
        const r = await ev(`(() => { const a = ${G}.parse(${js(raw)}); const b = ${G}.parse(a); const c = ${G}.parse(JSON.parse(JSON.stringify(b))); return { a, idempotent: JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(b) === JSON.stringify(c) }; })()`);
        const a = r.a;
        const p = a.players[me];
        const c = { schema: a.schemaVersion === 4, idempotent: r.idempotent, receipts: eq(a.world.receipts, []) };
        const v1p = raw.players[me];
        if (name !== "malformed") {
          c.pose = eq(p.ship, v1p.ship);
          c.cargo = eq(p.cargo, v1p.cargo);
          // Schema 3: assay samples retire into the inert legacy record; a mapped paid timer completes once.
          c.assay = (p.legacy?.assaySamples ?? 0) === v1p.research.assaySamples && (p.legacy?.activeResearch ?? null) === null;
          c.noPlayerResearch = !("research" in p);
          c.fullTanks = p.propellant.ordinaryKg > 0 && p.propellant.protectedKg > 0 && p.power.capacitor01 === 1 && p.power.heat01 === 0 && p.processing === null;
          c.deltas = eq(a.world.asteroidDeltas, raw.world.asteroidDeltas);
          c.wrecks = eq(a.world.wrecks, raw.world.wrecks.map((w) => ({ ...w, fuelKg: 0, consumables: {} })).map(({ id, frameId, positionKm, items, fuelKg, consumables, createdAt }) => ({ id, frameId, positionKm, items, fuelKg, consumables, createdAt })));
        }
        if (name === "single") {
          c.modules = eq(p.modules, v1p.modules) && p.aiName === "HAL" && eq(p.commsPlayed, v1p.commsPlayed) && eq(p.starMarkers, ["proxima"]) && p.minedLifetime === 9;
          c.research = eq(a.world.research.completedNodes, []) && eq(a.world.research.legacy, []);
        }
        if (name === "twoPlayers") {
          c.union = eq(a.world.research.completedNodes, ["sv1_composition_survey"]) && eq(a.world.research.legacy, ["zz_future_node"]);
          c.bothPlayers = eq(a.players["player-b"].cargo.items, { sulfur: 8 }) && a.players["player-b"].legacy.assaySamples === 2;
        }
        if (name === "paidResearch") c.paidCompleted = eq(a.world.research.completedNodes, ["sv1_composition_survey"]);
        if (name === "dead") c.dead = p.isDead === true && p.health === 0;
        if (name === "moon") c.moonPose = p.ship.frameId === moonFrame;
        if (name === "malformed") {
          c.cleaned = p.ship === null && p.health === 100 && p.cargo.capacityUnits === 0 && eq(p.cargo.items, { silicates: 2 });
          c.counts = eq(p.modules.consumables, {}) && eq(p.legacy?.consumables, { consumable_assay_probe: 1 }) && p.legacy?.assaySamples === 0 && p.legacy?.activeResearch === null && p.minedLifetime === 0;
          c.wrecks = eq(a.world.wrecks.map((w) => [w.id, w.items]), [["w2", { silicates: 3 }]]);
          c.brokenPlayerDefaulted = a.players.broken !== undefined && a.players.broken.health === 100;
          c.simRate = a.world.simRate === 1;
          c.research = eq(a.world.research.completedNodes, []);
        }
        if (name === "unknownIds") {
          c.keptInert = eq(a.world.research.completedNodes, []) && eq(a.world.research.legacy, ["zz_unknown_node"]) && eq(p.cargo.items, { unobtanium: 4 }) &&
            eq(p.modules.ownedModules, []) && eq(p.modules.equippedModules, {}) && eq(p.legacy?.items, ["module_from_future"]) && eq(p.legacy?.consumables, { consumable_unknown: 3 });
        }
        const pass = Object.values(c).every((v) => v === true);
        res[name] = pass ? { pass } : { pass, c, sample: p };
      }
      // Real load path: raw v1 record in IndexedDB → loadWorld migrates; export → import → export.
      const rt = {};
      for (const name of ["single", "twoPlayers", "dead", "legacyWreck"]) {
        const id = await fixture(`migrate-${name}`, fx[name]);
        const j1 = await ev(`${G}.fixtures.export(${JSON.stringify(id)})`);
        const id2 = await ev(`${G}.fixtures.import(${JSON.stringify(j1)})`);
        created.push(id2);
        const j2 = await ev(`${G}.fixtures.export(${JSON.stringify(id2)})`);
        const id3 = await ev(`${G}.fixtures.import(${JSON.stringify(j2)})`);
        created.push(id3);
        const j3 = await ev(`${G}.fixtures.export(${JSON.stringify(id3)})`);
        const x1 = JSON.parse(j1), x2 = JSON.parse(j2), x3 = JSON.parse(j3);
        const strip = (x) => ({ ...x.meta, id: null });
        const parsedDirect = await ev(`${G}.parse(${js(fx[name])})`);
        const multi = name === "twoPlayers";
        rt[name] = {
          dataEqual: eq(x1.data, x2.data) && eq(x2.data, x3.data),
          // A single-player save is re-keyed to the importing device: same player here.
          matchesPureParse: eq(x1.data, parsedDirect),
          metaEqualButId: eq(strip(x2), strip(x3)) && x2.meta.name === x1.meta.name && x2.meta.createdAt === x1.meta.createdAt,
          bytesEqual23: j2.replace(x2.meta.id, "") === j3.replace(x3.meta.id, ""),
          multi,
        };
        rt[name].pass = rt[name].dataEqual && rt[name].matchesPureParse && rt[name].metaEqualButId && rt[name].bytesEqual23;
      }
      out.migrate = { fixtures: res, roundtrip: rt, pass: Object.values(res).every((r) => r.pass) && Object.values(rt).every((r) => r.pass) };
    }

    if (parts.includes("tx")) {
      const id = await fixture("tx", {
        schemaVersion: 2,
        world: {
          ...v1World(), research: { completedNodes: ["r0_microlab_boot", "a1_sensor_calibration"] }, receipts: [],
          wrecks: [
            { id: "wreck-fuel", frameId: "earth", positionKm: [7100, 1, 2], items: {}, fuelKg: 50, consumables: { consumable_hull_patch_kit: 12 }, createdAt: 1 },
            { id: "wreck-empty", frameId: "earth", positionKm: [7100, 3, 2], items: { dust: 0.5 }, fuelKg: 0, consumables: {}, createdAt: 2 },
          ],
        },
        players: { [me]: { ...v1Player({ research: { assaySamples: 3, activeResearch: null } }), propellant: { ordinaryKg: 580, protectedKg: 60 }, power: { capacitor01: 1, heat01: 0 }, processing: null } },
      });
      await boot(id);
      await d.scene("belt");
      await d.frames(30);
      const t = {};
      const item = "consumable_hull_patch_kit"; // starter recipe: fe_ni_metal 15, silicates 10; stackMax 10

      // Crafting: rejected spends nothing and says why.
      const p0 = await player();
      const rej = await submit({ type: "item.craft", opId: "craft-reject", itemId: item });
      const p1 = await player();
      t.craftReject = { status: rej.status, reason: rej.reason, missing: rej.missing, unchanged: eq(p0, p1), pass: rej.status === "rejected" && rej.reason === "materials" && eq(rej.missing, { fe_ni_metal: 15, silicates: 10 }) && eq(p0, p1) };
      const lockedRej = await submit({ type: "item.craft", opId: "craft-locked", itemId: "module_ping_array_mk1" });
      t.craftLocked = { reason: lockedRej.reason, pass: lockedRej.reason === "locked" && eq(p0, await player()) };
      // Accepted once; the same id again has no effect.
      for (const [r, n] of [["fe_ni_metal", 50], ["silicates", 25]]) await ev(`__dev.grantCargo(${JSON.stringify(r)}, ${n})`);
      const ok1 = await submit({ type: "item.craft", opId: "craft-1", itemId: item });
      const ok2 = await submit({ type: "item.craft", opId: "craft-1", itemId: item });
      const p2 = await player();
      t.craftOnce = {
        statuses: [ok1.status, ok2.status], cargo: p2.cargo.items, count: p2.modules.consumables[item], hotbar: p2.modules.hotbar.indexOf(item), mirrors: await mirrorsMatch(),
        pass: ok1.status === "accepted" && ok2.status === "duplicate" && p2.modules.consumables[item] === 1 && eq(p2.cargo.items, { fe_ni_metal: 35, silicates: 15 }) && p2.modules.hotbar.includes(item) && (await mirrorsMatch()),
      };
      // Reload immediately after (pagehide flush): complete result, and the receipt survives.
      await ev(`${G}.submit({ type: "item.craft", opId: "craft-2", itemId: ${JSON.stringify(item)} })`);
      await d.reload();
      await d.frames(5);
      const p3 = await player();
      const dupAfterReload = await submit({ type: "item.craft", opId: "craft-2", itemId: item });
      t.craftReload = {
        count: p3.modules.consumables[item], cargo: p3.cargo.items, dup: dupAfterReload.status,
        pass: p3.modules.consumables[item] === 2 && eq(p3.cargo.items, { fe_ni_metal: 20, silicates: 5 }) && dupAfterReload.status === "duplicate",
      };

      // Research (M3.3): missing evidence rejected by name; a trial and an unlock accepted once; retry after reload has no effect.
      const node = "lg1_bulk_handling"; // trials first_batch + first_fabrication (the craft above recorded it); 10 fe_ni_metal
      const poor = await submit({ type: "research.unlock", opId: "ru-0", nodeId: node });
      const tr1 = await submit({ type: "trial.record", opId: "tr-1", trialId: "first_batch" });
      const tr1dup = await submit({ type: "trial.record", opId: "tr-1", trialId: "first_batch" });
      const tr2 = await submit({ type: "trial.record", opId: "tr-2", trialId: "first_batch" });
      const done1 = await submit({ type: "research.unlock", opId: "ru-1", nodeId: node });
      const pr = await player();
      await d.reload();
      await d.frames(5);
      const done2 = await submit({ type: "research.unlock", opId: "ru-1", nodeId: node });
      const done3 = await submit({ type: "research.unlock", opId: "ru-3", nodeId: node });
      const w1 = await world();
      t.research = {
        poor: [poor.reason, poor.evidence], trial: [tr1.status, tr1dup.status, tr2.reason], done: [done1.status, done2.status, done3.reason], cargoAfter: pr.cargo.items,
        completed: w1.research.completedNodes, mirrors: await mirrorsMatch(),
        pass: poor.reason === "evidence" && eq(poor.evidence, ["trial:first_batch"]) && tr1.status === "accepted" && tr1dup.status === "duplicate" && tr2.reason === "already_done" &&
          done1.status === "accepted" && done2.status === "duplicate" && done3.reason === "already_done" && eq(pr.cargo.items, { fe_ni_metal: 10, silicates: 5 }) &&
          w1.research.completedNodes.filter((n) => n === node).length === 1 && (await mirrorsMatch()),
      };

      // Mining: one reward; same rock again (new id) rejected; gone after reload.
      let rocks = [];
      for (let i = 0; i < 40 && rocks.length === 0; i++) {
        rocks = await ev(`__test.world.asteroidsNearShip(1)`);
        if (rocks.length === 0) await wait(250);
      }
      const rock = rocks[0];
      const radiusM = 20;
      const before = await player();
      const m1 = await ev(`${G}.mine(${JSON.stringify({ ...rock, radiusM })}, "mine-1")`);
      const m2 = await ev(`${G}.mine(${JSON.stringify({ ...rock, radiusM })}, "mine-1")`);
      const m3 = await ev(`${G}.mine(${JSON.stringify({ ...rock, radiusM })}, "mine-2")`);
      const after = await player();
      await d.reload();
      await d.frames(5);
      let present = null;
      for (let i = 0; i < 40 && present === null; i++) {
        present = await ev(`__test.world.instanceLoaded(${JSON.stringify(rock.fieldId)}, ${JSON.stringify(rock.chunkKey)}, ${rock.instanceId})`);
        if (present === null) await wait(250);
      }
      const afterReload = await player();
      const granted = m1.result?.granted ?? {};
      const grantedSum = Object.values(granted).reduce((s, v) => s + v, 0);
      const cargoDelta = Object.values(after.cargo.items).reduce((s, v) => s + v, 0) - Object.values(before.cargo.items).reduce((s, v) => s + v, 0);
      t.mine = {
        statuses: [m1.status, m2.status, m3.reason], granted, newFamilies: m1.result?.newFamilies, lifetime: [before.minedLifetime, after.minedLifetime],
        presentAfterReload: present, keptAfterReload: eq(afterReload.cargo, after.cargo),
        pass: m1.status === "accepted" && m2.status === "duplicate" && m3.reason === "already_done" && grantedSum > 0 && cargoDelta === grantedSum &&
          Array.isArray(m1.result.newFamilies) && after.minedLifetime === before.minedLifetime + 1 &&
          present === false && eq(afterReload.cargo, after.cargo),
      };

      // Death: one op; a stale sampled hull or cargo mirror cannot be flushed over it.
      for (const r of Object.keys((await player()).cargo.items)) await ev(`${G}.jettison(${JSON.stringify(r)})`);
      await ev(`__dev.grantCargo("fe_ni_metal", 30)`);
      await ev(`__phys.game.setHealth(50)`);
      const cargoAtDeath = (await player()).cargo.items;
      const wrecks0 = (await world()).wrecks.length;
      const k1 = await ev(`${G}.kill()`);
      await ev("__test.save.flush()");
      const rec = await idb(id);
      const k2 = await submit({ type: "ship.destroy", opId: "kill-again", frameId: "earth", positionKm: [0, 0, 0] });
      const savedP = rec.players[me];
      t.death = {
        status: k1?.status, saved: { isDead: savedP.isDead, health: savedP.health, cargo: savedP.cargo.items, wrecks: rec.world.wrecks.length }, again: k2.reason,
        pass: k1?.status === "accepted" && savedP.isDead && savedP.health === 0 && eq(savedP.cargo.items, {}) && rec.world.wrecks.length === wrecks0 + 1 &&
          eq(rec.world.wrecks.at(-1).items, cargoAtDeath) && k2.reason === "already_done" && (await mirrorsMatch()),
      };
      const wreckId = rec.world.wrecks.at(-1).id;
      await d.reload();
      await d.frames(5);
      const pd = await player();
      const wd = await world();
      t.deadReload = { isDead: pd.isDead, cargo: pd.cargo.items, wrecks: wd.wrecks.length, pass: pd.isDead && eq(pd.cargo.items, {}) && wd.wrecks.length === wrecks0 + 1 };

      // Respawn once; wreck collection partial → full, accepted once, fuel/consumables respect limits.
      // Move away in the same task: the live WreckCollector must not race these operations.
      const r1 = await ev(`(() => { const o = ${G}.submit({ type: "ship.respawn", opId: "resp-1", mode: "active" }); ${G}.teleportToWreck(${JSON.stringify(wreckId)}, 5e6); return o; })()`);
      const r2 = await submit({ type: "ship.respawn", opId: "resp-2", mode: "active" });
      const pr1 = await player();
      t.respawn = { statuses: [r1.status, r2.reason], health: pr1.health, pass: r1.status === "accepted" && r2.reason === "not_dead" && !pr1.isDead && pr1.health === r1.result.health && pr1.health > 0 };
      const cap = (await ev(`${G}.mirrors()`)).cargoCapacity;
      await ev(`__dev.grantCargo("silicates", ${cap - 10})`);
      const roomBefore = cap - Object.values((await player()).cargo.items).reduce((s, v) => s + v, 0);
      const c1 = await submit({ type: "wreck.collect", opId: "col-1", wreckId });
      const c1dup = await submit({ type: "wreck.collect", opId: "col-1", wreckId });
      const pc1 = await player();
      const wc1 = (await world()).wrecks.find((w) => w.id === wreckId);
      const fullRej = await submit({ type: "wreck.collect", opId: "col-full", wreckId });
      await ev(`${G}.jettison("silicates")`);
      const c2 = await submit({ type: "wreck.collect", opId: "col-2", wreckId });
      await d.reload();
      await d.frames(5);
      const pc2 = await player();
      const wc2 = (await world()).wrecks.find((w) => w.id === wreckId);
      t.collect = {
        roomBefore, first: c1.result?.taken, dup: c1dup.status, left: wc1?.items, fullRej: fullRej.reason, second: c2.result?.taken, removed: c2.result?.removed, after: pc2.cargo.items, wreckGone: wc2 === undefined,
        pass: c1.status === "accepted" && c1dup.status === "duplicate" && c1.result.taken.items.fe_ni_metal === roomBefore && wc1.items.fe_ni_metal === 30 - roomBefore &&
          fullRej.reason === "no_capacity" && c2.status === "accepted" && c2.result.removed && wc2 === undefined && pc2.cargo.items.fe_ni_metal === 30 && pc1.cargo.items.fe_ni_metal === roomBefore,
      };
      const f1 = await submit({ type: "wreck.collect", opId: "col-fuel", wreckId: "wreck-fuel" });
      const pf = await player();
      const wf = (await world()).wrecks.find((w) => w.id === "wreck-fuel");
      t.fuelWreck = {
        taken: f1.result?.taken, left: wf ? { fuelKg: wf.fuelKg, consumables: wf.consumables } : null, tank: pf.propellant,
        pass: f1.status === "accepted" && f1.result.taken.fuelKg === 20 && pf.propellant.ordinaryKg === 600 && pf.propellant.protectedKg === 60 &&
          wf.fuelKg === 30 && pf.modules.consumables[item] === 10 && wf.consumables[item] === 4,
      };

      const e1 = await submit({ type: "wreck.collect", opId: "col-empty", wreckId: "wreck-empty" });
      t.emptyWreck = { status: e1.status, removed: e1.result?.removed, pass: e1.status === "accepted" && e1.result.removed && !(await world()).wrecks.some((w) => w.id === "wreck-empty") };

      // A flush queued right before an operation runs after it: the record is all-new, never half.
      await ev("__dev.grantCargo('carbon', 1)");
      await ev("__test.save.flush()");
      const raced = await ev(`(async () => { const f = __test.save.flush(); const o = ${G}.submit({ type: "item.craft", opId: "craft-race", itemId: "consumable_hull_patch_kit" }); await f; return o.status; })()`);
      const recR = await idb(id);
      const pR = await player();
      t.flushRace = { status: raced, pass: eq(recR.players[me].cargo, pR.cargo) && eq(recR.players[me].modules, pR.modules) };
      out.tx = { ...t, pass: Object.values(t).every((x) => x.pass) };
    }

    if (parts.includes("shared")) {
      const id = await fixture("shared", v1({
        [me]: v1Player({ cargo: { capacityUnits: 2000, items: { silicates: 12, carbon: 5 } } }),
        "player-b": v1Player({ research: { assaySamples: 6, completedNodes: [], activeResearch: null }, cargo: { capacityUnits: 2000, items: { silicates: 200, fe_ni_metal: 80, carbon: 30, sulfur: 10 } } }),
      }));
      await boot(id);
      const a0 = await player();
      const b0 = await player("player-b");
      const bLocked = await submit({ type: "item.craft", opId: "b-craft-0", itemId: "module_prospector_scanner_mk1" }, "player-b");
      // A's inspections (shared findings) make Composition Survey available to both; A pays the analysis.
      const inspected = { firstAt: 1, by: me, inspected: true, extracted: false, sourceId: null };
      await ev(`${G}.m33.devSetWorld(${JSON.stringify({ discoveries: { families: { silicates: inspected, fe_ni_metal: inspected, hydrates: inspected }, sources: [], sites: {}, trials: {} } })})`);
      const done = await submit({ type: "research.unlock", opId: "a-ru", nodeId: "sv1_composition_survey" });
      const bCraft = await submit({ type: "item.craft", opId: "b-craft-1", itemId: "module_prospector_scanner_mk1" }, "player-b");
      const bLate = await submit({ type: "research.unlock", opId: "b-ru", nodeId: "sv1_composition_survey" }, "player-b");
      const a1 = await player();
      const b1 = await player("player-b");
      const unknown = await submit({ type: "item.craft", opId: "x-craft", itemId: "module_prospector_scanner_mk1" }, "nobody");
      out.shared = {
        bBefore: bLocked.reason, research: done.status, bCraft: bCraft.status, bLate: bLate.reason, unknownPlayer: unknown.reason,
        aCargo: a1.cargo.items, aModulesUnchanged: eq(a1.modules, a0.modules), bGotModule: b1.modules.ownedModules,
        bSpent: b1.cargo.items, fuelSeparate: eq(b1.propellant, b0.propellant),
        pass: bLocked.reason === "locked" && done.status === "accepted" && bCraft.status === "accepted" && bLate.reason === "already_done" && unknown.reason === "unknown_player" &&
          eq(a1.cargo.items, { silicates: 2, carbon: 5 }) && eq(a1.modules, a0.modules) && b1.modules.ownedModules.includes("module_prospector_scanner_mk1") &&
          eq(b1.cargo.items, { silicates: 80, fe_ni_metal: 40, carbon: 30, sulfur: 10 }) && b1.legacy?.assaySamples === 6 && eq(b1.propellant, b0.propellant),
      };
    }

    if (parts.includes("live")) {
      const id = await fixture("live", v1({ [me]: v1Player() }));
      await boot(id);
      await d.scene("belt");
      await d.frames(60);
      const L = {};
      // Mine through MiningSystem's claim builder (aiming skipped).
      let rocks = [];
      for (let i = 0; i < 40 && rocks.length === 0; i++) {
        rocks = await ev(`__test.world.asteroidsNearShip(1)`);
        if (rocks.length === 0) await wait(250);
      }
      const rock = rocks[0];
      const m = await ev(`${G}.mine(${JSON.stringify({ ...rock, radiusM: 30 })})`);
      await d.reload();
      await d.frames(5);
      let present = null;
      for (let i = 0; i < 40 && present === null; i++) {
        present = await ev(`__test.world.instanceLoaded(${JSON.stringify(rock.fieldId)}, ${JSON.stringify(rock.chunkKey)}, ${rock.instanceId})`);
        if (present === null) await wait(250);
      }
      const pm = await player();
      L.mine = { status: m.status, granted: m.result?.granted, cargo: pm.cargo.items, present, pass: m.status === "accepted" && present === false && eq(pm.cargo.items, m.result.granted) && pm.minedLifetime === 1 };

      // Close inspection through the real scanner path: lock the nearest rock, start (HUD action), let it run.
      let near = [];
      for (let i = 0; i < 40 && near.length === 0; i++) {
        near = (await ev(`${G}.m33.rocks(200)`)).filter((r) => r.radiusM > 10 && r.instanceId !== rock.instanceId);
        if (near.length === 0) await wait(250);
      }
      const target = near[0];
      await ev(`${G}.m33.approach(${JSON.stringify(target)}, ${target.radiusM / 1000 + 0.4})`);
      await d.frames(10);
      await ev(`${G}.res.face(${JSON.stringify(target)})`);
      let focused = false;
      for (let i = 0; i < 40 && !focused; i++) {
        await wait(250);
        focused = (await ev(`${G}.res.mining()`)).focused;
      }
      const started = await ev(`${G}.m33.startInspection()`);
      const t0 = Date.now();
      let src = null;
      while (!src && Date.now() - t0 < 10_000) {
        await wait(250);
        src = (await world()).discoveries.sources.find((x) => x.asteroidId === target.instanceId) ?? null;
      }
      L.inspect = { focused, started, seconds: Math.round((Date.now() - t0) / 100) / 10, classId: src?.classId, composition: src?.composition, pass: focused && started && !!src && eq(src.composition, target.composition) };

      // Craft through the crafting panel's action: a starter blueprint needs no research.
      for (const [r, n] of [["fe_ni_metal", 15], ["silicates", 10]]) await ev(`__dev.grantCargo(${JSON.stringify(r)}, ${n})`);
      const c = await ev(`${G}.craft("consumable_hull_patch_kit")`);
      L.craft = { status: c?.status, count: (await player()).modules.consumables.consumable_hull_patch_kit, pass: c?.status === "accepted" && (await player()).modules.consumables.consumable_hull_patch_kit === 1 };

      // Die with cargo, reload while dead, respawn via the death screen button, then let the
      // WreckCollector pull the wreck in: partially (cargo nearly full), then fully.
      await ev(`__dev.grantCargo("fe_ni_metal", 40)`);
      await ev(`${G}.nudgeKm(5, 0, 0)`); // die away from the respawn point
      await d.frames(20);
      const cargoAtDeath = (await player()).cargo.items;
      const k = await ev(`${G}.kill()`);
      await d.reload();
      await d.frames(5);
      const dead = await player();
      const wreck = (await world()).wrecks.at(-1);
      // Flush in the click's own task, before any frame applies the teleport.
      const clicked = await ev(`(async () => { const b = document.querySelector(".death-screen__respawn"); if (!b) return false; b.click(); await __test.save.flush(); return true; })()`);
      const recResp = await idb(id);
      await d.frames(30);
      await ev("__test.save.flush()");
      const alive = await player();
      const sp = recResp.players[me];
      const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      L.respawnDurable = {
        savedDead: sp.isDead, savedPose: sp.ship, livePose: alive.ship,
        pass: sp.isDead === false && sp.ship.frameId === alive.ship.frameId && dist(sp.ship.positionKm, alive.ship.positionKm) < 0.01 && dist(sp.ship.positionKm, dead.ship.positionKm) > 1,
      };
      const used = Object.values(alive.cargo.items).reduce((a, v) => a + v, 0);
      const liveCap = (await ev(`${G}.mirrors()`)).cargoCapacity;
      await ev(`__dev.grantCargo("silicates", ${liveCap - used - 15})`);
      await ev(`${G}.teleportToWreck(${JSON.stringify(wreck.id)}, 60)`);
      let w1 = wreck;
      for (let i = 0; i < 30; i++) {
        await wait(500);
        w1 = (await world()).wrecks.find((w) => w.id === wreck.id);
        if (!w1 || Object.values(w1.items).reduce((a, v) => a + v, 0) < Object.values(wreck.items).reduce((a, v) => a + v, 0)) break;
      }
      const partial = { left: w1?.items ?? null, cargo: (await player()).cargo.items };
      await ev(`${G}.jettison("silicates")`);
      let w2 = w1;
      for (let i = 0; i < 30 && w2; i++) {
        await wait(500);
        w2 = (await world()).wrecks.find((w) => w.id === wreck.id);
      }
      const pAfter = await player();
      await d.reload();
      await d.frames(5);
      const pReload = await player();
      const wReload = (await world()).wrecks.find((w) => w.id === wreck.id);
      const total = (items) => Object.values(items).reduce((a, v) => a + v, 0);
      L.death = {
        kill: k?.status, deadAfterReload: dead.isDead, cargoAfterDeath: dead.cargo.items, wreckItems: wreck.items, clicked, alive: !alive.isDead,
        partial, final: pAfter.cargo.items, wreckGone: w2 === undefined && wReload === undefined, afterReload: pReload.cargo.items,
        pass: k?.status === "accepted" && dead.isDead && eq(dead.cargo.items, {}) && eq(wreck.items, cargoAtDeath) && clicked && !alive.isDead &&
          partial.left !== null && total(partial.left) > 0 && total(partial.left) < total(wreck.items) && w2 === undefined && wReload === undefined &&
          eq(pReload.cargo.items, pAfter.cargo.items) && Object.entries(cargoAtDeath).every(([r, n]) => r === "silicates" || pAfter.cargo.items[r] === n),
      };
      out.live = { ...L, pass: Object.values(L).every((x) => x.pass) };
    }
  } finally {
    await ev(`${G}.fixtures.activate(${JSON.stringify(original)})`);
    await d.reload();
    await d.frames(5);
    const removed = [];
    for (const id of created) removed.push(await ev(`${G}.fixtures.remove(${JSON.stringify(id)})`));
    out.cleanup = { restored: (await ev("__test.save.info()")).id === original, removed: removed.filter(Boolean).length, of: created.length };
  }
  return out;
}
