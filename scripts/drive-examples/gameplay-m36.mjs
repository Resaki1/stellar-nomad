/**
 * M3.6 gates (parts of gameplay-check.mjs; needs --no-isolate):
 *   place      placement: one kit, one record; duplicate opId; each refusal distinct; Luna frame at rate 1e4
 *   activate   two-player selection, proximity, deactivation keeps the record
 *   death      death/abandon transaction, reload while dead / after recovery, second death
 *   recover    recovery at a point, clean runtime state, obstructed offset, missing/invalid fallback,
 *              explicit starter fallback from an isolated point, ten cycles never raise usable fuel
 *   salvage    partial collection (hold, tank, stackMax), duplicates, fuel-only / consumable-only markers
 *   migrate4   schema 1/2/3 fixtures gain the starter point; untouched otherwise; round trip; refusals
 *   live36     real inputs: craft a kit, fly out, place + name, fly on, die by collision, recover, collect
 *   m36shots   captures (1280×720); m36narrow the recovery screen at 390×844 (--size 390x844)
 */
import { writeFileSync } from "node:fs";

/** Screenshot without waiting for rendered frames (the settings menu stops the render loop). */
async function rawShot(d, name) {
  const r = await d.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`.captures/${name}.png`, Buffer.from(r.data, "base64"));
  return `.captures/${name}.png`;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const G = "__test.gameplay";
const R = `${G}.rep`;
const r3 = (x) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : x);
const sum = (o) => Object.values(o ?? {}).reduce((a, v) => a + v, 0);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const KIT = "consumable_replication_kit";
/** Rotation taking +Z to unit `u` (x, y, z, w). */
function quatTo(u) {
  const w = 1 + u[2];
  if (w < 1e-9) return [0, 1, 0, 0];
  const q = [-u[1], u[0], 0, w];
  const l = Math.hypot(...q);
  return q.map((x) => x / l);
}

async function freshWorld(d, ctx, name, players) {
  const id = await ctx.fixture(name, ctx.v1(players ?? { [ctx.me]: ctx.v1Player() }));
  await ctx.boot(id);
  await d.scene("belt");
  await d.frames(60);
  return id;
}

async function grant(ctx, items) {
  for (const [r, n] of Object.entries(items)) await ctx.ev(`__dev.grantCargo(${JSON.stringify(r)}, ${n})`);
}

async function craftKits(ctx, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    await grant(ctx, { fe_ni_metal: 150, silicates: 100 });
    out.push((await ctx.ev(`${G}.craft(${JSON.stringify(KIT)})`))?.status);
  }
  return out;
}

/** Nudge in a widening spiral until the preview (0.8 km ahead) is clear. */
export async function findClearPreview(d, ctx) {
  const { ev } = ctx;
  await ev(`${R}.setMode(true)`);
  for (let i = 0; i < 12; i++) {
    const pv = await ev(`${R}.preview()`);
    if (pv.valid) return pv;
    await ev(`${G}.nudgeKm(${3 + i}, ${i % 2 ? 2 : -2}, ${i})`);
    await d.frames(8);
  }
  return ev(`${R}.preview()`);
}

export async function waitArrival(ctx, ms = 15000) {
  const t0 = Date.now();
  let rt = await ctx.ev(`${R}.runtime()`);
  while ((rt.pending || rt.arriving || rt.paused) && Date.now() - t0 < ms) {
    await ctx.wait(100);
    rt = await ctx.ev(`${R}.runtime()`);
  }
  return rt;
}

// ── (a) placement ──
export async function placeGates(d, ctx) {
  const { ev, submit, player, world } = ctx;
  await freshWorld(d, ctx, "m36-place");
  const out = {};
  const w0 = await world();
  out.starter = { points: w0.replication.points.map((p) => p.id), active: (await player()).replication.activeId, pass: w0.replication.points.length === 1 && w0.replication.points[0].starter === true && (await player()).replication.activeId === "starter" };

  const crafted = await craftKits(ctx, 3);
  const p0 = await player();
  out.craft = { crafted, kits: p0.modules.consumables[KIT], hotbar: p0.modules.hotbar, pass: crafted.every((s) => s === "accepted") && p0.modules.consumables[KIT] === 3 && p0.modules.hotbar.includes(KIT) };

  const pv = await findClearPreview(d, ctx);
  const opId = "m36-place-1";
  const before = await player();
  const o1 = await ev(`${R}.place("Alpha", ${JSON.stringify(opId)})`);
  const after = await player();
  const w1 = await world();
  const o2 = await ev(`${R}.place("Alpha", ${JSON.stringify(opId)})`);
  const after2 = await player();
  const w2 = await world();
  const pt = w1.replication.points.at(-1);
  out.valid = {
    preview: { valid: pv.valid, refusal: pv.check.refusal, rockClearM: r3(pv.check.rockClearM), bodyAltKm: r3(pv.check.bodyAltKm) },
    status: o1.status, dup: o2.status, kits: [before.modules.consumables[KIT], after.modules.consumables[KIT], after2.modules.consumables[KIT]],
    points: [w0.replication.points.length, w1.replication.points.length, w2.replication.points.length], active: after.replication.activeId, name: pt?.name, frameId: pt?.frameId,
    pass: pv.valid && o1.status === "accepted" && o2.status === "duplicate" && after.modules.consumables[KIT] === 2 && after2.modules.consumables[KIT] === 2 &&
      w1.replication.points.length === 2 && w2.replication.points.length === 2 && after.replication.activeId === pt?.id && pt?.name === "Alpha" && eq(pt.positionKm, pv.positionKm),
  };
  await ev(`${R}.setMode(false)`);

  // Refusals: each spends nothing and is distinct.
  const ship = await ev(`${R}.ship()`);
  const fwd = (q, k) => {
    // Rotate (0,0,k) by q.
    const [x, y, z, w] = q;
    return [2 * (x * z + w * y) * k, 2 * (y * z - w * x) * k, (1 - 2 * (x * x + y * y)) * k];
  };
  const ahead = (k) => {
    const f = fwd(ship.quat, k);
    return [ship.posKm[0] + f[0], ship.posKm[1] + f[1], ship.posKm[2] + f[2]];
  };
  const refuse = async (label, op) => {
    const pb = await player();
    const wb = await world();
    const o = await submit({ type: "replication.place", name: label, ...op });
    const pa = await player();
    const wa = await world();
    return { reason: o.reason ?? o.status, spent: pb.modules.consumables[KIT] - pa.modules.consumables[KIT], points: wa.replication.points.length - wb.replication.points.length };
  };
  const ref = {};
  ref.nonFinite = await refuse("nan", { frameId: ship.frameId, positionKm: [NaN, 0, 0], quaternion: ship.quat });
  ref.badFrame = await refuse("frame", { frameId: "nowhere", positionKm: ahead(0.8), quaternion: ship.quat });
  ref.tooFar = await refuse("far", { frameId: ship.frameId, positionKm: ahead(5), quaternion: ship.quat });
  // Rock: the point 100 m off a loaded rock's surface; the ship 1 km out.
  const rocks = await ev(`${R}.rocks(400)`);
  const rock = rocks.find((r) => r.radiusM > 20 && r.radiusM < 400) ?? rocks[0];
  const u = [1, 0, 0];
  const at = (r, km) => [r.posKm[0] + u[0] * km, r.posKm[1] + u[1] * km, r.posKm[2] + u[2] * km];
  await ev(`${R}.teleportRel(${JSON.stringify(rock.frameId)}, ${JSON.stringify(at(rock, rock.radiusM / 1000 + 1.2))})`);
  await d.frames(10);
  const qU = quatTo(u);
  ref.nearRock = await refuse("rock", { frameId: rock.frameId, positionKm: at(rock, rock.radiusM / 1000 + 0.1), quaternion: qU });
  // Emergence: the point 560 m off the rock, its default emergence (−Z = −u) 60 m off it.
  const emPos = at(rock, rock.radiusM / 1000 + 0.56);
  const probe = await ev(`${R}.check(${JSON.stringify(rock.frameId)}, ${JSON.stringify(emPos)}, ${JSON.stringify(qU)})`);
  ref.emergence = await refuse("emerge", { frameId: rock.frameId, positionKm: emPos, quaternion: qU });
  ref.emergence.pointClearM = r3(probe.rockClearM);
  // Body: ship and point 100 km above Earth.
  const earth = (await ev(`${G}.transit.bodies(["earth"])`)).earth;
  await ev(`__test.gameplay.nudgeKm(${earth.posKm[0] + earth.radiusKm + 101} - __test.gameplay.rep.ship().absKm[0], ${earth.posKm[1]} - __test.gameplay.rep.ship().absKm[1], ${earth.posKm[2]} - __test.gameplay.rep.ship().absKm[2])`);
  await d.frames(10);
  const sb = await ev(`${R}.ship()`);
  ref.nearBody = await refuse("body", { frameId: sb.frameId, positionKm: [sb.posKm[0] + 0.8, sb.posKm[1], sb.posKm[2]], quaternion: [0, 0, 0, 1] });
  const reasons = Object.values(ref).map((r) => r.reason);
  out.refusals = {
    ...ref,
    pass: ref.nonFinite.reason === "invalid" && ref.badFrame.reason === "invalid" && ref.tooFar.reason === "too_far" && ref.nearRock.reason === "near_rock" &&
      ref.emergence.reason === "emergence_blocked" && ref.emergence.pointClearM >= 200 && ref.nearBody.reason === "near_body" &&
      Object.values(ref).every((r) => r.spent === 0 && r.points === 0) && new Set(reasons.filter((r) => r !== "invalid")).size === 4,
  };

  // Luna frame: place near the Moon, advance time at rate 1e4, the relative pose holds.
  const luna = (await ev(`${G}.transit.bodies(["luna"])`)).luna;
  await ev(`__test.gameplay.nudgeKm(${luna.posKm[0]} + 9000 - __test.gameplay.rep.ship().absKm[0], ${luna.posKm[1]} + 3000 - __test.gameplay.rep.ship().absKm[1], ${luna.posKm[2]} - __test.gameplay.rep.ship().absKm[2])`);
  await d.frames(20);
  const pvL = await findClearPreview(d, ctx);
  const oL = await ev(`${R}.place("Lunar camp")`);
  await ev(`${R}.setMode(false)`);
  const ptL = (await world()).replication.points.at(-1);
  const absA = await ev(`${R}.abs(${JSON.stringify(ptL.frameId)}, ${JSON.stringify(ptL.positionKm)})`);
  await submit({ type: "time.set", rate: 10000 });
  await ctx.wait(3000);
  await submit({ type: "time.set", rate: 1 });
  const ptL2 = (await world()).replication.points.find((p) => p.id === ptL.id);
  const absB = await ev(`${R}.abs(${JSON.stringify(ptL2.frameId)}, ${JSON.stringify(ptL2.positionKm)})`);
  out.luna = {
    preview: pvL.valid, status: oL.status, frameId: ptL.frameId, rel: ptL.positionKm.map(r3), absMovedKm: r3(dist(absA, absB)),
    pass: oL.status === "accepted" && ptL.frameId === "luna" && eq(ptL2.positionKm, ptL.positionKm) && eq(ptL2.quaternion, ptL.quaternion) && dist(absA, absB) > 100,
  };

  // No kit: one left after Luna; use it, then a valid pose is refused for the kit alone.
  const k1 = (await player()).modules.consumables[KIT] ?? 0;
  await ev(`__test.gameplay.nudgeKm(30, 0, 0)`);
  await d.frames(10);
  const pvN = await findClearPreview(d, ctx);
  const oN1 = await ev(`${R}.place("Last kit")`);
  await ev(`__test.gameplay.nudgeKm(30, 0, 0)`);
  await d.frames(10);
  const pvN2 = await ev(`${R}.preview()`);
  const pb = await player();
  const oN2 = await ev(`${R}.place("No kit")`);
  const pa = await player();
  await ev(`${R}.setMode(false)`);
  out.noKit = { kitsBefore: k1, last: oN1.status, preview: pvN.valid, refusal: pvN2.check.refusal, reason: oN2.reason, spent: (pb.modules.consumables[KIT] ?? 0) - (pa.modules.consumables[KIT] ?? 0), pass: k1 === 1 && oN1.status === "accepted" && pvN2.check.refusal === "no_kit" && oN2.reason === "no_kit" };
  out.pass = Object.values(out).every((x) => x.pass);
  return out;
}

