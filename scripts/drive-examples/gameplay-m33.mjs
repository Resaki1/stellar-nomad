/**
 * M3.3 / M3.4 gates (parts of gameplay-check.mjs; needs --no-isolate):
 *   audit      content audit (cycles, reachability, capacity, no helium-3 gate, no lunar-only basics)
 *   evidence   findings: once per family/source, repeats grant nothing, depletion, survival, bound
 *   reqs       every option: exact evidence unlocks once; each missing piece is named
 *   playA / playB   fresh-save playthroughs (survey first / extraction+cooling first) to transit
 *   config     loadout preview vs the deterministic resource harness and hand-computed tables
 *   migrate3   schema 1 and 2 fixtures → 3 (mapping table, inert legacy, round trip, refusals)
 *   fit        loadout swaps vs fuel/cargo, forged inspect/mine claims, bookmark-protected eviction
 *   marks      B3/B4: bookmark → mine drops marker and bookmark; Set destination sticks with a marker, absent without the drive
 *   m33shots   captures (1280×720); m33narrow the research panel at 390×844 (--size 390x844)
 */
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const G = "__test.gameplay";
const r3 = (x) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : x);
const sum = (o) => Object.values(o ?? {}).reduce((a, v) => a + v, 0);
const familiesOf = (comp) => {
  const t = sum(comp);
  return Object.keys(comp).filter((k) => comp[k] > 0 && comp[k] / t >= 0.03).sort();
};

function diffPaths(a, b, path = "", out = []) {
  if (out.length >= 6) return out;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    if (!eq(a, b)) out.push(`${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`);
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], `${path}.${k}`, out);
  if (!eq(Object.keys(a), Object.keys(b))) out.push(`${path}: key order`);
  return out;
}

export async function loadedRocks(ctx, n = 3000) {
  let rocks = [];
  for (let i = 0; i < 60 && rocks.length < 50; i++) {
    rocks = await ctx.ev(`${G}.m33.rocks(${n})`);
    if (rocks.length < 50) await ctx.wait(250);
  }
  return rocks;
}

async function freshWorld(d, ctx, name) {
  const id = await ctx.fixture(name, ctx.v1({ [ctx.me]: ctx.v1Player() }));
  await ctx.boot(id);
  await d.scene("belt");
  await d.frames(60);
  return id;
}

export async function auditGates(d, ctx) {
  const a = await ctx.ev(`${G}.m33.audit()`);
  return { ...a, pass: a.pass };
}

// ── fit: loadout swaps vs fuel/cargo, forged claims, bookmark-protected eviction ──
export async function fitGates(d, ctx) {
  const { ev, submit, me } = ctx;
  const id = await ctx.fixture("m33-fit", ctx.v1({ [me]: ctx.v1Player(), "player-b": ctx.v1Player() }));
  await ctx.boot(id);
  await d.scene("belt");
  await d.frames(30);
  const F = {};
  const cargoSlot = async () => (await ctx.player()).modules.equippedModules.cargo ?? null;
  await ev(`${G}.res.equip("module_cargo_rack_mk1", "cargo")`);
  await ev(`${G}.res.equip("module_aux_tank_mk1", "cargo")`);
  await ev(`${G}.res.set({ ordinaryKg: 1000 })`);
  const swap = await ev(`${G}.m33.equipOp("module_cargo_rack_mk1", "cargo")`);
  const empty = await ev(`${G}.m33.equipOp(null, "cargo")`);
  const keptAux = await cargoSlot();
  await ev(`${G}.res.set({ ordinaryKg: 500 })`);
  const swapOk = await ev(`${G}.m33.equipOp("module_cargo_rack_mk1", "cargo")`);
  F.tank = { swap: swap.reason, empty: empty.reason, keptAux, swapOk: swapOk.status,
    pass: swap.reason === "tank_overflow" && empty.reason === "tank_overflow" && keptAux === "module_aux_tank_mk1" && swapOk.status === "accepted" && (await cargoSlot()) === "module_cargo_rack_mk1" };
  const p0 = await ctx.player();
  const cap = await ev(`${G}.mirrors().cargoCapacity`);
  const used = Object.values(p0.cargo.items).reduce((a, v) => a + v, 0);
  const fill = await submit({ type: "asteroid.mine", fieldId: "fit-field", chunkKey: "0,0,0", instanceId: 900001, yield: { silicates: cap - used } });
  const toAux = await ev(`${G}.m33.equipOp("module_aux_tank_mk1", "cargo")`);
  const unRack = await ev(`${G}.m33.equipOp(null, "cargo")`);
  F.cargo = { cap, fill: fill.status, toAux: toAux.reason, unRack: unRack.reason, pass: toAux.reason === "cargo_overflow" && unRack.reason === "cargo_overflow" && (await cargoSlot()) === "module_cargo_rack_mk1" };

  const inspectOp = (instanceId, composition) => ({ type: "survey.inspect", fieldId: "fit-field", chunkKey: "1,0,0", instanceId, classId: "s_type", radiusM: 20, frameId: "earth", positionKm: [7000, 0, 0], composition });
  const fake = await submit(inspectOp(1, { unobtainium: 50, silicates: 50 }));
  const many = {};
  for (let i = 0; i < 50; i++) many[`m${i}`] = 100;
  const spam = await submit(inspectOp(2, many));
  const mineFake = await submit({ type: "asteroid.mine", fieldId: "fit-field", chunkKey: "2,0,0", instanceId: 3, yield: { helium_4: 1 } });
  F.forged = { fake: fake.reason, spam: spam.reason, mineFake: mineFake.reason, families: Object.keys((await ctx.world()).discoveries.families),
    pass: fake.reason === "invalid" && spam.reason === "invalid" && mineFake.reason === "invalid" };

  // A (mine) and B (player-b) are bookmarked; 70 more inspections must not evict them. A depleted
  // source cannot be bookmarked since WP1 B4, so A stays unmined.
  const srcId = (i) => `fit-field:1,0,0:${i}`;
  const okA = await submit(inspectOp(10, { silicates: 90, fe_ni_metal: 10 }));
  const okB = await submit(inspectOp(11, { silicates: 90, fe_ni_metal: 10 }));
  await submit(inspectOp(12, { silicates: 90, fe_ni_metal: 10 }));
  await submit({ type: "asteroid.mine", fieldId: "fit-field", chunkKey: "1,0,0", instanceId: 12, yield: {} });
  const bmA = await ev(`${G}.m33.bookmark(${JSON.stringify(srcId(10))}, "A")`);
  const bmB = await submit({ type: "bookmark.set", sourceId: srcId(11), name: "B" }, "player-b");
  for (let i = 0; i < 70; i++) await submit(inspectOp(100 + i, { silicates: 90, fe_ni_metal: 10 }));
  const w = await ctx.world();
  const ids = new Set(w.discoveries.sources.map((s) => s.id));
  F.bookmarks = { okA: okA.status, okB: okB.status, bmA: bmA.status, bmB: bmB.status, count: ids.size, keptA: ids.has(srcId(10)), keptB: ids.has(srcId(11)), evictedDepleted: !ids.has(srcId(12)),
    pass: bmA.status === "accepted" && bmB.status === "accepted" && ids.size === 64 && ids.has(srcId(10)) && ids.has(srcId(11)) && !ids.has(srcId(12)) };

  // Class evidence survives the ring: the only (depleted, oldest) C-type outlives 70 more S-type inspections.
  const cOp = { ...inspectOp(13, { hydrates: 60, carbon: 40 }), classId: "c_type" };
  const cMet = async () => (await ev(`${G}.m33.evaluate("pr1_transit_calibration")`)).all.find((r) => r.key === "sourceClass:c_type")?.met;
  const okC = await submit(cOp);
  await submit({ type: "asteroid.mine", fieldId: "fit-field", chunkKey: "1,0,0", instanceId: 13, yield: {} });
  const cMet0 = await cMet();
  for (let i = 0; i < 70; i++) await submit(inspectOp(300 + i, { silicates: 90, fe_ni_metal: 10 }));
  const w2 = await ctx.world();
  const cKept = w2.discoveries.sources.some((s) => s.id === srcId(13));
  const cMet1 = await cMet();
  F.classKept = { okC: okC.status, count: w2.discoveries.sources.length, cKept, cMet0, cMet1,
    pass: okC.status === "accepted" && w2.discoveries.sources.length === 64 && cKept && cMet0 === true && cMet1 === true };
  return { ...F, pass: Object.values(F).every((x) => x.pass) };
}