// ── (b) activation ──
export async function activateGates(d, ctx) {
  const { ev, submit, player, world, me } = ctx;
  const B = "player-b";
  await freshWorld(d, ctx, "m36-activate", { [me]: ctx.v1Player(), [B]: ctx.v1Player() });
  await craftKits(ctx, 2);
  await findClearPreview(d, ctx);
  const o1 = await ev(`${R}.place("P1")`);
  await ev(`${R}.setMode(false)`);
  const p1 = (await world()).replication.points.at(-1);
  const pB = async () => (await player(B)).replication.activeId;
  const out = {};
  out.placeOnlyPlacer = { placed: o1.status, me: (await player()).replication.activeId, b: await pB(), pass: o1.status === "accepted" && (await player()).replication.activeId === p1.id && (await pB()) === "starter" };

  // B far away (its saved pose is null → no ship): refused, nothing changes for anyone.
  const far = await submit({ type: "replication.activate", pointId: p1.id }, B);
  await ev(`${R}.devSetPlayerShip(${JSON.stringify(B)}, { frameId: ${JSON.stringify(p1.frameId)}, positionKm: ${JSON.stringify([p1.positionKm[0] + 1.5, p1.positionKm[1], p1.positionKm[2]])}, quaternion: [0, 0, 0, 1] })`);
  const near = await submit({ type: "replication.activate", pointId: p1.id }, B);
  out.otherPlayer = { far: far.reason ?? far.status, near: near.status, b: await pB(), me: (await player()).replication.activeId, pass: far.reason === "too_far" && near.status === "accepted" && (await pB()) === p1.id };

  // Me: deactivate keeps the record; B's selection is untouched.
  const n0 = (await world()).replication.points.length;
  const de = await ev(`${R}.deactivate()`);
  const de2 = await ev(`${R}.deactivate()`);
  out.deactivate = { status: de.status, again: de2.reason, me: (await player()).replication.activeId, b: await pB(), points: [n0, (await world()).replication.points.length], pass: de.status === "accepted" && de2.reason === "already_done" && (await player()).replication.activeId === "starter" && (await pB()) === p1.id && (await world()).replication.points.length === n0 };

  // Proximity for me, through the UI action: 2.5 km refused, 1.9 km accepted.
  const at = async (km) => {
    await ev(`${R}.teleportRel(${JSON.stringify(p1.frameId)}, ${JSON.stringify([p1.positionKm[0], p1.positionKm[1] + km, p1.positionKm[2]])})`);
    await d.frames(10);
  };
  await at(2.5);
  const nb25 = await ev(`${R}.nearby()`);
  const a25 = await ev(`${R}.activate(${JSON.stringify(p1.id)})`);
  await at(1.9);
  const nb19 = await ev(`${R}.nearby()`);
  const a19 = await ev(`${R}.activate(${JSON.stringify(p1.id)})`);
  const casual = await ev(`${R}.ship()`);
  out.proximity = { at25: a25.reason ?? a25.status, nearby25: nb25?.id ?? null, at19: a19.status, nearby19: nb19 ? { id: nb19.id, distKm: r3(nb19.distKm), active: nb19.active } : null, me: (await player()).replication.activeId, b: await pB(),
    pass: a25.reason === "too_far" && nb25 === null && a19.status === "accepted" && nb19?.id === p1.id && (await player()).replication.activeId === p1.id && (await pB()) === p1.id && !!casual };

  // A casual visit to another point does not change the selection; placing P2 changes only mine.
  await findClearPreview(d, ctx);
  const o2 = await ev(`${R}.place("P2")`);
  await ev(`${R}.setMode(false)`);
  const p2 = (await world()).replication.points.at(-1);
  await at(0.6);
  await d.frames(30);
  out.casualVisit = { placed: o2.status, me: (await player()).replication.activeId, b: await pB(), pass: o2.status === "accepted" && (await player()).replication.activeId === p2.id && (await pB()) === p1.id };
  out.pass = Object.values(out).every((x) => x.pass);
  return out;
}
const kgPerUnit = 20;
const unconverted = (units, committedKg) => Math.max(0, units - Math.max(0, Math.ceil(committedKg / kgPerUnit - 1e-9)));
const addItems = (a, b) => {
  const o = { ...a };
  for (const [k, v] of Object.entries(b)) o[k] = (o[k] ?? 0) + v;
  return o;
};
/** Sample, kill and read back in ONE task, so no step runs between the snapshot and the operation. */
const KILL = `(() => { const before = ${G}.player(); const k = ${G}.kill(); return { before, k, after: ${G}.player(), wreck: ${G}.world().wrecks.at(-1) ?? null, wrecks: ${G}.world().wrecks.length }; })()`;