// ── marks: B4 bookmark of a mined rock, B3 Set destination with and without the drive ──
export async function marksGates(d, ctx) {
  const { ev } = ctx;
  const out = {};
  await freshWorld(d, ctx, "m33-marks");
  const rocks = (await loadedRocks(ctx, 40)).filter((r) => r.radiusM > 8);
  const id = (r) => `${r.fieldId}:${r.chunkKey}:${r.instanceId}`;
  const [a, b] = rocks;
  const ia = await ev(`${G}.m33.inspect(${JSON.stringify(a)})`);
  const ib = await ev(`${G}.m33.inspect(${JSON.stringify(b)})`);
  const bm = await ev(`${G}.m33.bookmark(${JSON.stringify(id(a))}, "B4 test")`);
  await d.frames(20);
  const poiBefore = await ev(`${G}.rep.pois("source:")`);
  const m = await ev(`${G}.mine(${JSON.stringify(a)})`);
  await d.frames(30);
  const poiAfter = await ev(`${G}.rep.pois("source:")`);
  const marksAfter = (await ev(`${G}.player()`)).bookmarks;
  out.b4 = { inspect: ia.status, bookmark: bm.status, mine: m.status, poiBefore: poiBefore.length, poiAfter: poiAfter.length, bookmarksAfter: marksAfter.length,
    pass: ia.status === "accepted" && bm.status === "accepted" && m.status === "accepted" && poiBefore.some((p) => p.id === `source:${id(a)}`) && poiAfter.length === 0 && marksAfter.length === 0 };

  // B3 without the drive: refused by the action, and the Discoveries tab shows no button.
  const noDrive = await ev(`${G}.m33.setDestination(${JSON.stringify(id(b))})`);
  await d.frames(60);
  const targetedNo = (await ev(`${G}.transit.state()`)).targeted;
  await ev(`(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" })); return true; })()`);
  await d.frames(10);
  await ev(`(() => { const t = [...document.querySelectorAll(".rp-tabs__btn")].find((x) => x.textContent === "Discoveries"); t && t.click(); return !!t; })()`);
  await d.frames(10);
  const btnNo = await ev(`document.querySelectorAll('.rp-source__btn[aria-label="Set destination"]').length`);
  const rowsNo = await ev(`document.querySelectorAll(".rp-source").length`);
  // With the drive: the button shows, the target sticks for 60 frames and has a projected marker.
  await ev(`${G}.m33.setLoadout(["special_transit_drive"])`);
  await d.frames(10);
  const btnYes = await ev(`document.querySelectorAll('.rp-source__btn[aria-label="Set destination"]').length`);
  await ev(`(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" })); return true; })()`);
  await d.frames(10);
  const yes = await ev(`${G}.m33.setDestination(${JSON.stringify(id(b))})`);
  await d.frames(60);
  const targetedYes = (await ev(`${G}.transit.state()`)).targeted;
  const poiYes = await ev(`${G}.rep.pois("source:")`);
  out.b3 = { inspect: ib.status, noDrive, targetedNo, rowsNo, btnNo, btnYes, yes, targetedYes, marker: poiYes.map((p) => p.id),
    pass: ib.status === "accepted" && noDrive === false && targetedNo === null && rowsNo >= 1 && btnNo === 0 && btnYes >= 1 && yes === true && targetedYes === `source:${id(b)}` && poiYes.some((p) => p.id === `source:${id(b)}`) };
  // Review F2: mining the destination rock clears the destination and leaves no marker.
  const mb = await ev(`${G}.mine(${JSON.stringify(b)})`);
  await d.frames(30);
  const targetedAfter = (await ev(`${G}.transit.state()`)).targeted;
  const poiGone = await ev(`${G}.rep.pois("source:")`);
  out.b3mined = { mine: mb.status, targetedAfter, markers: poiGone.length, pass: mb.status === "accepted" && targetedAfter === null && poiGone.length === 0 };
  // Review F1: a bookmark of a rock destroyed by a non-mining cause stops holding a slot.
  const c = rocks[2], e = rocks[3];
  await ev(`${G}.m33.inspect(${JSON.stringify(c)})`);
  await ev(`${G}.m33.inspect(${JSON.stringify(e)})`);
  await ev(`${G}.m33.bookmark(${JSON.stringify(id(c))}, "F1 c")`);
  const ds = await ev(`${G}.submit({ type: "asteroid.destroy", fieldId: ${JSON.stringify(c.fieldId)}, chunkKey: ${JSON.stringify(c.chunkKey)}, instanceId: ${c.instanceId}, cause: "collision" })`);
  const be = await ev(`${G}.m33.bookmark(${JSON.stringify(id(e))}, "F1 e")`);
  const marks = (await ev(`${G}.player()`)).bookmarks.map((x) => x.sourceId);
  out.destroyPrune = { destroy: ds.status, bookmark: be.status, marks, pass: ds.status === "accepted" && be.status === "accepted" && marks.length === 1 && marks[0] === id(e) };
  out.pass = out.b4.pass && out.b3.pass && out.b3mined.pass && out.destroyPrune.pass;
  return out;
}

// ── (a) evidence ────────────────────────────────────────────────────────────
export async function evidenceGates(d, ctx) {
  const { ev, me } = ctx;
  const id = await freshWorld(d, ctx, "m33-evidence");
  const rocks = await loadedRocks(ctx);
  const disc = async () => (await ctx.world()).discoveries;
  const E = {};

  // Mining an uninspected rock confirms its families by extraction, once each.
  // No hydrate family: the last slot takes the rounding remainder, so a small S-type can reach 3 %.
  const s1 = rocks.find((r) => r.classId === "s_type" && r.radiusM > 15 && !familiesOf(r.composition).includes("hydrates"));
  const known = new Set(familiesOf(s1.composition));
  const s2 = rocks.find((r) => r !== s1 && r.classId === "s_type" && familiesOf(r.composition).every((f) => known.has(f)));
  const d0 = await disc();
  const m1 = await ev(`${G}.mine(${JSON.stringify(s1)})`);
  const d1 = await disc();
  const m2 = await ev(`${G}.mine(${JSON.stringify(s2)})`);
  const d2 = await disc();
  E.mineFamilies = {
    first: m1.result?.newFamilies, records: Object.keys(d1.families).length, second: m2.result?.newFamilies, unchanged: eq(d1, d2),
    pass: Object.keys(d0.families).length === 0 && m1.status === "accepted" && eq(m1.result.newFamilies, [...known]) && Object.keys(d1.families).length === known.size &&
      m2.status === "accepted" && m2.result.newFamilies.length === 0 && eq(d1, d2),
  };

  // Inspection: new source + hydrates once; same rock again records nothing; same opId → duplicate.
  const c1 = rocks.find((r) => r.classId === "c_type" && familiesOf(r.composition).includes("hydrates") && r.radiusM > 15);
  const cFam = new Set([...known, ...familiesOf(c1.composition)]);
  // Another rock of the same families: nothing it holds is new or newly inspected.
  const c1Fam = new Set(familiesOf(c1.composition));
  const c2 = rocks.find((r) => r !== c1 && r.classId === "c_type" && familiesOf(r.composition).every((f) => c1Fam.has(f)));
  void cFam;
  await ev(`${G}.m33.approach(${JSON.stringify(c1)}, 0.8)`);
  const i1 = await ev(`${G}.m33.inspect(${JSON.stringify(c1)}, "insp-1")`);
  const d3 = await disc();
  const w3 = await ctx.world();
  const i2 = await ev(`${G}.m33.inspect(${JSON.stringify(c1)}, "insp-2")`);
  const i1dup = await ev(`${G}.m33.inspect(${JSON.stringify(c1)}, "insp-1")`);
  const d4 = await disc();
  const i3 = await ev(`${G}.m33.inspect(${JSON.stringify(c2)}, "insp-3")`);
  const d5 = await disc();
  const w5 = await ctx.world();
  E.inspect = {
    first: { status: i1.status, newFamilies: i1.result?.newFamilies, upgraded: i1.result?.upgraded, sources: d3.sources.length },
    repeat: i2.reason, dup: i1dup.status, other: { status: i3.status, newFamilies: i3.result?.newFamilies, sources: d5.sources.length },
    unlocksUnchanged: eq(w3.research.completedNodes, w5.research.completedNodes) && w5.research.completedNodes.length === 0,
    pass: i1.status === "accepted" && i1.result.newFamilies.includes("hydrates") && d3.sources.length === 1 && i2.status === "rejected" && i2.reason === "already_done" &&
      i1dup.status === "duplicate" && eq(d3, d4) && i3.status === "accepted" && i3.result.newFamilies.length === 0 && i3.result.upgraded.length === 0 &&
      eq(d4.families, d5.families) && d5.sources.length === 2 && w5.research.completedNodes.length === 0,
  };

  // Mining the inspected rock: source kept, depleted; no new family.
  const m3 = await ev(`${G}.mine(${JSON.stringify(c1)})`);
  const d6 = await disc();
  const srcId = `${c1.fieldId}:${c1.chunkKey}:${c1.instanceId}`;
  const src = d6.sources.find((s) => s.id === srcId);
  E.depleted = {
    depletedSource: m3.result?.depletedSource, depleted: src?.depleted, composition: src?.composition, families: Object.keys(d6.families).length,
    pass: m3.status === "accepted" && m3.result.depletedSource === srcId && src?.depleted === true && eq(src.composition, c1.composition) && m3.result.newFamilies.length === 0 && Object.keys(d6.families).length === Object.keys(d5.families).length,
  };

  // Survival: death + respawn, hard reload, world switch.
  const before = await disc();
  const k = await ev(`${G}.kill()`);
  const resp = await ctx.submit({ type: "ship.respawn", opId: "m33-resp", mode: "active" });
  const afterDeath = await disc();
  await d.reload();
  await d.frames(5);
  const afterReload = await disc();
  const other = await ctx.fixture("m33-evidence-other", ctx.v1({ [me]: ctx.v1Player() }));
  await ctx.boot(other);
  const otherDisc = await disc();
  await ctx.boot(id);
  const afterSwitch = await disc();
  E.survive = {
    kill: k?.status, respawn: resp.status, otherWorldEmpty: otherDisc.sources.length === 0 && Object.keys(otherDisc.families).length === 0,
    same: [eq(before, afterDeath), eq(before, afterReload), eq(before, afterSwitch)],
    diff: eq(before, afterReload) ? null : diffPaths(before, afterReload),
    pass: k?.status === "accepted" && resp.status === "accepted" && eq(before, afterDeath) && eq(before, afterReload) && eq(before, afterSwitch) &&
      otherDisc.sources.length === 0 && Object.keys(otherDisc.families).length === 0,
  };

  // Bound: 200 scripted inspections of distinct loaded rocks.
  await d.scene("belt");
  await d.frames(30);
  await loadedRocks(ctx);
  const flood = await ev(`(() => {
    const rocks = ${G}.m33.rocks(1200);
    const out = { accepted: 0, rejected: 0, tried: 0 };
    for (const r of rocks) {
      if (out.tried >= 200) break;
      const o = ${G}.m33.inspect(r);
      if (o.status === "missing") continue;
      out.tried++;
      if (o.status === "accepted") out.accepted++; else out.rejected++;
    }
    return out;
  })()`);
  const wf = await ctx.world();
  E.bound = {
    ...flood, sources: wf.discoveries.sources.length, families: Object.keys(wf.discoveries.families).length, receipts: wf.receipts.length,
    pass: flood.tried === 200 && wf.discoveries.sources.length <= 64 && Object.keys(wf.discoveries.families).length <= 7 && wf.receipts.length <= 256,
  };
  return { ...E, pass: Object.values(E).every((x) => x.pass) };
}

// ── (b) requirements ───────────────────────────────────────────────────────
function evidenceFor(node, me, omit) {
  const discoveries = { families: {}, sources: [], sites: {}, trials: {} };
  const completedNodes = [];
  const reqs = [...node.all, ...(node.any ? [node.any[0]] : [])];
  const keyOf = (r) =>
    r.kind === "family" ? `family:${r.material}${r.inspected ? ":inspected" : ""}` : r.kind === "sourceClass" ? `sourceClass:${r.classId}` : `${r.kind}:${r.trialId ?? r.siteId ?? r.nodeId}`;
  let i = 0;
  for (const r of reqs) {
    const isAny = node.any && r === node.any[0];
    if (omit && (isAny ? omit.startsWith("any:") : keyOf(r) === omit)) continue;
    if (r.kind === "family") discoveries.families[r.material] = { firstAt: 1, by: me, inspected: !!r.inspected, extracted: !r.inspected, sourceId: null };
    if (r.kind === "sourceClass")
      discoveries.sources.push({ id: `origin_belt:0,0,0:${++i}`, fieldId: "origin_belt", chunkKey: "0,0,0", asteroidId: i, classId: r.classId, frameId: "earth", positionKm: [0, 0, 0], radiusM: 10, composition: {}, depleted: false, foundAt: 1, by: me });
    if (r.kind === "trial") discoveries.trials[r.trialId] = { at: 1, by: me };
    if (r.kind === "site") discoveries.sites[r.siteId] = { at: 1, by: me };
    if (r.kind === "research") completedNodes.push(r.nodeId);
  }
  const keys = node.all.map(keyOf);
  if (node.any) keys.push(`any:${node.any.map(keyOf).join("|")}`);
  return { discoveries, completedNodes, keys };
}