async function clickRecover(ctx, selector = ".death-screen__respawn") {
  return ctx.ev(`(async () => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return false; b.click(); await __test.save.flush(); return true; })()`);
}

// ── (c) death and reload ──
export async function deathGates(d, ctx) {
  const { ev, player, world, me } = ctx;
  const id = await freshWorld(d, ctx, "m36-death");
  const out = {};
  await craftKits(ctx, 1);
  await grant(ctx, { fe_ni_metal: 15, silicates: 10 });
  await ev(`${G}.craft("consumable_hull_patch_kit")`);
  await grant(ctx, { fe_ni_metal: 40, silicates: 25, hydrates: 20 });
  await ev(`${G}.res.set({ ordinaryKg: 300, protectedKg: 45 })`);
  const ps = await ev(`${G}.res.startProcessing(10)`);
  // Die away from the recovery point (a wreck at the emergence point is collected on arrival).
  await ev(`${G}.nudgeKm(6, 0, 0)`);
  await ctx.wait(1500);
  const k1 = await ev(KILL);
  const b = k1.before;
  const batch = b.processing;
  const back = batch ? unconverted(batch.reserved.hydrates, batch.committedKg) : 0;
  const topUp = Math.min(b.propellant.ordinaryKg, 60 - b.propellant.protectedKg);
  const expect = { items: addItems(b.cargo.items, back > 0 ? { hydrates: back } : {}), consumables: b.modules.consumables, fuelKg: b.propellant.ordinaryKg - topUp };
  const a = k1.after;
  out.transaction = {
    processing: ps.status, committedKg: r3(batch?.committedKg), back, wreck: { items: k1.wreck?.items, consumables: k1.wreck?.consumables, fuelKg: r3(k1.wreck?.fuelKg) }, expect: { ...expect, fuelKg: r3(expect.fuelKg) },
    after: { cargo: a.cargo.items, consumables: a.modules.consumables, cooldowns: a.modules.consumableCooldowns, propellant: a.propellant, processing: a.processing, hotbar: eq(a.modules.hotbar, b.modules.hotbar) },
    pass: k1.k?.status === "accepted" && k1.wrecks === 1 && !!batch && batch.committedKg > 0 && eq(k1.wreck.items, expect.items) && eq(k1.wreck.consumables, expect.consumables) &&
      Math.abs(k1.wreck.fuelKg - expect.fuelKg) < 1e-9 && eq(a.cargo.items, {}) && eq(a.modules.consumables, {}) && eq(a.modules.consumableCooldowns, {}) && eq(a.modules.hotbar, b.modules.hotbar) &&
      a.propellant.ordinaryKg === 0 && a.propellant.protectedKg === 60 && a.processing === null && a.isDead,
  };

  // Hard reload while dead: nothing duplicated or restored.
  await d.reload();
  await d.frames(10);
  const w1 = (await world()).wrecks;
  const pd = await player();
  const lossText = await ev(`document.querySelector("[data-testid=wreck-row]")?.textContent ?? ""`);
  out.reloadDead = {
    wrecks: w1.length, dead: pd.isDead, lossText,
    pass: w1.length === 1 && eq(w1[0], k1.wreck) && pd.isDead && eq(pd.cargo.items, {}) && eq(pd.modules.consumables, {}) && pd.propellant.ordinaryKg === 0 &&
      eq(pd.lastLoss?.items, k1.wreck.items) && /^Wreck/.test(lossText) && !/empty/.test(lossText),
  };

  // Recover via the death screen, then reload right away.
  const clicked = await clickRecover(ctx);
  const rec = await ctx.idb(id);
  await d.reload();
  await d.frames(10);
  const pr = await player();
  const w2 = (await world()).wrecks;
  const st = await ev(`${R}.starter()`);
  const em = await ev(`${R}.emergence(${JSON.stringify(st.positionKm)}, ${JSON.stringify(st.quaternion)}, 0)`);
  out.reloadRecovered = {
    clicked, savedAlive: rec.players[me].isDead === false, wrecks: w2.length, alive: !pr.isDead, frameId: pr.ship?.frameId, offStarterKm: pr.ship ? r3(dist(pr.ship.positionKm, em.positionKm)) : null,
    pass: clicked && rec.players[me].isDead === false && rec.players[me].lastLoss === null && w2.length === 1 && eq(w2[0], k1.wreck) && !pr.isDead && eq(pr.cargo.items, {}) && pr.propellant.ordinaryKg === 0 && pr.propellant.protectedKg === 60 &&
      pr.ship?.frameId === st.frameId && dist(pr.ship.positionKm, em.positionKm) < 0.05,
  };

  // Second death keeps the first wreck.
  await d.frames(30);
  await grant(ctx, { fe_ni_metal: 7 });
  await ev(`${G}.nudgeKm(0, 6, 0)`);
  await d.frames(10);
  const k2 = await ev(KILL);
  const w3 = (await world()).wrecks;
  out.secondDeath = { wrecks: w3.length, second: k2.wreck?.items, pass: k2.k?.status === "accepted" && w3.length === 2 && eq(w3[0], k1.wreck) && eq(k2.wreck.items, { fe_ni_metal: 7 }) && k2.wreck.fuelKg === 0 };

  // Abandon: the same transaction.
  await clickRecover(ctx);
  await waitArrival(ctx);
  await d.frames(10);
  await grant(ctx, { silicates: 3 });
  await ev(`${G}.nudgeKm(0, 0, 6)`);
  await d.frames(10);
  await ev(`${G}.res.set({ ordinaryKg: 100, protectedKg: 60 })`);
  const ab = await ev(`(() => { const before = ${G}.player(); const ok = ${G}.res.abandon(); return { before, ok, after: ${G}.player(), loss: ${R}.lastLoss(), wreck: ${G}.world().wrecks.at(-1), n: ${G}.world().wrecks.length }; })()`);
  out.abandon = {
    ok: ab.ok, cause: ab.loss?.cause, wreck: { items: ab.wreck.items, fuelKg: r3(ab.wreck.fuelKg) }, wrecks: ab.n,
    pass: ab.ok && ab.loss?.cause === "abandon" && ab.n === 3 && eq(ab.wreck.items, ab.before.cargo.items) && Math.abs(ab.wreck.fuelKg - 100) < 1e-9 && ab.after.isDead && ab.after.propellant.protectedKg === 60,
  };
  await clickRecover(ctx);
  await waitArrival(ctx);
  out.pass = Object.values(out).every((x) => x.pass);
  return out;
}
/** Kill away from everything, recover with the death screen (`selector`), wait for the arrival gate. */
async function dieAndRecover(d, ctx, opts = {}) {
  const { ev } = ctx;
  if (opts.nudge !== false) {
    const n = opts.nudge ?? [8, 0, 0];
    await ev(`${G}.nudgeKm(${n[0]}, ${n[1]}, ${n[2]})`);
    await d.frames(8);
  }
  const k = opts.die === false ? null : opts.abandon ? { k: { status: (await ev(`${G}.res.abandon()`)) ? "accepted" : "rejected" } } : await ev(KILL);
  await d.frames(5);
  let clicked;
  if (opts.fallback) {
    clicked = await clickRecover(ctx, ".death-screen__fallback");
    await d.frames(2);
    clicked = clicked && (await clickRecover(ctx, ".death-screen__fallback-confirm"));
  } else clicked = await clickRecover(ctx);
  const t0 = Date.now();
  const rt = await waitArrival(ctx);
  return { k, clicked, rt, waitedMs: Date.now() - t0, rec: await ev(`${R}.lastRecovery()`) };
}