export async function reqGates(d, ctx) {
  const { ev, me } = ctx;
  await freshWorld(d, ctx, "m33-reqs");
  const ids = await ev(`${G}.m33.nodeIds()`);
  const out = {};
  const clearCargo = async () => {
    for (const r of Object.keys((await ctx.player()).cargo.items)) await ev(`${G}.jettison(${JSON.stringify(r)})`);
  };
  const grant = async (items) => {
    for (const [r, n] of Object.entries(items)) await ev(`__dev.grantCargo(${JSON.stringify(r)}, ${n})`);
  };
  for (const nid of ids) {
    const node = await ev(`${G}.m33.node(${JSON.stringify(nid)})`);
    const full = evidenceFor(node, me, null);
    const row = { pieces: full.keys.length, missingNamed: [] };
    // Missing any one piece: rejected, the reason names that piece, nothing spent.
    for (const key of full.keys) {
      const part = evidenceFor(node, me, key);
      await ev(`${G}.m33.devSetWorld(${JSON.stringify({ discoveries: part.discoveries, completedNodes: part.completedNodes })})`);
      await clearCargo();
      await grant(node.analysis);
      const c0 = (await ctx.player()).cargo.items;
      const o = await ctx.submit({ type: "research.unlock", nodeId: nid });
      const c1 = (await ctx.player()).cargo.items;
      row.missingNamed.push({ key, reason: o.reason, named: (o.evidence ?? []).includes(key), unspent: eq(c0, c1) });
    }
    // Analysis material short: rejected naming the material.
    if (Object.keys(node.analysis).length > 0) {
      await ev(`${G}.m33.devSetWorld(${JSON.stringify({ discoveries: full.discoveries, completedNodes: full.completedNodes })})`);
      await clearCargo();
      const o = await ctx.submit({ type: "research.unlock", nodeId: nid });
      row.material = { reason: o.reason, missing: o.missing, named: eq(Object.keys(o.missing ?? {}).sort(), Object.keys(node.analysis).sort()) };
    }
    // Exactly its evidence: unlocks once; retry → duplicate; new id → already_done.
    await ev(`${G}.m33.devSetWorld(${JSON.stringify({ discoveries: full.discoveries, completedNodes: full.completedNodes })})`);
    await clearCargo();
    await grant(node.analysis);
    const opId = `unlock-${nid}`;
    const u1 = await ctx.submit({ type: "research.unlock", opId, nodeId: nid });
    const u2 = await ctx.submit({ type: "research.unlock", opId, nodeId: nid });
    const u3 = await ctx.submit({ type: "research.unlock", nodeId: nid });
    const w = await ctx.world();
    const left = (await ctx.player()).cargo.items;
    row.unlock = [u1.status, u2.status, u3.reason];
    row.count = w.research.completedNodes.filter((x) => x === nid).length;
    row.analysisSpent = sum(left) === 0;
    row.pass = u1.status === "accepted" && u2.status === "duplicate" && u3.reason === "already_done" && row.count === 1 && row.analysisSpent &&
      row.missingNamed.every((m) => m.reason === "evidence" && m.named && m.unspent) && (!row.material || (row.material.reason === "materials" && row.material.named));
    out[nid] = row.pass ? { pass: true, pieces: row.pieces } : row;
  }
  const audit = await ev(`${G}.m33.audit()`);
  return { nodes: out, audit: { pass: audit.pass }, pass: Object.values(out).every((r) => r.pass) && audit.pass };
}

// ── (c) playthroughs ───────────────────────────────────────────────────────

/** Jettison by-products beyond `need` when the hold has less than `minFree` room (what a player does). */
export async function trimHold(ctx, need, minFree = 300) {
  const p = await ctx.player();
  const cap = await ctx.ev(`${G}.mirrors().cargoCapacity`);
  if (cap - sum(p.cargo.items) >= minFree) return 0;
  let dropped = 0;
  for (const [k, n] of Object.entries(p.cargo.items)) {
    const extra = n - (need[k] ?? 0);
    if (extra > 0) {
      await ctx.ev(`${G}.jettison(${JSON.stringify(k)}, ${extra})`);
      dropped += extra;
    }
  }
  return dropped;
}

/** Mine (fast-forward, accepted operations) nearest rocks until `need` is in cargo; `trim` drops surplus when the hold fills. */
export async function gather(ctx, rocks, need, used, trim = false) {
  const { ev } = ctx;
  let ops = 0;
  for (let guard = 0; guard < 400; guard++) {
    if (trim) await trimHold(ctx, need);
    const have = (await ctx.player()).cargo.items;
    const short = Object.keys(need).filter((k) => (have[k] ?? 0) < need[k]);
    if (short.length === 0) return ops;
    const r = rocks.find((x) => !used.has(x.instanceId) && short.some((k) => (x.composition[k] ?? 0) >= Math.min(need[k] - (have[k] ?? 0), k === "hydrates" || k === "carbon" ? 1 : 5)));
    if (!r) throw new Error(`no rock for ${short.join(",")}`);
    used.add(r.instanceId);
    const o = await ev(`${G}.mine(${JSON.stringify(r)})`);
    if (o.status === "accepted") ops++;
  }
  throw new Error("gather guard");
}

/** Real manoeuvring (W then brake) until at least `kg` of ordinary propellant has been used. */
export async function burnFuel(d, ctx, kg) {
  const start = (await ctx.ev(`${G}.res.state()`)).ordinaryKg;
  for (let i = 0; i < 12; i++) {
    const now = (await ctx.ev(`${G}.res.state()`)).ordinaryKg;
    if (start - now >= kg) break;
    await d.hold("w", 3500);
    await d.hold("x", 4500);
  }
  return start - (await ctx.ev(`${G}.res.state()`)).ordinaryKg;
}

export async function waitFor(ctx, fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await ctx.wait(250);
  }
  return false;
}