const usable = async (ctx) => {
  const p = await ctx.player();
  const w = await ctx.world();
  return p.propellant.ordinaryKg + p.propellant.protectedKg + w.wrecks.reduce((a, x) => a + x.fuelKg, 0);
};

// ── (d) recovery ──
export async function recoverGates(d, ctx) {
  const { ev, player, world } = ctx;
  await freshWorld(d, ctx, "m36-recover");
  const out = {};
  await craftKits(ctx, 2);
  await findClearPreview(d, ctx);
  await ev(`${R}.place("Home")`);
  await ev(`${R}.setMode(false)`);
  const home = (await world()).replication.points.at(-1);
  const em = await ev(`${R}.emergence(${JSON.stringify(home.positionKm)}, ${JSON.stringify(home.quaternion)}, 0)`);
  await grant(ctx, { fe_ni_metal: 30, carbon: 4 });
  await ev(`${G}.res.set({ ordinaryKg: 200 })`);
  const pre = await player();
  const wPre = await world();
  await ev("__phys.impacts.clear()");
  const r1 = await dieAndRecover(d, ctx);
  const p1 = await player();
  const w1 = await world();
  const s1 = await ev(`${R}.ship()`);
  const rt1 = await ev(`${R}.runtime()`);
  const nf0 = rt1.nearField;
  const hp0 = await ev("__phys.game.health()");
  const ic0 = await ev("__phys.impacts.counters()");
  await ctx.wait(5000);
  const nf1 = (await ev(`${R}.runtime()`)).nearField;
  const hp1 = await ev("__phys.game.health()");
  const ic1 = await ev("__phys.impacts.counters()");
  const s2 = await ev(`${R}.ship()`);
  out.atPoint = {
    clicked: r1.clicked, arrivalMs: Math.round(r1.rt.lastArrivalMs), point: r1.rec?.pointName, fallback: r1.rec?.fallback ?? null, frameId: s1.frameId,
    offEmergenceKm: r3(dist(s1.posKm, em.positionKm)), fromPointKm: r3(dist(s1.posKm, home.positionKm)), speedMps: r3(Math.hypot(...s1.velKmps) * 1000), angVel: r3(Math.hypot(...s1.angVel)),
    hull: [p1.health, hp0.max], cargo: p1.cargo.items, fuel: p1.propellant, nearField: { suspended: rt1.nearField.suspended, owner: rt1.nearField.owner, reseeds: rt1.nearField.reseeds },
    pass: r1.clicked && r1.rec?.pointId === home.id && !r1.rec?.fallback && s1.frameId === home.frameId && dist(s1.posKm, em.positionKm) < 1e-3 && dist(s1.posKm, home.positionKm) <= 0.5 + 1e-6 &&
      Math.hypot(...s1.velKmps) === 0 && Math.hypot(...s1.angVel) === 0 && p1.health === hp0.max && eq(p1.cargo.items, {}) && p1.propellant.ordinaryKg === 0 && p1.propellant.protectedKg === 60 &&
      eq(p1.modules.ownedModules, pre.modules.ownedModules) && eq(p1.modules.equippedModules, pre.modules.equippedModules) && eq(w1.research, wPre.research) && eq(w1.discoveries, wPre.discoveries),
  };
  out.first5s = {
    impacts: ic1.impacts - ic0.impacts, touchedSteps: nf1.touchedSteps - nf0.touchedSteps, ownerViolations: nf1.ownerViolations, health: [hp0.health, hp1.health], driftM: r3(dist(s1.posKm, s2.posKm) * 1000), reseeds: nf1.reseeds,
    pass: ic1.impacts === ic0.impacts && nf1.touchedSteps === nf0.touchedSteps && nf1.ownerViolations === 0 && hp1.health === hp0.health && dist(s1.posKm, s2.posKm) < 1e-6,
  };
  out.runtimeClean = {
    shake: rt1.shake, throttle: rt1.throttle, mouse: [rt1.mouseYaw, rt1.mousePitch, rt1.stickX, rt1.stickY], transit: rt1.transitPhase, paused: rt1.paused, timedEffects: rt1.timedEffects,
    pass: rt1.shake === 0 && rt1.throttle === 0 && rt1.mouseYaw === 0 && rt1.mousePitch === 0 && rt1.stickX === 0 && rt1.stickY === 0 && rt1.transitPhase === "idle" && rt1.transitSpeed === 0 && !rt1.paused && rt1.timedEffects === 0,
  };

  // Obstructed default emergence: a point whose −Z offset sits 60 m off a rock.
  const rocks = await ev(`${R}.rocks(400)`);
  let obst = null;
  for (const rock of rocks.filter((r) => r.radiusM > 20 && r.radiusM < 400)) {
    const u = [0, 1, 0];
    const pos = [0, 1, 2].map((k) => rock.posKm[k] + u[k] * (rock.radiusM / 1000 + 0.56));
    const q = quatTo(u);
    const c = await ev(`${R}.check(${JSON.stringify(rock.frameId)}, ${JSON.stringify(pos)}, ${JSON.stringify(q)})`);
    if (c.refusal === "emergence_blocked" || c.refusal === "too_far") {
      const pr = await ev(`${R}.probe(${JSON.stringify(rock.frameId)}, ${JSON.stringify(pos)})`);
      if (pr.rockClearM >= 200) {
        obst = { id: "rp-obstructed", name: "Crowded", frameId: rock.frameId, positionKm: pos, quaternion: q, by: ctx.me, createdAt: 1, starter: false };
        break;
      }
    }
  }
  if (obst) {
    await ev(`${R}.devSetPoint(${JSON.stringify(obst)})`);
    await ev(`${R}.devSetActive("rp-obstructed")`);
    const r2 = await dieAndRecover(d, ctx);
    const s3 = await ev(`${R}.ship()`);
    const e2 = r2.rec ? await ev(`${R}.emergence(${JSON.stringify(obst.positionKm)}, ${JSON.stringify(obst.quaternion)}, ${r2.rec.candidate})`) : null;
    const clear = await ev(`${R}.probe(${JSON.stringify(s3.frameId)}, ${JSON.stringify(s3.posKm)})`);
    out.obstructed = {
      candidate: r2.rec?.candidate, fallback: r2.rec?.fallback ?? null, point: r2.rec?.pointId, shipRockClearM: r3(clear.rockClearM), offKm: e2 ? r3(dist(s3.posKm, e2.positionKm)) : null,
      pass: r2.rec?.pointId === "rp-obstructed" && r2.rec.candidate > 0 && !r2.rec.fallback && e2 && dist(s3.posKm, e2.positionKm) < 1e-3 && clear.rockClearM >= 120,
    };
  } else out.obstructed = { pass: false, why: "no rock found for the fixture" };

  // Missing and invalid active points fall back to the starter with a reason.
  const st = await ev(`${R}.starter()`);
  const stEm = await ev(`${R}.emergence(${JSON.stringify(st.positionKm)}, ${JSON.stringify(st.quaternion)}, 0)`);
  await ev(`${R}.devSetActive("rp-gone")`);
  const r3m = await dieAndRecover(d, ctx);
  const s4 = await ev(`${R}.ship()`);
  out.missing = { fallback: r3m.rec?.fallback, point: r3m.rec?.pointId, active: (await player()).replication.activeId, offStarterKm: r3(dist(s4.posKm, stEm.positionKm)),
    pass: r3m.rec?.fallback === "missing" && r3m.rec.pointId === "starter" && (await player()).replication.activeId === "starter" && s4.frameId === st.frameId && dist(s4.posKm, stEm.positionKm) < 0.01 };
  await ev(`${R}.devSetPoint(${JSON.stringify({ ...home, id: "rp-badframe", frameId: "nowhere" })})`);
  await ev(`${R}.devSetActive("rp-badframe")`);
  const r4 = await dieAndRecover(d, ctx);
  out.invalid = { fallback: r4.rec?.fallback, point: r4.rec?.pointId, active: (await player()).replication.activeId, pass: r4.rec?.fallback === "invalid" && r4.rec.pointId === "starter" && (await player()).replication.activeId === "rp-badframe" };

  // Isolated point in empty space (300,000 km out), stranded at zero fuel: explicit starter fallback.
  const earth = (await ev(`${G}.transit.bodies(["earth"])`)).earth;
  await ev(`${G}.nudgeKm(${earth.posKm[0]} - ${R}.ship().absKm[0], ${earth.posKm[1] + 300000} - ${R}.ship().absKm[1], ${earth.posKm[2]} - ${R}.ship().absKm[2])`);
  await d.frames(20);
  // Kits are loose consumables: the earlier deaths left the spare one at a wreck.
  await craftKits(ctx, 1);
  const pvF = await findClearPreview(d, ctx);
  const oF = await ev(`${R}.place("Far")`);
  await ev(`${R}.setMode(false)`);
  const far = (await world()).replication.points.at(-1);
  await ev(`${G}.res.set({ ordinaryKg: 0, protectedKg: 0 })`);
  const screen = await (async () => {
    const ok = await ev(`${G}.res.abandon()`);
    await d.frames(5);
    const text = await ev(`document.querySelector(".death-screen")?.innerText ?? ""`);
    return { ok, text };
  })();
  const r5 = await dieAndRecover(d, ctx, { nudge: false, fallback: true, die: false });
  const s5 = await ev(`${R}.ship()`);
  const p5 = await player();
  out.isolatedFallback = {
    placed: oF.status, preview: pvF.valid, farFrame: far.frameId, abandoned: screen.ok, offersFallback: /Respawn at Origin/i.test(screen.text), recovered: r5.rec?.pointId, fallback: r5.rec?.fallback,
    active: p5.replication.activeId, fuel: p5.propellant, offStarterKm: r3(dist(s5.posKm, stEm.positionKm)),
    pass: oF.status === "accepted" && screen.ok && /Respawn at Origin/i.test(screen.text) && r5.clicked && r5.rec?.pointId === "starter" && r5.rec.fallback === "chosen" && p5.replication.activeId === far.id &&
      p5.propellant.ordinaryKg === 0 && p5.propellant.protectedKg === 60 && dist(s5.posKm, stEm.positionKm) < 0.01,
  };

  // Ten die-recover cycles: usable fuel (tanks + every wreck) never rises.
  await ev(`${R}.deactivate()`);
  const states = [[0, 60], [200, 60], [150, 30], [80, 59.5], [0, 60], [50, 10], [300, 0], [0, 60], [61, 0], [10, 55]];
  const cycles = [];
  for (let i = 0; i < states.length; i++) {
    await ev(`${G}.res.set({ ordinaryKg: ${states[i][0]}, protectedKg: ${states[i][1]} })`);
    const before = await usable(ctx);
    const dir = [[7, 0, 0], [0, 7, 0], [0, 0, 7], [-7, 0, 0], [0, -7, 0]][i % 5];
    await dieAndRecover(d, ctx, { nudge: dir });
    const after = await usable(ctx);
    cycles.push([r3(before), r3(after)]);
  }
  out.cycles = { cycles, pass: cycles.every(([b, a]) => a <= b + 1e-6) };
  // The one free refill: a ship stranded below the allowance recovers with exactly the allowance.
  await ev(`${G}.res.set({ ordinaryKg: 0, protectedKg: 0 })`);
  const sb = await usable(ctx);
  await dieAndRecover(d, ctx, { nudge: [0, 0, -7] });
  const sa = await usable(ctx);
  const pf = await player();
  out.strandedEscape = { before: r3(sb), after: r3(sa), pass: Math.abs(sa - sb - 60) < 1e-6 && pf.propellant.protectedKg === 60 && pf.propellant.ordinaryKg === 0 };
  out.pass = Object.values(out).every((x) => x.pass);
  return out;
}
// ── (e) salvage ──
export async function salvageGates(d, ctx) {
  const { ev, submit, player, world, me } = ctx;
  const PATCH = "consumable_hull_patch_kit";
  const SINK = "consumable_heat_sink_cartridge";
  const st = await ev(`${R}.starter()`);
  const near = (dx) => [st.positionKm[0] + dx, st.positionKm[1] + 2, st.positionKm[2]];
  const hotbar = [null, PATCH, null, null, null, null, null, null, null, null];
  // A schema-4 fixture built by the real migration, then given wrecks and a nearly full ship.
  const data = await ev(`(() => {
    const a = ${G}.parse(${JSON.stringify(ctx.v1({ [me]: ctx.v1Player() }))});
    const p = a.players[${JSON.stringify(me)}];
    p.cargo.items = { silicates: 1960 };
    p.propellant = { ordinaryKg: 550, protectedKg: 60 };
    p.modules.consumables = { ${PATCH}: 10 };
    p.modules.hotbar = ${JSON.stringify(hotbar)};
    a.world.wrecks = [
      { id: "w-mixed", frameId: ${JSON.stringify(st.frameId)}, positionKm: ${JSON.stringify(near(40))}, items: { fe_ni_metal: 100, silicates: 20 }, fuelKg: 250, consumables: { ${KIT}: 2, ${PATCH}: 3 }, createdAt: 1 },
      { id: "w-fuel", frameId: ${JSON.stringify(st.frameId)}, positionKm: ${JSON.stringify(near(60))}, items: {}, fuelKg: 40, consumables: {}, createdAt: 2 },
      { id: "w-cons", frameId: ${JSON.stringify(st.frameId)}, positionKm: ${JSON.stringify(near(80))}, items: {}, fuelKg: 0, consumables: { ${SINK}: 2 }, createdAt: 3 },
    ];
    return a;
  })()`);
  const id = await ctx.fixture("m36-salvage", data);
  await ctx.boot(id);
  await d.frames(30);
  const out = {};
  const p0 = await player();
  const c1 = await submit({ type: "wreck.collect", opId: "m36-c1", wreckId: "w-mixed" });
  const p1 = await player();
  const w1 = (await world()).wrecks.find((w) => w.id === "w-mixed");
  const c1b = await submit({ type: "wreck.collect", opId: "m36-c1", wreckId: "w-mixed" });
  const p1b = await player();
  // A salvaged kit takes a free hotbar slot (D16) and a hint may be shown in between: neither is salvage state.
  const noHotbar = (p) => ({ ...p, commsPlayed: null, modules: { ...p.modules, hotbar: null } });
  out.partial = {
    status: c1.status, taken: c1.result?.taken, left: w1 && { items: w1.items, consumables: w1.consumables, fuelKg: w1.fuelKg }, fuel: p1.propellant, dup: c1b.status,
    pass: c1.status === "accepted" && eq(c1.result.taken.items, { fe_ni_metal: 40 }) && eq(c1.result.taken.consumables, { [KIT]: 2 }) && c1.result.taken.fuelKg === 50 && !c1.result.removed &&
      eq(w1.items, { fe_ni_metal: 60, silicates: 20 }) && eq(w1.consumables, { [PATCH]: 3 }) && w1.fuelKg === 200 && p1.propellant.ordinaryKg === 600 && p1.propellant.protectedKg === 60 &&
      p1.modules.consumables[PATCH] === 10 && p1.modules.consumables[KIT] === 2 && p1.cargo.items.fe_ni_metal === 40 && p0.propellant.protectedKg === 60 &&
      c1b.status === "duplicate" && eq(noHotbar(p1b), noHotbar(p1)) && p1b.modules.hotbar.includes(KIT),
  };
  // Nothing fits: refused, nothing changes.
  const c2 = await submit({ type: "wreck.collect", opId: "m36-c2", wreckId: "w-mixed" });
  out.full = { reason: c2.reason, pass: c2.reason === "no_capacity" && eq((await world()).wrecks.find((w) => w.id === "w-mixed"), w1) };

  // Markers before collecting the small wrecks.
  await d.frames(10);
  const pois = await ev(`${R}.pois("wreck:")`);
  const nameOf = (wid) => pois.find((p) => p.id === `wreck:${wid}`)?.name ?? null;
  out.markers = { mixed: nameOf("w-mixed"), fuel: nameOf("w-fuel"), cons: nameOf("w-cons"), pass: ["w-mixed", "w-fuel", "w-cons"].every((w) => nameOf(w) === "Wreck") }; // contents are on the Target Card (§1.11)

  // Make room the way a player does: jettison, burn, use three patch kits (slot 1 = hotbar key 2).
  await ev(`${G}.jettison("silicates")`);
  await ev(`${G}.res.set({ ordinaryKg: 0 })`);
  await ev("__phys.game.setHealth(20)");
  for (let i = 0; i < 6 && ((await player()).modules.consumables[PATCH] ?? 0) > 7; i++) {
    await d.press("2");
    await ctx.wait(300);
  }
  const p2 = await player();
  const c3 = await submit({ type: "wreck.collect", opId: "m36-c3", wreckId: "w-mixed" });
  const c4 = await submit({ type: "wreck.collect", opId: "m36-c4", wreckId: "w-fuel" });
  const pf = await player();
  const c5 = await submit({ type: "wreck.collect", opId: "m36-c5", wreckId: "w-cons" });
  const p3 = await player();
  const left = (await world()).wrecks.map((w) => w.id);
  out.complete = {
    patchesAfterUse: p2.modules.consumables[PATCH], mixed: c3.result?.removed, fuelOnly: c4.result?.taken.fuelKg, cons: c5.result?.taken.consumables, wrecksLeft: left, fuel: p3.propellant,
    pass: p2.modules.consumables[PATCH] === 7 && c3.status === "accepted" && c3.result.removed && c4.status === "accepted" && c4.result.removed && c4.result.taken.fuelKg === 40 &&
      c5.status === "accepted" && c5.result.removed && eq(c5.result.taken.consumables, { [SINK]: 2 }) && left.length === 0 && p3.propellant.ordinaryKg === 240 && p3.propellant.protectedKg === 60 &&
      pf.propellant.ordinaryKg === 240 && p3.modules.consumables[PATCH] === 10 && p3.cargo.items.fe_ni_metal === 100 && p3.cargo.items.silicates === 20,
  };
  // Reload: the removed wrecks stay removed, nothing re-awarded.
  await d.reload();
  await d.frames(10);
  const p4 = await player();
  out.reload = { wrecks: (await world()).wrecks.length, pass: (await world()).wrecks.length === 0 && eq(p4.cargo, p3.cargo) && eq(p4.modules.consumables, p3.modules.consumables) && Math.abs(p4.propellant.ordinaryKg - p3.propellant.ordinaryKg) < 1e-6 };
  out.pass = Object.values(out).every((x) => x.pass);
  return out;
}
// ── (f) migration ──
export async function migrate4Gates(d, ctx) {
  const { ev, me, v1, v1Player } = ctx;
  const js = (v) => JSON.stringify(v);
  const B = "player-b";
  const remote = { frameId: "luna", positionKm: [2100.75, 15.5, -8.25], quaternion: [0, 0, 0, 1] };
  const wreck = { id: "wreck-legacy-1", frameId: "earth", positionKm: [7100, 1, 2], items: { fe_ni_metal: 5 }, createdAt: 123 };
  const deltas = { origin_belt: { "1,2,3": [11, 12], unchunked: [99] } };
  const midCargo = { capacityUnits: 2000, items: { fe_ni_metal: 42, hydrates: 3 } };
  const v2Player = (o) => {
    const { research, ...rest } = v1Player(o);
    return { ...rest, research: { assaySamples: research.assaySamples, activeResearch: research.activeResearch }, propellant: { ordinaryKg: 321.5, protectedKg: 60 }, power: { capacitor01: 0.5, heat01: 0.25 }, processing: null };
  };
  const v2 = (players, completedNodes, world = {}) => ({
    schemaVersion: 2,
    world: { ...ctx.v1World(world), research: { completedNodes }, receipts: [], wrecks: (world.wrecks ?? []).map((w) => ({ fuelKg: 12.5, consumables: {}, ...w })) },
    players,
  });
  // Schema 3 = the shipped M3.3 record: a v4 parse minus the replication slices.
  const toV3 = async (raw) => {
    const a = await ev(`${G}.parse(${js(raw)})`);
    delete a.world.replication;
    for (const k of Object.keys(a.players)) delete a.players[k].replication;
    a.schemaVersion = 3;
    a.world.research = { completedNodes: ["sv1_composition_survey", "ex1_controlled_extraction"], legacy: ["zz_old"] };
    a.world.discoveries.trials = { first_batch: { at: 5, by: me } };
    return a;
  };
  const base = {
    fresh: (P) => ({ [me]: P({}) }),
    mid: (P) => ({ [me]: P({ ship: remote, cargo: midCargo }) }),
    multi: (P) => ({ [me]: P({}), [B]: P({ ship: remote, cargo: { capacityUnits: 2000, items: { sulfur: 8 } } }) }),
    dead: (P) => ({ [me]: P({ ship: remote, isDead: true, health: 0 }) }),
  };
  const worldOf = (k) => (k === "mid" || k === "dead" ? { asteroidDeltas: deltas, wrecks: [wreck] } : {});
  const fx = {};
  for (const k of Object.keys(base)) {
    fx[`v1${k}`] = { raw: v1(base[k](v1Player), worldOf(k)), v: 1, k };
    fx[`v2${k}`] = { raw: v2(base[k](v2Player), ["a1_sensor_calibration"], worldOf(k)), v: 2, k };
  }
  for (const k of Object.keys(base)) fx[`v3${k}`] = { raw: await toV3(fx[`v1${k}`].raw), v: 3, k };
  const starter = await ev(`${R}.starter()`);
  const res = {};
  for (const [name, f] of Object.entries(fx)) {
    const r = await ev(`(() => { const a = ${G}.parse(${js(f.raw)}); const b = ${G}.parse(a); const c = ${G}.parse(JSON.parse(JSON.stringify(b))); return { a, idempotent: JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(b) === JSON.stringify(c) }; })()`);
    const a = r.a;
    const c = { schema: a.schemaVersion === 9, idempotent: r.idempotent, starter: eq(a.world.replication.points, [starter]) };
    for (const pid of Object.keys(f.raw.players)) {
      const p = a.players[pid];
      const rp = f.raw.players[pid];
      c[`${pid}:active`] = p.replication.activeId === "starter";
      c[`${pid}:pose`] = eq(p.ship, rp.ship);
      c[`${pid}:cargo`] = eq(p.cargo, rp.cargo);
      if (f.v >= 2) c[`${pid}:fuel`] = eq(p.propellant, rp.propellant);
      c[`${pid}:dead`] = p.isDead === (rp.isDead === true);
    }
    c.deltas = eq(a.world.asteroidDeltas, f.raw.world.asteroidDeltas);
    c.wrecks = eq(a.world.wrecks.map((w) => [w.id, w.frameId, w.positionKm, w.items]), f.raw.world.wrecks.map((w) => [w.id, w.frameId, w.positionKm, w.items]));
    if (f.v === 3) c.research = eq(a.world.research, f.raw.world.research) && eq(a.world.discoveries, f.raw.world.discoveries);
    else c.research = eq(a.world.research.completedNodes, f.v === 2 ? ["sv1_composition_survey"] : []);
    const pass = Object.values(c).every((v) => v === true);
    res[name] = pass ? { pass } : { pass, c };
  }
  // Malformed replication slices sanitise safely.
  const v4 = await ev(`${G}.parse(${js(fx.v1fresh.raw)})`);
  v4.world.replication = { points: [{ id: "starter", name: "Moved", frameId: "earth", positionKm: [1, 2, 3], quaternion: [0, 0, 0, 1] }, { id: "rp-a", name: "A", frameId: "earth", positionKm: [1, NaN, 3], quaternion: [0, 0, 0, 1] }, { id: "rp-b", name: "  B  ", frameId: "nowhere", positionKm: [1, 2, 3], quaternion: [0, 0, 0, 2] }, { id: "rp-b", name: "dup", frameId: "earth", positionKm: [0, 0, 0], quaternion: [0, 0, 0, 1] }, 7] };
  v4.players[me].replication = { activeId: 7 };
  const mal = await ev(`(() => { const s = ${js(v4)}; s.world.replication.points[1].positionKm[1] = NaN; return ${G}.parse(s); })()`);
  res.malformed = {
    points: mal.world.replication.points.map((p) => [p.id, p.name, p.frameId]), active: mal.players[me].replication.activeId,
    pass: eq(mal.world.replication.points[0], starter) && eq(mal.world.replication.points.map((p) => p.id), ["starter", "rp-b"]) && mal.world.replication.points[1].name === "B" &&
      eq(mal.world.replication.points[1].quaternion, [0, 0, 0, 1]) && mal.players[me].replication.activeId === "starter",
  };
  // Real load path + export → import → export.
  const rt = {};
  for (const name of ["v1dead", "v2mid", "v3multi"]) {
    const id = await ctx.fixture(`m36-mig-${name}`, fx[name].raw);
    const j1 = await ev(`${G}.fixtures.export(${js(id)})`);
    const id2 = await ev(`${G}.fixtures.import(${js(j1)})`);
    ctx.created.push(id2);
    const j2 = await ev(`${G}.fixtures.export(${js(id2)})`);
    const x1 = JSON.parse(j1), x2 = JSON.parse(j2);
    const parsedDirect = await ev(`${G}.parse(${js(fx[name].raw)})`);
    rt[name] = { dataEqual: eq(x1.data, x2.data), matchesPureParse: eq(x1.data, parsedDirect), schema: x1.data.schemaVersion === 9 };
    rt[name].pass = rt[name].dataEqual && rt[name].matchesPureParse && rt[name].schema;
  }
  // A dead v1 save at a remote pose boots dead and recovers at the starter point.
  const deadId = await ctx.fixture("m36-mig-dead-boot", fx.v1dead.raw);
  await ctx.boot(deadId);
  await d.frames(10);
  const pd = await ctx.player();
  const shown = await ev(`document.querySelector(".death-screen__dest-name")?.textContent ?? null`);
  await clickRecover(ctx);
  const rtA = await waitArrival(ctx);
  const pa = await ctx.player();
  rt.deadBoot = { deadPose: pd.ship, shown, recovered: !pa.isDead, frameId: pa.ship?.frameId, arrivalMs: Math.round(rtA.lastArrivalMs), pass: pd.isDead && eq(pd.ship, remote) && shown === starter.name && !pa.isDead && pa.ship.frameId === starter.frameId && pa.propellant.protectedKg === 60 };
  // A live remote v2 save keeps its pose when booted.
  const liveId = await ctx.fixture("m36-mig-live-remote", fx.v2mid.raw);
  await ctx.boot(liveId);
  await d.frames(10);
  const pl = await ctx.player();
  rt.liveRemote = { frameId: pl.ship?.frameId, offKm: pl.ship ? r3(dist(pl.ship.positionKm, remote.positionKm)) : null, pass: pl.ship?.frameId === "luna" && dist(pl.ship.positionKm, remote.positionKm) < 0.01 && !pl.isDead };
  const bad = [
    "not json",
    js({ meta: { name: "x" }, data: { schemaVersion: 5, world: {}, players: {} } }),
    js({ meta: { name: "x" }, data: { schemaVersion: 0, world: {}, players: {} } }),
    js({ meta: { name: "x" }, data: { schemaVersion: 4, world: 5, players: {} } }),
    js({ meta: { name: "x" }, data: "nope" }),
  ];
  const refused = [];
  for (const b of bad) refused.push(await ev(`${G}.fixtures.import(${js(b)}).then((id) => "imported:" + id, (e) => "refused")`));
  rt.invalid = { refused, pass: refused.every((x) => x === "refused") };
  return { fixtures: res, roundtrip: rt, pass: Object.values(res).every((r) => r.pass) && Object.values(rt).every((r) => r.pass) };
}
/** Centre of the first element matching `selector` (optionally containing `text`), scrolled into view. */
export async function centerOf(ctx, selector, text) {
  return ctx.ev(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => !${JSON.stringify(text ?? null)} || e.textContent.includes(${JSON.stringify(text ?? "")}));
    const e = els[0];
    if (!e) return null;
    e.scrollIntoView({ block: "center" });
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
}