/** A live sustained beam on a large cold-mineable metal rock (the extraction trial), inspected first. */
export async function liveSustainedBeam(d, ctx, rocks, used) {
  const { ev } = ctx;
  const big = rocks.find((x) => !used.has(x.instanceId) && x.mineS >= 9.5 && x.mineS < 13.5 && x.distKm < 30 && familiesOf(x.composition).includes("fe_ni_metal"));
  used.add(big.instanceId);
  await ev(`${G}.m33.approach(${JSON.stringify(big)}, ${big.radiusM / 1000 + 0.35})`);
  await d.frames(10);
  const inspect = await ev(`${G}.m33.inspect(${JSON.stringify(big)})`);
  await ev(`${G}.res.face(${JSON.stringify(big)})`);
  const focused = await waitFor(ctx, async () => (await ev(`${G}.res.mining()`)).focused, 8000);
  await ev(`${G}.res.startMining()`);
  const trial = await waitFor(ctx, async () => !!(await ctx.world()).discoveries.trials.sustained_beam, 16000);
  await waitFor(ctx, async () => !(await ev(`${G}.res.mining()`)).mining, 8000);
  return { label: "live sustained beam", inspect: inspect.status, focused, trial, mineS: r3(big.mineS) };
}

/** Inspect the nearest unused rock of `cls` (C-type: one carrying hydrates). */
export async function inspectClass(d, ctx, rocks, used, cls) {
  const r = rocks.find((x) => x.classId === cls && !used.has(x.instanceId) && (cls !== "c_type" || familiesOf(x.composition).includes("hydrates")));
  used.add(r.instanceId);
  await ctx.ev(`${G}.m33.approach(${JSON.stringify(r)}, ${r.radiusM / 1000 + 0.5})`);
  await d.frames(5);
  return ctx.ev(`${G}.m33.inspect(${JSON.stringify(r)})`);
}

/**
 * The shared path from any start to an owned transit drive (playtest-1 matrix, plan §13 WP2):
 * sustained beam, C-type, first batch (the 200 kg start tank has room), Heat Rejection, Bulk
 * Handling + Cargo Rack, Transit Drive Calibration, the drive, then the Auxiliary Tank fitted
 * (playtest 2: the Moon needs more than the base tank). `accept(label, outcome)` logs.
 */
export async function pathToDrive(d, ctx, rocks, used, accept) {
  const { ev } = ctx;
  const w = await ctx.world();
  const okOf = (b) => ({ status: b ? "accepted" : "failed" });
  if (!w.discoveries.trials.sustained_beam) {
    const b = await liveSustainedBeam(d, ctx, rocks, used);
    accept("live sustained beam", okOf(b.focused && b.trial));
  }
  if (!(w.discoveries.sources ?? []).some((s) => s.classId === "c_type")) accept("inspect c_type", await inspectClass(d, ctx, rocks, used, "c_type"));
  const done = new Set((await ctx.world()).research.completedNodes);
  const owned = new Set((await ctx.player()).modules.ownedModules);
  if (!done.has("th1_heat_rejection")) {
    await gather(ctx, rocks, { silicates: 30 }, used, true);
    accept("unlock th1", await ev(`${G}.m33.unlock("th1_heat_rejection")`));
  }
  if (!(await ctx.world()).discoveries.trials.first_fabrication) {
    await gather(ctx, rocks, { silicates: 20, fe_ni_metal: 5 }, used, true);
    accept("craft heat sink", await ev(`${G}.craft("consumable_heat_sink_cartridge")`));
  }
  await gather(ctx, rocks, { hydrates: 1 }, used, true);
  accept("process 1 unit", await ev(`${G}.res.startProcessing(1)`));
  accept("first batch trial", okOf(await waitFor(ctx, async () => !!(await ctx.world()).discoveries.trials.first_batch, 15000)));
  await gather(ctx, rocks, { fe_ni_metal: 30 + 150, silicates: 50 }, used, true);
  accept("unlock lg1", await ev(`${G}.m33.unlock("lg1_bulk_handling")`));
  if (!owned.has("module_cargo_rack_mk1")) accept("craft cargo rack", await ev(`${G}.craft("module_cargo_rack_mk1")`));
  await gather(ctx, rocks, { hydrates: 15, fe_ni_metal: 40 }, used, true);
  accept("unlock pr1", await ev(`${G}.m33.unlock("pr1_transit_calibration")`));
  await gather(ctx, rocks, { silicates: 600, fe_ni_metal: 550, hydrates: 30, carbon: 20, sulfur: 12 }, used, true);
  accept("craft drive", await ev(`${G}.craft("special_transit_drive")`));
  // Playtest 2: Earth -> Moon needs more than the base tank; the Auxiliary Tank replaces the rack.
  if (!owned.has("module_aux_tank_mk1")) {
    await gather(ctx, rocks, { fe_ni_metal: 120, silicates: 40 }, used, true);
    accept("craft aux tank", await ev(`${G}.craft("module_aux_tank_mk1")`));
  }
  await fitAuxTank(ctx, accept);
}

/** Equip the Auxiliary Tank, jettisoning what no longer fits the smaller hold (a player would). */
export async function fitAuxTank(ctx, accept) {
  const { ev } = ctx;
  if ((await ctx.player()).modules.equippedModules.cargo === "module_aux_tank_mk1") return;
  let o = await ev(`${G}.m33.equipOp("module_aux_tank_mk1", "cargo")`);
  if (o?.status !== "accepted") {
    const items = (await ctx.player()).cargo.items;
    for (const k of ["silicates", "sulfur", "carbon", "titanium", "fe_ni_metal"]) if ((items[k] ?? 0) > 0) await ev(`${G}.jettison(${JSON.stringify(k)})`);
    o = await ev(`${G}.m33.equipOp("module_aux_tank_mk1", "cargo")`);
  }
  accept("equip aux tank", o);
}

/** Fill the tank with local hydrates (one batch up to the batch cap), waiting for it to finish. */
export async function topUp(ctx, rocks, used, accept) {
  const { ev } = ctx;
  const T = await ev(`${G}.m33.liveTuning()`);
  const room = Math.min(T.processingMaxBatchUnits, Math.floor((T.tankKg - (await ev(`${G}.res.state()`)).ordinaryKg) / T.processingKgPerUnit));
  if (room <= 0) return 0;
  await gather(ctx, rocks, { hydrates: room }, used, true);
  accept(`process ${room} units`, await ev(`${G}.res.startProcessing(${room})`));
  // The Auxiliary Tank's room is a long batch (38 units = 76 s at 10 kg/s).
  const batchMs = ((room * T.processingKgPerUnit) / T.processingKgPerS) * 1000 + 10000;
  await waitFor(ctx, async () => !(await ev(`${G}.res.state()`)).processing.active, batchMs);
  return room;
}

async function playthrough(d, ctx, path) {
  const { ev } = ctx;
  await freshWorld(d, ctx, `m33-play-${path}`);
  // A v1 fixture migrates with a full tank; a new world starts at 200 kg (§13 WP2).
  await ev(`${G}.res.set({ ordinaryKg: 200 })`);
  const w0 = await ctx.world();
  const p0 = await ctx.player();
  const rocks = await loadedRocks(ctx);
  const used = new Set();
  const steps = [];
  const accept = (label, o) => {
    steps.push({ label, status: o?.status, reason: o?.reason, evidence: o?.evidence, missing: o?.missing });
    return o?.status === "accepted";
  };

  if (path === "A") {
    // Survey first: inspect one rock of each class, then the prospector scanner.
    for (const cls of ["s_type", "c_type", "x_type"]) accept(`inspect ${cls}`, await inspectClass(d, ctx, rocks, used, cls));
    await gather(ctx, rocks, { silicates: 140, fe_ni_metal: 40 }, used);
    accept("unlock sv1", await ev(`${G}.m33.unlock("sv1_composition_survey")`));
    accept("craft prospector", await ev(`${G}.craft("module_prospector_scanner_mk1")`));
  } else {
    // Extraction/cooling first: one inspected, sustained live beam on a large cold-mineable rock.
    steps.push(await liveSustainedBeam(d, ctx, rocks, used));
    await gather(ctx, rocks, { fe_ni_metal: 30 + 90 + 40, silicates: 30 + 80 + 140 }, used);
    accept("unlock ex1", await ev(`${G}.m33.unlock("ex1_controlled_extraction")`));
    accept("unlock th1", await ev(`${G}.m33.unlock("th1_heat_rejection")`));
    accept("craft focuser", await ev(`${G}.craft("module_beam_focuser_mk1")`));
    accept("craft radiator", await ev(`${G}.craft("module_radiator_strips_mk1")`));
  }
  // Before the drive exists, a premature unlock is refused naming the missing research.
  const early = await ev(`${G}.m33.unlock("pr1_transit_calibration")`);
  await pathToDrive(d, ctx, rocks, used, accept);
  await topUp(ctx, rocks, used, accept);
  await ev(`${G}.m33.targetBody("luna")`);
  await d.frames(10);
  const pv = await ev(`${G}.transit.preview()`);
  const w1 = await ctx.world();
  const p1 = await ctx.player();
  const receipts = w1.receipts.slice(w0.receipts.length);
  const byType = {};
  for (const r of receipts) byType[r.type] = (byType[r.type] ?? 0) + 1;
  const owned = p1.modules.ownedModules;
  const res = {
    steps: steps.filter((s) => s.status !== "accepted" && s.ok !== true && s.trial !== true),
    earlyPr1: { status: early?.status, reason: early?.reason, evidence: early?.evidence },
    operations: { total: receipts.length, byType },
    unlocked: w1.research.completedNodes, owned, trials: Object.keys(w1.discoveries.trials), families: Object.keys(w1.discoveries.families),
    fuel: { startKg: r3(p0.propellant.ordinaryKg), endKg: r3(p1.propellant.ordinaryKg) },
    moon: pv ? { ok: pv.ok, reason: pv.reason, etaS: r3(pv.etaS), fuelKg: r3(pv.fuelKg), arrivalOrdinaryKg: r3(pv.arrivalOrdinaryKg), legs: pv.legCount } : null,
    cargoLeft: p1.cargo.items,
  };
  const first = path === "A" ? ["sv1_composition_survey"] : ["ex1_controlled_extraction", "th1_heat_rejection"];
  res.pass = steps.every((s) => s.status === undefined || s.status === "accepted") && steps.every((s) => s.ok !== false && s.trial !== false && s.focused !== false) &&
    early?.status === "rejected" && early.reason === "evidence" && (early.evidence ?? []).includes("research:lg1_bulk_handling") &&
    first.every((n) => w1.research.completedNodes.includes(n)) && w1.research.completedNodes.includes("pr1_transit_calibration") && owned.includes("special_transit_drive") &&
    !!pv && pv.ok && pv.fuelKg > 0 && pv.arrivalOrdinaryKg >= 0 && p0.propellant.ordinaryKg === 200;
  if (!res.pass) res.allSteps = steps;
  return res;
}

export const playGates = (d, ctx, path) => playthrough(d, ctx, path);

// ── (d) effective config ───────────────────────────────────────────────────
const LOADOUTS = {
  starter: [],
  focuser: ["module_beam_focuser_mk1"],
  radiator: ["module_radiator_strips_mk1"],
  coolantCell: ["module_coolant_circulator_mk1", "module_electrolysis_cell_mk1"],
  hotTank: ["module_beam_focuser_mk1", "module_coolant_circulator_mk1", "module_aux_tank_mk1", "module_electrolysis_cell_mk1"],
  survey: ["module_radiator_strips_mk1", "module_cargo_rack_mk1", "module_prospector_scanner_mk1"],
};
/** Hand-computed from the content table (M3.2 law: trip ∝ capacity / heat mult, cooling ∝ capacity / cooling mult). */
const HAND = {
  starter: { tankKg: 600, cargo: 2000, reactorKW: 100, miningKW: 50, procKgS: 10, trip: 15, cool: 10 },
  focuser: { tankKg: 600, cargo: 2000, reactorKW: 100, miningKW: 65, procKgS: 10, trip: 15 / 1.3, cool: 10 },
  radiator: { tankKg: 600, cargo: 2000, reactorKW: 100, miningKW: 50, procKgS: 10, trip: 15 / 0.8, cool: 10 / 1.15 },
  coolantCell: { tankKg: 600, cargo: 2000, reactorKW: 125, miningKW: 50, procKgS: 16, trip: 15 * 1.25, cool: (10 * 1.25) / 1.4 },
  hotTank: { tankKg: 1000, cargo: 1500, reactorKW: 125, miningKW: 65, procKgS: 16, trip: (15 * 1.25) / 1.3, cool: (10 * 1.25) / 1.4 },
  survey: { tankKg: 600, cargo: 2600, reactorKW: 100, miningKW: 50, procKgS: 10, trip: 15 / 0.8, cool: 10 / 1.15 },
};

export async function configGates(d, ctx) {
  const { ev } = ctx;
  await freshWorld(d, ctx, "m33-config");
  const out = {};
  const near = (a, b, tol) => a !== null && b !== null && Math.abs(a - b) <= tol;
  for (const [name, ids] of Object.entries(LOADOUTS)) {
    const pv = await ev(`${G}.m33.preview(${JSON.stringify(ids)})`);
    const hot = await ev(`${G}.res.simulate({ equipped: ${JSON.stringify(ids)}, segments: [{ mining: true, seconds: 60 }], sampleEvery: 1 })`);
    const cold = await ev(`${G}.res.simulate({ equipped: ${JSON.stringify(ids)}, start: { heat01: 1 }, segments: [{ seconds: 40 }], sampleEvery: 1 })`);
    const simTrip = hot.segments[0].firstTripS;
    const simCool = cold.segments[0].trace.find((s) => s.heat01 <= 0)?.t ?? null;
    // Live: equip for real, read the panel's preview and the step's table.
    await ev(`${G}.m33.setLoadout(${JSON.stringify(ids)})`);
    await d.frames(5);
    const live = await ev(`${G}.m33.livePreview()`);
    const lt = await ev(`${G}.m33.liveTuning()`);
    const cap = (await ev(`${G}.mirrors()`)).cargoCapacity;
    const h = HAND[name];
    const step = 1 / 120 + 1e-9;
    const row = {
      preview: { reactorKW: pv.reactorKW, tankKg: pv.tankKg, cargo: pv.cargoUnits, trip: r3(pv.miningTripS), cool: r3(pv.coolDownS), miningKW: pv.miningKW, procKgS: r3(pv.processingKgPerS) },
      sim: { trip: r3(simTrip), cool: r3(simCool) },
      live: { tankKg: lt.tankKg, reactorKW: lt.reactorKW, cargo: cap, trip: r3(live.miningTripS) },
      hand: { ...h, trip: r3(h.trip), cool: r3(h.cool) },
    };
    row.pass = near(pv.miningTripS, simTrip, step) && near(pv.coolDownS, simCool, step) && near(pv.miningTripS, h.trip, 0.02) && near(pv.coolDownS, h.cool, 0.02) &&
      pv.tankKg === h.tankKg && pv.cargoUnits === h.cargo && pv.reactorKW === h.reactorKW && near(pv.miningKW, h.miningKW, 1e-9) && near(pv.processingKgPerS, h.procKgS, 1e-9) &&
      lt.tankKg === h.tankKg && lt.reactorKW === h.reactorKW && cap === h.cargo && near(live.miningTripS, pv.miningTripS, 1e-9);
    out[name] = row;
  }
  return { ...out, pass: Object.values(out).every((r) => r.pass) };
}