/** Real-input flight towards a moving frame-relative target: W to close, X to brake near it. */
export async function flyTo(d, ctx, frameId, posKm, stopKm, maxS = 60, done = async () => false) {
  const { ev } = ctx;
  const t0 = Date.now();
  let nav = null;
  while (Date.now() - t0 < maxS * 1000) {
    if (await done()) return { reached: true, s: (Date.now() - t0) / 1000, nav };
    const abs = await ev(`${R}.abs(${JSON.stringify(frameId)}, ${JSON.stringify(posKm)})`);
    await ev(`${G}.res.face(${JSON.stringify(abs)})`);
    nav = await ev(`${G}.res.nav(${JSON.stringify(abs)})`);
    if (nav.distKm <= stopKm && nav.speedMps < 5) return { reached: true, s: (Date.now() - t0) / 1000, nav };
    const brakeKm = (nav.speedMps * nav.speedMps) / (2 * 60) / 1000 + 0.15;
    if (nav.distKm - stopKm <= brakeKm && nav.speedMps > 3) await d.hold("x", 200);
    else if (nav.distKm > stopKm) await d.hold("w", 200);
    else await d.hold("x", 200);
  }
  return { reached: false, s: (Date.now() - t0) / 1000, nav };
}

// ── (g) live: real inputs end to end ──
export async function live36Gates(d, ctx) {
  const { ev, player, world } = ctx;
  await freshWorld(d, ctx, "m36-live");
  const T = {};
  const out = {};
  const t = () => Date.now();
  let t0 = t();
  // Craft a kit in the crafting panel (C, click the kit's Craft button). Material granted (mining is gated elsewhere).
  await grant(ctx, { fe_ni_metal: 150, silicates: 100 });
  await d.press("c");
  await d.frames(10);
  const btn = await centerOf(ctx, ".crafting-panel__item", "Replication Kit");
  const craftBtn = btn && (await ev(`(() => { const it = [...document.querySelectorAll(".crafting-panel__item")].find((e) => e.textContent.includes("Replication Kit")); const b = it?.querySelector(".crafting-panel__craft-btn"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`));
  if (craftBtn) await d.click(craftBtn.x, craftBtn.y);
  await d.frames(10);
  await d.press("c");
  const kits = (await player()).modules.consumables[KIT] ?? 0;
  T.craftS = (t() - t0) / 1000;
  out.craft = { kits, pass: kits === 1 };

  // Fly out ~3 km with W, brake with X.
  t0 = t();
  const s0 = await ev(`${R}.ship()`);
  await d.hold("w", 2500);
  for (let i = 0; i < 20 && (await ev(`${R}.ship()`)).velKmps.some((v) => Math.abs(v) > 0.002); i++) await d.hold("x", 300);
  const s1 = await ev(`${R}.ship()`);
  T.flyOutS = (t() - t0) / 1000;
  out.flyOut = { km: r3(dist(s0.posKm, s1.posKm)), pass: dist(s0.posKm, s1.posKm) > 0.3 };

  // Place: open the preview with its hotbar key, focus and type a name, then press Enter (D16).
  t0 = t();
  const kitSlot = (await player()).modules.hotbar.indexOf(KIT);
  out.kitSlot = kitSlot;
  await d.press(String((kitSlot + 1) % 10));
  await ctx.wait(400);
  let pv = await ev(`${R}.preview()`);
  for (let i = 0; i < 6 && !pv.valid; i++) {
    await d.hold("d", 600);
    await ctx.wait(300);
    pv = await ev(`${R}.preview()`);
  }
  await d.press("Tab");
  out.inputFocused = await ev(`!!document.activeElement?.matches('.placement-card[data-placement="point"] input')`);
  await d.type("Forward camp");
  await d.press("Enter");
  await d.frames(10);
  const point = (await world()).replication.points.at(-1);
  const pPlaced = await player();
  T.placeS = (t() - t0) / 1000;
  out.place = { preview: pv.valid, refusal: pv.check.refusal, name: point?.name, active: pPlaced.replication.activeId === point?.id, kits: pPlaced.modules.consumables[KIT] ?? 0, pass: point?.name === "Forward camp" && pPlaced.replication.activeId === point.id && !(pPlaced.modules.consumables[KIT] > 0) };

  // Fly on, carrying cargo, then ram a rock until the impact destroys the ship.
  t0 = t();
  await grant(ctx, { fe_ni_metal: 33, carbon: 5 });
  await d.hold("w", 1500);
  const rocks = await ev(`${R}.rocks(200)`);
  const rock = rocks.find((r) => r.radiusM > 60 && r.distKm > 0.6) ?? rocks[0];
  out.rockKm = { km: r3(rock.distKm), devShortcut: rock.distKm > 6 };
  if (rock.distKm > 6) {
    // Dev shortcut to bring a rock within a short run (the belt is sparse); documented.
    const a = await ev(`${R}.abs(${JSON.stringify(rock.frameId)}, ${JSON.stringify(rock.posKm)})`);
    const sh = await ev(`${R}.ship()`);
    const k = 1 - 4 / rock.distKm;
    await ev(`${G}.nudgeKm(${(a[0] - sh.absKm[0]) * k}, ${(a[1] - sh.absKm[1]) * k}, ${(a[2] - sh.absKm[2]) * k})`);
    await d.frames(30);
  }
  const preDeath = await player();
  let dead = false;
  const tRam = t();
  while (!dead && t() - tRam < 40000) {
    const abs = await ev(`${R}.abs(${JSON.stringify(rock.frameId)}, ${JSON.stringify(rock.posKm)})`);
    await ev(`${G}.res.face(${JSON.stringify(abs)})`);
    await d.hold("w", 250);
    dead = (await player()).isDead;
  }
  const wreck = (await world()).wrecks.at(-1);
  T.flyOnAndDieS = (t() - t0) / 1000;
  const impacts = await ev("__phys.impacts.log()");
  out.die = { dead, wreckItems: wreck?.items, wreckFuelKg: r3(wreck?.fuelKg), lastImpact: impacts.at(-1) && { dvMps: r3(impacts.at(-1).dvMps), fatal: impacts.at(-1).fatal }, pass: dead && !!wreck && eq(wreck.items, preDeath.cargo.items) && impacts.at(-1)?.fatal === true };

  // Recover with a real click on the death screen.
  t0 = t();
  await ctx.wait(2500);
  const rb = await centerOf(ctx, ".death-screen__respawn");
  if (rb) await d.click(rb.x, rb.y);
  const arr = await waitArrival(ctx);
  const sR = await ev(`${R}.ship()`);
  const em = await ev(`${R}.emergence(${JSON.stringify(point.positionKm)}, ${JSON.stringify(point.quaternion)}, 0)`);
  const pR = await player();
  T.recoverS = (t() - t0) / 1000;
  out.recover = { at: (await ev(`${R}.lastRecovery()`))?.pointName, offKm: r3(dist(sR.posKm, em.positionKm)), arrivalMs: Math.round(arr.lastArrivalMs), fuel: pR.propellant, pass: !pR.isDead && dist(sR.posKm, em.positionKm) < 0.05 && pR.propellant.protectedKg === 60 && pR.propellant.ordinaryKg === 0 };

  // Fly back to the wreck on the protected allowance; the tractor beam collects it.
  t0 = t();
  const gone = async () => !(await world()).wrecks.some((w) => w.id === wreck.id);
  const fly = await flyTo(d, ctx, wreck.frameId, wreck.positionKm, 0.15, 90, gone);
  for (let i = 0; i < 20 && !(await gone()); i++) await ctx.wait(500);
  const pC = await player();
  T.collectS = (t() - t0) / 1000;
  out.collect = { reached: fly.reached, flightS: r3(fly.s), cargo: pC.cargo.items, fuel: { ordinaryKg: r3(pC.propellant.ordinaryKg), protectedKg: r3(pC.propellant.protectedKg) }, wreckGone: await gone(),
    pass: (await gone()) && eq(pC.cargo.items, wreck.items) && pC.propellant.ordinaryKg <= wreck.fuelKg + 1e-6 && wreck.fuelKg - pC.propellant.ordinaryKg < 1 && pC.propellant.protectedKg <= 60 };
  out.timings = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, r3(v)]));
  out.pass = Object.values(out).every((x) => x.pass !== false);
  return out;
}
// ── (h) captures ──
export async function m36ShotGates(d, ctx, narrow) {
  const { ev, world } = ctx;
  await freshWorld(d, ctx, "m36-shots");
  const shots = {};
  await craftKits(ctx, 1);
  await ev(`${G}.nudgeKm(4, 1, 0)`);
  await d.frames(20);
  const pv = await findClearPreview(d, ctx);
  await ctx.wait(400);
  if (!narrow) shots.preview = await d.shot("m3-replication-preview");
  else shots.previewNarrow = await d.shot("m3-replication-preview-narrow");
  await ev(`${R}.place("Forward camp")`);
  await ev(`${R}.setMode(false)`);
  // View it from the side, 0.6 km off, so the model is not hidden behind its own marker.
  const placed = (await world()).replication.points.at(-1);
  await ev(`${R}.teleportRel(${JSON.stringify(placed.frameId)}, ${JSON.stringify([placed.positionKm[0] + 0.45, placed.positionKm[1] + 0.12, placed.positionKm[2] + 0.3])})`);
  await d.frames(10);
  const pAbs = await ev(`${R}.abs(${JSON.stringify(placed.frameId)}, ${JSON.stringify(placed.positionKm)})`);
  await ev(`${G}.res.face(${JSON.stringify(pAbs)})`);
  await ev(`${G}.res.face(${JSON.stringify(pAbs)})`);
  await ctx.wait(800);
  if (!narrow) shots.placed = await d.shot("m3-replication-placed");

  // Death with cargo and fuel, away from the point.
  await grant(ctx, { fe_ni_metal: 33, carbon: 5 });
  await ev(`${G}.nudgeKm(5, 0, 0)`);
  await d.frames(10);
  await ev(KILL);
  await ctx.wait(2600);
  shots.death = await d.shot(narrow ? "m3-death-recovery-screen-narrow" : "m3-death-recovery-screen");
  if (narrow) {
    await clickRecover(ctx, ".death-screen__fallback");
    await ctx.wait(200);
    shots.fallbackNarrow = await d.shot("m3-death-fallback-confirm-narrow");
    return { previewValid: pv.valid, shots };
  }
  await clickRecover(ctx);
  await waitArrival(ctx);
  await d.frames(30);

  // Emergency abandon confirmation in the settings menu, carrying something to lose.
  await grant(ctx, { hydrates: 12, silicates: 40 });
  await ev(`${G}.res.set({ ordinaryKg: 180 })`);
  await d.press("Escape");
  await ctx.wait(400);
  const ab = await ev(`(() => { const b = [...document.querySelectorAll(".settings-menu__button--danger")].find((e) => e.dataset.action === "respawn"); if (!b) return false; b.click(); return true; })()`);
  await ctx.wait(300);
  shots.abandon = await rawShot(d, "m3-abandon-confirm");
  const cancelled = await ev(`(() => { const b = document.querySelector('[data-action="respawn-cancel"]'); if (!b) return false; b.click(); return true; })()`);
  await ctx.wait(200);
  const abandonCancel = { cancelled, confirmClosed: await ev(`!document.querySelector(".settings-menu__abandon")`), alive: !(await ctx.player()).isDead };
  abandonCancel.pass = abandonCancel.cancelled && abandonCancel.confirmClosed && abandonCancel.alive;
  await d.press("Escape");
  await d.frames(10);

  // Partial wreck recovery: hold nearly full, fly in, the beam takes what fits.
  const wreck = (await world()).wrecks.at(-1);
  const p = await ctx.player();
  const used = sum(p.cargo.items);
  const cap = (await ev(`${G}.mirrors()`)).cargoCapacity;
  await grant(ctx, { silicates: cap - used - 20 });
  await ev(`${G}.teleportToWreck(${JSON.stringify(wreck.id)}, 120)`);
  await d.frames(10);
  const wAbs = await ev(`${R}.abs(${JSON.stringify(wreck.frameId)}, ${JSON.stringify(wreck.positionKm)})`);
  await ev(`${G}.res.face(${JSON.stringify(wAbs)})`);
  let left = wreck;
  for (let i = 0; i < 20; i++) {
    await ctx.wait(400);
    left = (await world()).wrecks.find((w) => w.id === wreck.id);
    if (!left || sum(left.items) < sum(wreck.items)) break;
  }
  await ctx.wait(600);
  shots.wreckPartial = await d.shot("m3-wreck-partial");
  return { previewValid: pv.valid, abandonOpened: ab, abandonCancel, wreckLeft: left?.items ?? null, shots };
}