// ── (e) migration ──────────────────────────────────────────────────────────
export async function migrate3Gates(d, ctx) {
  const { ev, me, v1, v1Player } = ctx;
  const js = (v) => JSON.stringify(v);
  const remote = { frameId: "luna", positionKm: [2100.75, 15.5, -8.25], quaternion: [0, 0, 0, 1] };
  const wreck = { id: "wreck-legacy-1", frameId: "earth", positionKm: [7100, 1, 2], items: { fe_ni_metal: 5 }, createdAt: 123 };
  const deltas = { origin_belt: { "1,2,3": [11, 12], unchunked: [99] } };
  const midModules = {
    ownedModules: ["module_prospector_scanner_mk1", "module_spectral_mapper_mk1", "module_beam_focuser_mk2", "module_radiator_strips_mk2", "module_assay_enhancer_mk1", "special_transit_drive", "module_from_future"],
    equippedModules: { scanner: "module_spectral_mapper_mk1", mining: "module_beam_focuser_mk2", cooling: "module_radiator_strips_mk2", utility: "module_assay_enhancer_mk1" },
    consumables: { consumable_assay_probe: 3, consumable_thermal_purge: 2, consumable_heat_sink_cartridge: 3, consumable_emergency_repair_kit: 2, consumable_hull_patch_kit: 1, consumable_unknown: 2 },
    consumableCooldowns: {},
    hotbar: ["consumable_assay_probe", "consumable_thermal_purge", "consumable_heat_sink_cartridge", null, null, null, null, null, null, null],
  };
  const midResearch = { assaySamples: 7, activeResearch: { nodeId: "c2a_hull_reinforcement", elapsedS: 50 } };
  const midCompleted = ["r0_microlab_boot", "a1_sensor_calibration", "b1_laser_optics", "b2b_thermal_dynamics", "c1_structural_engineering", "m1_transit_drive", "zz_unknown"];
  const expectMid = {
    completed: ["sv1_composition_survey", "ex1_controlled_extraction", "th1_heat_rejection", "lg1_bulk_handling", "pr1_transit_calibration", "hl1_hull_reinforcement"],
    legacyNodes: ["zz_unknown"],
    owned: ["module_prospector_scanner_mk1", "module_beam_focuser_mk1", "module_radiator_strips_mk1", "special_transit_drive"],
    equipped: { scanner: "module_prospector_scanner_mk1", mining: "module_beam_focuser_mk1", cooling: "module_radiator_strips_mk1" },
    consumables: { consumable_heat_sink_cartridge: 5, consumable_hull_patch_kit: 5 },
    hotbar: [null, "consumable_heat_sink_cartridge", null, null, null, null, null, null, null, null],
    legacy: { assaySamples: 7, activeResearch: null, items: ["module_assay_enhancer_mk1", "module_from_future"], consumables: { consumable_assay_probe: 3, consumable_unknown: 2 } },
  };
  const midCargo = { capacityUnits: 2000, items: { fe_ni_metal: 42, helium_3: 3 } };
  const v2Player = (o) => {
    const { research, ...rest } = v1Player(o);
    return { ...rest, research: { assaySamples: research.assaySamples, activeResearch: research.activeResearch }, propellant: { ordinaryKg: 321.5, protectedKg: 60 }, power: { capacitor01: 0.5, heat01: 0.25 }, processing: null, ...(o.v2 ?? {}) };
  };
  const v2 = (players, completedNodes, world = {}) => ({
    schemaVersion: 2,
    world: { ...ctx.v1World(world), research: { completedNodes }, receipts: [{ opId: "old-1", type: "item.craft", by: me, at: 1 }], wrecks: (world.wrecks ?? []).map((w) => ({ fuelKg: 12.5, consumables: {}, ...w })) },
    players,
  });
  const fx = {
    v1fresh: { raw: v1({ [me]: v1Player() }), v: 1 },
    v1mid: { raw: v1({ [me]: v1Player({ ship: remote, cargo: midCargo, research: { ...midResearch, completedNodes: midCompleted }, modules: midModules }) }, { asteroidDeltas: deltas, wrecks: [wreck] }), v: 1, mid: true },
    v1multi: {
      raw: v1({
        [me]: v1Player({ research: { assaySamples: 0, completedNodes: ["a1_sensor_calibration"], activeResearch: null } }),
        "player-b": v1Player({ research: { assaySamples: 4, completedNodes: ["b1_laser_optics", "zz_future"], activeResearch: { nodeId: "zz_unmappable", elapsedS: 9 } } }),
      }),
      v: 1, multi: true,
    },
    v1dead: { raw: v1({ [me]: v1Player({ ship: remote, isDead: true, health: 0 }) }, { wrecks: [wreck] }), v: 1, dead: true },
    v2fresh: { raw: v2({ [me]: v2Player({}) }, []), v: 2 },
    v2mid: { raw: v2({ [me]: v2Player({ ship: remote, cargo: midCargo, research: { ...midResearch }, modules: midModules }) }, midCompleted, { asteroidDeltas: deltas, wrecks: [wreck] }), v: 2, mid: true },
    v2multi: {
      raw: v2({ [me]: v2Player({}), "player-b": v2Player({ research: { assaySamples: 4, activeResearch: { nodeId: "zz_unmappable", elapsedS: 9 } } }) }, ["a1_sensor_calibration", "b1_laser_optics", "zz_future"]),
      v: 2, multi: true,
    },
    v2dead: { raw: v2({ [me]: v2Player({ ship: remote, isDead: true, health: 0 }) }, [], { wrecks: [wreck] }), v: 2, dead: true },
  };
  const res = {};
  for (const [name, f] of Object.entries(fx)) {
    const r = await ev(`(() => { const a = ${G}.parse(${js(f.raw)}); const b = ${G}.parse(a); const c = ${G}.parse(JSON.parse(JSON.stringify(b))); return { a, idempotent: JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(b) === JSON.stringify(c) }; })()`);
    const a = r.a;
    const p = a.players[me];
    const rp = f.raw.players[me];
    const c = {
      schema: a.schemaVersion === 7, idempotent: r.idempotent, pose: eq(p.ship, rp.ship), cargo: eq(p.cargo, rp.cargo), deltas: eq(a.world.asteroidDeltas, f.raw.world.asteroidDeltas),
      wrecks: eq(a.world.wrecks.map((w) => [w.id, w.items, w.positionKm, w.frameId]), f.raw.world.wrecks.map((w) => [w.id, w.items, w.positionKm, w.frameId])),
      noResearchSlice: !("research" in p), discoveriesEmpty: eq(a.world.discoveries, { families: {}, sources: [], sites: {}, trials: {}, inspectedSites: {} }),
      propellant: f.v === 2 ? eq(p.propellant, rp.propellant) : p.propellant.ordinaryKg === 600,
    };
    if (f.mid) {
      c.completed = eq(a.world.research.completedNodes, expectMid.completed);
      c.legacyNodes = eq(a.world.research.legacy, expectMid.legacyNodes);
      c.owned = eq(p.modules.ownedModules, expectMid.owned);
      c.equipped = eq(p.modules.equippedModules, expectMid.equipped);
      c.consumables = eq(p.modules.consumables, expectMid.consumables);
      c.hotbar = eq(p.modules.hotbar, expectMid.hotbar);
      c.legacy = !!p.legacy && eq({ ...p.legacy, notes: undefined }, { ...expectMid.legacy, notes: undefined }) && p.legacy.notes.length > 0;
    }
    if (f.multi) {
      const b = a.players["player-b"];
      c.union = eq(a.world.research.completedNodes, ["sv1_composition_survey", "ex1_controlled_extraction"]) && eq(a.world.research.legacy, ["zz_future"]);
      c.inertActive = !!b.legacy && eq(b.legacy.activeResearch, { nodeId: "zz_unmappable", elapsedS: 9 }) && b.legacy.assaySamples === 4 && p.legacy === null;
    }
    if (f.dead) c.dead = p.isDead === true && p.health === 0;
    const pass = Object.values(c).every((v) => v === true);
    res[name] = pass ? { pass } : { pass, c, sample: { completed: a.world.research, modules: p.modules, legacy: p.legacy } };
  }
  // Real load path + export → import → export equality.
  const rt = {};
  for (const name of ["v1mid", "v2mid", "v2multi"]) {
    const id = await ctx.fixture(`m33-mig-${name}`, fx[name].raw);
    const j1 = await ev(`${G}.fixtures.export(${js(id)})`);
    const id2 = await ev(`${G}.fixtures.import(${js(j1)})`);
    ctx.created.push(id2);
    const j2 = await ev(`${G}.fixtures.export(${js(id2)})`);
    const x1 = JSON.parse(j1), x2 = JSON.parse(j2);
    const parsedDirect = await ev(`${G}.parse(${js(fx[name].raw)})`);
    rt[name] = { dataEqual: eq(x1.data, x2.data), matchesPureParse: eq(x1.data, parsedDirect), schema: x1.data.schemaVersion === 7 };
    rt[name].pass = rt[name].dataEqual && rt[name].matchesPureParse && rt[name].schema;
  }
  // Booting a migrated world: the mirrors and HUD config read the new catalogue.
  const bootId = await ctx.fixture("m33-mig-boot", fx.v2mid.raw);
  await ctx.boot(bootId);
  const m = await ev(`${G}.mirrors()`);
  rt.boot = { completed: m.completedNodes, equipped: m.modules.equippedModules, pass: eq(m.completedNodes, expectMid.completed) && eq(m.modules.equippedModules, expectMid.equipped) };
  // Invalid imports are refused.
  const bad = [
    "not json",
    js({ meta: { name: "x" }, data: { schemaVersion: 99, world: {}, players: {} } }),
    js({ meta: { name: "x" }, data: { schemaVersion: 3, world: 5, players: {} } }),
    js({ meta: { name: "x" }, data: "nope" }),
  ];
  const refused = [];
  for (const b of bad) refused.push(await ev(`${G}.fixtures.import(${js(b)}).then((id) => "imported:" + id, (e) => "refused")`));
  rt.invalid = { refused, pass: refused.every((x) => x === "refused") };
  return { fixtures: res, roundtrip: rt, pass: Object.values(res).every((r) => r.pass) && Object.values(rt).every((r) => r.pass) };
}

// ── (f) captures ───────────────────────────────────────────────────────────
export async function m33ShotGates(d, ctx, narrow) {
  const { ev } = ctx;
  await freshWorld(d, ctx, "m33-shots");
  const rocks = await loadedRocks(ctx);
  const shots = {};
  if (!narrow) {
    // A little progress: inspected rocks of each class, one mined, a bookmark.
    // WP1 thinned the starter neighbourhood: fall back to the nearest rock of the class.
    const near = [...rocks].sort((a, b) => a.distKm - b.distKm);
    const picks = ["s_type", "c_type", "x_type"].map((cls) => near.find((x) => x.classId === cls && x.radiusM > 20 && x.distKm < 15) ?? near.find((x) => x.classId === cls));
    if (picks.some((p) => !p)) return { pass: false, error: `no rock of class ${["s_type", "c_type", "x_type"][picks.indexOf(undefined)]} among ${rocks.length}` };
    for (const r of picks) await ev(`${G}.m33.inspect(${JSON.stringify(r)})`);
    await ev(`${G}.mine(${JSON.stringify(picks[0])})`);
    await ev(`${G}.m33.bookmark(${JSON.stringify(`${picks[1].fieldId}:${picks[1].chunkKey}:${picks[1].instanceId}`)}, "Hydrate rock")`);
    await ev(`__dev.grantCargo("silicates", 6)`);
    // Inspection result on a targeted rock.
    const t = picks[2];
    await ev(`${G}.m33.approach(${JSON.stringify(t)}, ${t.radiusM / 1000 + 0.4})`);
    await d.frames(10);
    await ev(`${G}.res.face(${JSON.stringify(t)})`);
    const focused = await waitFor(ctx, async () => (await ev(`${G}.res.mining()`)).focused, 8000);
    await d.frames(10);
    shots.inspection = await d.shot("m3-inspection");
    shots.focused = focused;
  }
  await d.press("r");
  await d.frames(10);
  if (narrow) {
    shots.panelNarrow = await d.shot("m3-research-panel-narrow");
    await d.press("Escape");
    return { shots, pass: true };
  }
  shots.panel = await d.shot("m3-research-panel");
  await ev(`document.querySelector('[data-node="pr1_transit_calibration"]')?.scrollIntoView({ block: "center" })`);
  await d.frames(5);
  shots.missing = await d.shot("m3-research-missing-evidence");
  await ev(`[...document.querySelectorAll(".rp-tabs__btn")].find((b) => b.textContent === "Discoveries")?.click()`);
  await d.frames(10);
  shots.discoveries = await d.shot("m3-discoveries-list");
  await d.press("Escape");
  await d.frames(5);
  await ev(`${G}.res.equip("module_beam_focuser_mk1", "mining")`);
  await ev(`${G}.res.equip("module_coolant_circulator_mk1", "cooling")`);
  await d.press("l");
  await d.frames(10);
  shots.loadout = await d.shot("m3-loadout-preview");
  await d.press("Escape");
  return { shots, pass: !!shots.focused };
}
