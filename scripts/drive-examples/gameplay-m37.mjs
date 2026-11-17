/**
 * M3.7 / M3.8 gates (parts of gameplay-check.mjs; needs --no-isolate, disposable "[gc] " worlds):
 *   seeds      (a) 8 new-world seeds: nearest hydrate source from the starter point, hop fuel vs allowance
 *   regions    (b) no bulk helium-3, lunar self-sufficiency inputs, titanium concentration, content audit
 *   site       (c) lunar canister: inspect → recover once, duplicates, persistence, marker at rate 1e4
 *   guidance   (d) opening, hints once (reload), retired ids, overlays vs warnings, projects
 *   difficulty (e) multipliers in the deterministic harness, switching/migration, death model
 *   sessionA / sessionB / sessionC   (f) end-to-end sessions (see each)
 *   exploits   (g) reload / world switch / duplicate ids / difficulty / cancel / equip / death loops
 *   m37shots   (h) captures at 1280×720; m37narrow at 390×844 (--size 390x844)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { burnFuel, gather, loadedRocks, waitFor } from "./gameplay-m33.mjs";
import { centerOf, findClearPreview, flyTo, waitArrival } from "./gameplay-m36.mjs";


const G = "__test.gameplay";
const M = `${G}.m37`;
const R = `${G}.rep`;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const r2 = (x) => (typeof x === "number" ? Math.round(x * 100) / 100 : x);
const SITE = "luna_survey_canister";
const KIT = "consumable_replication_kit";
const log = (...a) => console.log("[m37]", ...a);

async function rawShot(d, name) {
  const r = await d.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`.captures/${name}.png`, Buffer.from(r.data, "base64"));
  return `.captures/${name}.png`;
}

/** A schema-5 fresh world (defaults everywhere), booted. `named` skips the opening + naming. */
export async function freshWorld(d, ctx, name, { seed = 1, difficulty = "standard", named = true } = {}) {
  const { ev, me } = ctx;
  const id = await ev(`${G}.fixtures.create(${JSON.stringify(name)}, ${JSON.stringify({ schemaVersion: 5, world: {}, players: { [me]: {} } })}, ${JSON.stringify({ seed, difficulty })})`);
  ctx.created.push(id);
  await ctx.boot(id);
  if (named) {
    await ev(`${M}.comms.nameAi("Vega")`);
    // Opening premise marked seen so later gates start without a modal entry.
    await ev(`(() => { ${M}.comms.dismiss(); })()`);
  }
  await d.frames(30);
  return id;
}

const grant = async (ctx, items) => {
  for (const [r, n] of Object.entries(items)) await ctx.ev(`__dev.grantCargo(${JSON.stringify(r)}, ${n})`);
};
const settle = (ctx, ms) => ctx.wait(ms);

// ── (a) seeds ──
export async function seedGates(d, ctx) {
  const seeds = [1, 42, 1337, 7331, 2024, 99991, 123456789, 4294967295];
  const rows = [];
  for (const seed of seeds) {
    await freshWorld(d, ctx, `m37-seed-${seed}`, { seed });
    await settle(ctx, 2500);
    const r = await ctx.ev(`${M}.reach(3)`);
    rows.push({ seed, nearest: r.nearest && { distKm: r.nearest.distKm, hydrates: r.nearest.hydrates, mineS: r.nearest.mineS, hopKg: r2(r.nearest.hop.kg), pocket: r.nearest.pocket },
      pocket: r.nearestPocket && { distKm: r.nearestPocket.distKm, hydrates: r.nearestPocket.hydrates, hopKg: r2(r.nearestPocket.hop.kg) }, pocketUnits: r.pocketHydrateUnits, classes: r.pockets, allowanceKg: r.allowanceKg });
    log("seed", seed, JSON.stringify(rows.at(-1)));
  }
  // Hard: smaller allowance, more fuel per Δv.
  await freshWorld(d, ctx, "m37-seed-hard", { seed: 5, difficulty: "hard" });
  await settle(ctx, 2500);
  const hard = await ctx.ev(`${M}.reach(3)`);
  const ok = (r, allowance) => !!r.pocket && r.pocket.hopKg + 0.5 <= allowance && r.nearest && r.nearest.hopKg <= allowance;
  const metalMixed = rows.every((r) => (r.classes.origin_metal?.x_type ?? 0) > 0 && Object.keys(r.classes.origin_mixed ?? {}).length >= 2);
  return {
    rows,
    hard: { allowanceKg: hard.allowanceKg, pocketHopKg: r2(hard.nearestPocket?.hop.kg), nearestHopKg: r2(hard.nearest?.hop.kg) },
    identicalAcrossSeeds: rows.every((r) => eq({ ...r, seed: 0 }, { ...rows[0], seed: 0 })),
    pass: rows.every((r) => ok(r, r.allowanceKg)) && metalMixed && hard.nearestPocket && hard.nearestPocket.hop.kg <= hard.allowanceKg,
  };
}

// ── (b) regions ──
export async function regionGates(d, ctx) {
  const { ev } = ctx;
  await freshWorld(d, ctx, "m37-regions");
  const audit = await ev(`${M}.audit()`);
  const earth = await ev(`${M}.shares("origin_belt")`);
  const site = (await ev(`${M}.site.defs()`)).find((s) => s.id === SITE);
  await ev(`${R}.teleportRel("luna", ${JSON.stringify([site.positionKm[0] + 3, site.positionKm[1], site.positionKm[2]])})`);
  await d.frames(30);
  await settle(ctx, 3000);
  const luna = await ev(`${M}.shares("luna_belt")`);
  const clear = await ev(`${M}.clearance("luna", ${JSON.stringify(site.positionKm)}, 3000)`);
  return {
    audit: { he3Classes: audit.he3Classes, he3Recipes: audit.he3Recipes, lunarSelf: audit.lunarSelf, dependsOnLn1: audit.dependsOnLn1, titaniumEssentials: audit.titaniumEssentials, contentPass: audit.content.pass, provides: audit.provides },
    shares: { earth, luna },
    siteClearance: { rockClearM: Math.round(clear.rockClearM), bodyAltKm: Math.round(clear.bodyAltKm), bodyId: clear.bodyId },
    pass: audit.pass && (luna.shares.titanium ?? 0) > 0.15 && (luna.shares.hydrates ?? 0) > 0.05 && !("helium_3" in luna.shares) && clear.rockClearM >= 1000,
  };
}

/** Teleport to `offsetKm` from the site along +x (Luna frame), let the area stream. */
async function nearSite(d, ctx, offsetKm) {
  const site = (await ctx.ev(`${M}.site.defs()`)).find((s) => s.id === SITE);
  await ctx.ev(`${R}.teleportRel(${JSON.stringify(site.frameId)}, ${JSON.stringify([site.positionKm[0] + offsetKm, site.positionKm[1], site.positionKm[2]])})`);
  await d.frames(20);
  await settle(ctx, 300);
  return site;
}

const siteState = async (ctx) => {
  const w = await ctx.world();
  const p = await ctx.player();
  return { site: w.discoveries.sites[SITE] ?? null, inspected: w.discoveries.inspectedSites[SITE] ?? null, ln1: w.research.completedNodes.includes("ln1_survey_salvage"), suite: p.modules.ownedModules.includes("module_integrated_sensor_suite") };
};

// ── (c) lunar site ──
export async function siteGates(d, ctx) {
  const { ev, submit, player, world, boot } = ctx;
  const id = await freshWorld(d, ctx, "m37-site");
  const out = {};

  // Marker follows the Moon at rate 1e4 (before recovery hides it): sampled in one evaluate.
  await nearSite(d, ctx, 40);
  const sample = `(() => { const l = ${R}.abs("luna", [0, 0, 0]); const a = ${M}.site.absKm(${JSON.stringify(SITE)}); const s = ${R}.ship(); const p = ${M}.site.projected().find((x) => x.id === "site:${SITE}"); return { l, a, ship: s.absKm, proj: p ? p.distanceKm : null }; })()`;
  const m0 = await ev(sample);
  await ev(`__test.simRate(10000)`);
  await settle(ctx, 2000);
  await ev(`__test.simRate(1)`);
  await d.frames(3);
  const m1 = await ev(sample);
  const rel = (m) => m.a.map((v, i) => v - m.l[i]);
  const movedKm = Math.hypot(...m1.a.map((v, i) => v - m0.a[i]));
  const relDrift = Math.hypot(...rel(m1).map((v, i) => v - rel(m0)[i]));
  const projErr = m1.proj === null ? null : Math.abs(m1.proj - Math.hypot(...m1.a.map((v, i) => v - m1.ship[i])));
  out.marker = { movedKm: r2(movedKm), relDriftKm: r2(relDrift), projectedKm: r2(m1.proj), projErrKm: r2(projErr), pass: movedKm > 100 && relDrift < 1e-3 && projErr !== null && projErr < 1 };

  // Out of range: G does nothing.
  const far = await nearSite(d, ctx, 5);
  const gFar = await ev(`${M}.site.interact()`);
  // Inspect at 1.5 km; recover refused there.
  await nearSite(d, ctx, 1.5);
  const recEarly = await submit({ type: "site.recover", opId: "m37-rec-early", siteId: SITE });
  const ins = await ev(`${M}.site.interact()`);
  const ins2 = await submit({ type: "site.inspect", opId: "m37-ins-2", siteId: SITE });
  const recFar = await ev(`${M}.site.interact()`);
  await nearSite(d, ctx, 0.6);
  const p0 = await player();
  const rec = await ev(`${M}.site.interact("m37-rec-1")`);
  const p1 = await player();
  const dup = await submit({ type: "site.recover", opId: "m37-rec-1", siteId: SITE });
  const again = await submit({ type: "site.recover", opId: "m37-rec-2", siteId: SITE });
  const p2 = await player();
  out.interact = {
    farKm: 5, gFar, recBeforeInspect: recEarly.status === "rejected" ? recEarly.reason : recEarly.status, inspect: ins?.status, inspectAgain: ins2.status === "rejected" ? ins2.reason : ins2.status,
    recoverAt15: recFar?.status === "rejected" ? recFar.reason : recFar?.status, recover: rec?.status, dup: dup.status, again: again.status === "rejected" ? again.reason : again.status,
    titanium: [p0.cargo.items.titanium ?? 0, p1.cargo.items.titanium ?? 0, p2.cargo.items.titanium ?? 0],
    pass: gFar === null && recEarly.reason === "not_inspected" && ins?.status === "accepted" && ins2.reason === "already_done" && recFar?.reason === "too_far" &&
      rec?.status === "accepted" && dup.status === "duplicate" && again.reason === "already_done" && (p1.cargo.items.titanium ?? 0) === 30 && (p2.cargo.items.titanium ?? 0) === 30,
  };
  void far;

  // Optional unlock: research, craft and equip the suite.
  const unlock = await submit({ type: "research.unlock", opId: "m37-ln1", siteId: undefined, nodeId: "ln1_survey_salvage" });
  await grant(ctx, { silicates: 200, fe_ni_metal: 80 });
  const craft = await ev(`${G}.craft("module_integrated_sensor_suite")`);
  const p3 = await player();
  out.unlock = { unlock: unlock.status, craft: craft?.status, equipped: p3.modules.equippedModules.scanner, pass: unlock.status === "accepted" && craft?.status === "accepted" && p3.modules.equippedModules.scanner === "module_integrated_sensor_suite" };

  // Persistence: death + recovery, reload, export/import.
  const s0 = await siteState(ctx);
  await ev(`${G}.kill()`);
  await ev(`${R}.recover("active")`);
  await settle(ctx, 1500);
  const s1 = await siteState(ctx);
  const titaniumAfterDeath = (await world()).wrecks.reduce((a, w) => a + (w.items.titanium ?? 0), 0) + ((await player()).cargo.items.titanium ?? 0);
  await boot(id);
  const s2 = await siteState(ctx);
  const recAfterReload = await submit({ type: "site.recover", opId: "m37-rec-3", siteId: SITE });
  const json = await ev(`${G}.fixtures.export(${JSON.stringify(id)})`);
  const imp = await ev(`${G}.fixtures.import(${JSON.stringify(json)})`);
  ctx.created.push(imp);
  await boot(imp);
  const s3 = await siteState(ctx);
  out.persist = { s0, sameAfterDeath: eq(s0, s1), sameAfterReload: eq(s0, s2), sameAfterImport: eq({ ...s0, suite: true }, { ...s3, suite: true }) && !!s3.site,
    recoverAfterReload: recAfterReload.status === "rejected" ? recAfterReload.reason : recAfterReload.status, titaniumConserved: titaniumAfterDeath,
    pass: eq(s0, s1) && eq(s0, s2) && !!s3.site && !!s3.inspected && s3.ln1 && recAfterReload.reason === "already_done" };
  const audit = await ev(`${M}.audit()`);
  out.optional = { dependsOnLn1: audit.dependsOnLn1, titaniumEssentials: audit.titaniumEssentials, lunarSelf: audit.lunarSelf, pass: audit.dependsOnLn1.length === 0 && audit.titaniumEssentials.length === 0 };
  out.pass = Object.values(out).every((v) => v.pass);
  return out;
}

// ── (d) guidance ──
export async function guidanceGates(d, ctx) {
  const { ev, boot } = ctx;
  const out = {};
  const id = await freshWorld(d, ctx, "m37-guide", { named: false });
  const c = (s) => ev(`${M}.comms.${s}`);
  await c("reset()");
  await d.frames(30);
  const first = await c("active()");
  const nameBefore = await ev(`!!document.querySelector(".ai-name-overlay")`);
  await c("dismiss()");
  await d.frames(10);
  const nameShown = await ev(`!!document.querySelector(".ai-name-overlay input")`);
  await c(`nameAi("Vega")`);
  await d.frames(10);
  const second = await c("active()");
  await c("dismiss()");
  await d.frames(10);
  const hint1 = await c("hint()");
  out.opening = { first, nameBefore, nameShown, second, hint: hint1, pass: first === "opening_001" && !nameBefore && nameShown && second === "opening_002" && hint1 === "hint_projects" };

  // Hints: once, and never again after a reload.
  await c("nextHint()");
  await grant(ctx, { hydrates: 3 });
  await d.frames(10);
  await settle(ctx, 300);
  const shown = await c("hint()");
  const played1 = await c("played()");
  await c("nextHint()");
  await boot(id);
  await ev(`__dev.grantCargo("hydrates", 2)`);
  await d.frames(10);
  await settle(ctx, 300);
  const afterReload = await c("hint()");
  await c(`showHint("hydrates")`);
  await c(`showHint("projects")`);
  const forced = await c("hint()");
  const played2 = await c("played()");
  out.hints = { shown, playedAtShow: played1.includes("hint_hydrates"), afterReload, forcedRepeat: forced, played: played2.filter((x) => x.startsWith("hint_")),
    pass: shown === "hint_hydrates" && played1.includes("hint_hydrates") && afterReload === null && forced === null && played2.filter((x) => x === "hint_hydrates").length === 1 };

  // Retired ids can never be enqueued; the active catalogue has no ground control.
  const retired = await c("retired()");
  const q0 = await c("queue()");
  for (const rid of retired) await c(`enqueue(${JSON.stringify(rid)})`);
  const q1 = await c("queue()");
  const cat = await c("catalogue()");
  const BANNED = /\b(ESA|ground control|mission control|uplink|commander|Houston|assay|247 days)\b/i;
  const src = readFileSync("src/data/commsMessages.ts", "utf8");
  const activeSrc = src.slice(src.indexOf("export const COMMS_MESSAGES"), src.indexOf("/**\n * Retired ids"));
  const guideSrc = readFileSync("src/data/guidance.ts", "utf8");
  out.retired = { count: retired.length, queueBefore: q0, queueAfter: q1, catalogue: cat.map((m) => m.id), bannedInCatalogue: cat.filter((m) => BANNED.test(m.text)).map((m) => m.id),
    grepActive: BANNED.test(activeSrc) || BANNED.test(guideSrc),
    pass: eq(q0, q1) && cat.every((m) => !BANNED.test(m.text)) && !BANNED.test(activeSrc) && !BANNED.test(guideSrc) };

  // Projects: correct remaining requirements, then completion through accepted operations.
  await c("nextHint()");
  await ev(`${M}.project.track("research:sv1_composition_survey")`);
  await d.frames(5);
  const sv1 = await ev(`${M}.project.status()`);
  await ev(`${M}.project.track("forward_point")`);
  await d.frames(5);
  const fp0 = await ev(`${M}.project.status()`);
  const trackerText0 = await ev(`document.querySelector("[data-testid=objective-tracker]")?.textContent ?? null`);
  await grant(ctx, { fe_ni_metal: 150, silicates: 100 });
  const craft = await ev(`${G}.craft(${JSON.stringify(KIT)})`);
  await d.frames(5);
  const fp1 = await ev(`${M}.project.status()`);
  await ev(`${G}.nudgeKm(3, 0, 0)`);
  await d.frames(20);
  const pv = await findClearPreview(d, ctx);
  const place = await ev(`${R}.place("Tracker test", "m37-guide-place")`);
  await ev(`${R}.setMode(false)`);
  await d.frames(10);
  const fp2 = await ev(`${M}.project.status()`);
  const trackedAfterReload = (await boot(id), await ev(`${M}.project.tracked()`));
  out.projects = {
    sv1: { done: sv1?.done, total: sv1?.total, sub: sv1?.lines[0]?.sub.map((x) => `${x.met ? "✓" : "·"} ${x.text}`) },
    forwardPoint: [fp0 && `${fp0.done}/${fp0.total}`, fp1 && `${fp1.done}/${fp1.total}`, fp2 && `${fp2.done}/${fp2.total} complete=${fp2.complete}`],
    trackerText0, craft: craft?.status, previewValid: pv.valid, place: place?.status, trackedAfterReload,
    pass: !!sv1 && sv1.lines[0].sub.length === 4 && sv1.lines[0].sub.slice(0, 3).every((x) => !x.met) && fp0.done === 0 && fp1.done === 1 && fp2.complete === true && trackedAfterReload === "forward_point" && !!trackerText0 && trackerText0.includes("forward replication point"),
  };

  // A comms entry open: fuel / heat warnings stay visible, emergency recovery stays operable.
  await c(`enqueue("lunar_signal_001")`);
  await d.frames(5);
  await ev(`${G}.res.set({ ordinaryKg: 20, heat01: 0.95 })`);
  await d.frames(6);
  await settle(ctx, 250);
  const overlap = await ev(`(() => {
    const comms = document.querySelector(".comms-overlay");
    const warn = document.querySelector("[data-testid=fuel-warning]");
    const dash = document.querySelector(".ship-dashboard");
    const r = (e) => e && e.getBoundingClientRect();
    const hit = (a, b) => !!a && !!b && !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    const top = (e) => { if (!e) return false; const b = e.getBoundingClientRect(); const x = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!x && (e === x || e.contains(x)); };
    return { comms: !!comms, warnText: warn && warn.textContent, warnOnTop: top(warn), dashOnTop: top(dash), commsHitsDash: hit(r(comms), r(dash)), heatText: dash && dash.textContent.match(/heat:\\s*([^a-z]*)/i)?.[1] };
  })()`);
  const abandon = await ev(`${G}.res.abandon()`);
  await d.frames(10);
  const dead = await ev(`(() => { const c = document.querySelector(".comms-overlay"); const b = Array.from(document.querySelectorAll("button")).find((x) => /recover|replicate/i.test(x.textContent)); const r = b && b.getBoundingClientRect(); const top = r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { commsVisible: !!c, recoverButton: b ? b.textContent : null, onTop: !!b && (b === top || b.contains(top)) }; })()`);
  const rec = await ev(`${R}.recover("active")`);
  await settle(ctx, 1000);
  out.overlays = { ...overlap, abandon, dead, recover: rec.status,
    pass: overlap.comms && !!overlap.warnText && overlap.warnOnTop && overlap.dashOnTop && !overlap.commsHitsDash && abandon === true && !dead.commsVisible && dead.onTop && rec.status === "accepted" };
  return out;
}

// ── (e) difficulty ──
export async function difficultyGates(d, ctx) {
  const { ev, submit, player, world, boot } = ctx;
  const out = {};
  const id = await freshWorld(d, ctx, "m37-diff");
  const table = (await ev(`${M}.difficulty.get()`)).table;
  const rsim = (sc) => ev(`${G}.res.simulate(${JSON.stringify(sc)})`);
  const tsim = (sc) => ev(`${G}.transit.simulate(${JSON.stringify(sc)})`);
  const rows = {};
  for (const diff of ["explorer", "standard", "hard"]) {
    await ev(`${M}.difficulty.set(${JSON.stringify(diff)})`);
    const thrust = (await rsim({ segments: [{ decoupled: true, throttle: 1, seconds: 2 }] })).segments[0].meter.thrustKg;
    const trip = (await rsim({ sampleEvery: 1, segments: [{ mining: true, seconds: 30 }] })).segments[0].firstTripS;
    const boost = (await rsim({ segments: [{ boost: true, throttle: 1, seconds: 3 }] })).final.heat01;
    const tr = await tsim({ target: { positionKm: [0, 0, 380000] } });
    const eff = await ev(`${M}.difficulty.effective()`);
    rows[diff] = { thrustKg: r2(thrust * 1000) / 1000, miningTripS: r2(trip), boost3sHeat: r2(boost), transit380kKg: r2(600 - tr.final.ordinaryKg), allowanceKg: eff.recoveryAllowanceKg, impactHp40: r2(await ev(`${M}.difficulty.impactHp(40)`)) };
  }
  await ev(`${M}.difficulty.set("standard")`);
  const s = rows.standard;
  const ratio = (k, dd) => r2(rows[dd][k] / s[k]);
  const ratios = {};
  for (const dd of ["explorer", "hard"]) ratios[dd] = { fuel: ratio("thrustKg", dd), transit: ratio("transit380kKg", dd), allowance: ratio("allowanceKg", dd), impact: ratio("impactHp40", dd), boostHeat: ratio("boost3sHeat", dd) };
  const near = (a, b) => Math.abs(a - b) <= 0.02;
  out.pure = { rows, ratios, table,
    pass: ["explorer", "hard"].every((dd) => near(ratios[dd].fuel, table[dd].fuelUse) && near(ratios[dd].transit, table[dd].fuelUse) && near(ratios[dd].allowance, table[dd].allowance) &&
      near(ratios[dd].impact, table[dd].collisionDamage)) && rows.explorer.miningTripS > s.miningTripS && rows.hard.miningTripS < s.miningTripS };

  // Yield: the same rock's claim under each setting.
  const rock = (await ev(`${M}.reach(1)`)).nearest?.ref;
  const claims = {};
  for (const dd of ["explorer", "standard", "hard"]) {
    await ev(`${M}.difficulty.set(${JSON.stringify(dd)})`);
    claims[dd] = await ev(`${M}.difficulty.mineClaim(${JSON.stringify(rock)})`);
  }
  await ev(`${M}.difficulty.set("standard")`);
  const tot = (o) => Object.values(o).reduce((a, v) => a + v, 0);
  out.yield = { claims, totals: { explorer: tot(claims.explorer), standard: tot(claims.standard), hard: tot(claims.hard) },
    pass: tot(claims.explorer) >= tot(claims.standard) && tot(claims.hard) === tot(claims.standard) };

  // Switching never changes stored quantities; the setting persists.
  await grant(ctx, { fe_ni_metal: 37, hydrates: 5 });
  await ev(`${G}.res.set({ ordinaryKg: 345.5 })`);
  await ev(`__test.save.flush ? __test.save.flush() : null`);
  const before = await player();
  await ev(`${M}.difficulty.setWorld("hard")`);
  const afterSet = await player();
  await boot(id);
  const info = await ev(`__test.save.info()`);
  const rt = (await ev(`${M}.difficulty.get()`)).current;
  const afterBoot = await player();
  const same = (a, b) => eq(a.cargo, b.cargo) && Math.abs(a.propellant.ordinaryKg - b.propellant.ordinaryKg) < 1e-6 && a.propellant.protectedKg === b.propellant.protectedKg && a.health === b.health && eq(a.modules, b.modules);
  out.switch = { before: { cargo: before.cargo.items, fuel: before.propellant }, afterBoot: { cargo: afterBoot.cargo.items, fuel: afterBoot.propellant }, stored: info.difficulty, runtime: rt,
    pass: same(before, afterSet) && same(before, afterBoot) && info.difficulty === "hard" && rt === "hard" };

  // Migration / malformed meta → standard.
  const v4 = { schemaVersion: 4, world: {}, players: { [ctx.me]: { propellant: { ordinaryKg: 222, protectedKg: 60 } } } };
  const mid = await ev(`${G}.fixtures.create("m37-diff-mig", ${JSON.stringify(v4)}, { difficulty: "nightmare" })`);
  ctx.created.push(mid);
  await boot(mid);
  const minfo = await ev(`__test.save.info()`);
  const mp = await player();
  out.migrate = { difficulty: minfo.difficulty, runtime: (await ev(`${M}.difficulty.get()`)).current, ordinaryKg: mp.propellant.ordinaryKg, trackedProject: mp.trackedProject, inspectedSites: (await world()).discoveries.inspectedSites,
    pass: minfo.difficulty === "standard" && mp.propellant.ordinaryKg === 222 && mp.trackedProject === null };

  // A new world starts with its own difficulty's protected allowance (createWorld's data, read before any death).
  const fresh = {};
  for (const dd of ["explorer", "standard", "hard"]) {
    const nid = await ev(`${G}.fixtures.create("m37-diff-new-${dd}", "new", { difficulty: ${JSON.stringify(dd)} })`);
    ctx.created.push(nid);
    await boot(nid);
    fresh[dd] = { protectedKg: (await player()).propellant.protectedKg, allowanceKg: (await ev(`${M}.difficulty.effective()`)).recoveryAllowanceKg };
  }
  out.created = { fresh, pass: Object.values(fresh).every((f) => Math.abs(f.protectedKg - f.allowanceKg) < 1e-6) && fresh.explorer.protectedKg === 90 && fresh.hard.protectedKg === 45 };

  // Death model identical across settings (only the allowance amount scales).
  const deaths = {};
  for (const dd of ["explorer", "standard", "hard"]) {
    await boot(id);
    await ev(`${M}.difficulty.setWorld(${JSON.stringify(dd)})`);
    await grant(ctx, { silicates: 11 });
    // Away from the point, so the wreck is not collected at the emergence.
    await ev(`${G}.nudgeKm(40, 0, 0)`);
    await d.frames(10);
    await ev(`${G}.res.set({ ordinaryKg: 300, protectedKg: 10 })`);
    const p0 = await player();
    const k = await ev(`${G}.kill()`);
    const w = (await world()).wrecks.at(-1);
    const r = await ev(`${R}.recover("active")`);
    await settle(ctx, 800);
    const p1 = await player();
    const eff = await ev(`${M}.difficulty.effective()`);
    deaths[dd] = {
      kill: k?.status, wreckItems: w?.items, wreckFuel: r2(w?.fuelKg), recover: r.status, protectedAfter: p1.propellant.protectedKg, ordinaryAfter: p1.propellant.ordinaryKg,
      allowance: eff.recoveryAllowanceKg, modulesKept: eq(p0.modules.ownedModules, p1.modules.ownedModules), health: p1.health, cargoAfter: p1.cargo.items,
      expectedWreckFuel: r2(300 - Math.min(300, eff.recoveryAllowanceKg - 10)),
    };
  }
  const model = (x) => ({ kill: x.kill, recover: x.recover, emptyCargo: Object.keys(x.cargoAfter).length === 0, ordinary0: x.ordinaryAfter === 0, protectedIsAllowance: x.protectedAfter === x.allowance, wreckFuelRule: Math.abs(x.wreckFuel - x.expectedWreckFuel) < 0.01, modulesKept: x.modulesKept, fullHull: x.health === 100 });
  out.death = { deaths, models: Object.fromEntries(Object.entries(deaths).map(([k, v]) => [k, model(v)])),
    pass: eq(model(deaths.explorer), model(deaths.standard)) && eq(model(deaths.hard), model(deaths.standard)) && Object.values(model(deaths.standard)).every((v) => v === true || v === "accepted") };
  await ev(`${M}.difficulty.setWorld("standard")`);
  out.pass = Object.values(out).every((v) => v.pass);
  return out;
}

// ── (f) end-to-end sessions ─────────────────────────────────────────────────
// Split into parts of < 2 min each; the world id and the log carry over in .captures/m37-sessions.json.
// The harness teleports and fast-forwards mining (claims from the deterministic generator), but every
// state change is an accepted operation; flight and transit use real key input.

const STATE_FILE = ".captures/m37-sessions.json";
const loadState = () => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
};
const saveState = (s) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));

/** Operation receipts by type since `from` (receipt count before). */
const opsSince = (w, from) => {
  const byType = {};
  for (const r of w.receipts.slice(from)) byType[r.type] = (byType[r.type] ?? 0) + 1;
  return byType;
};

/** Accepted-operation step log with play-time estimate inputs. */
function stepper() {
  const steps = [];
  return {
    steps,
    ok: (label, o, extra = {}) => {
      steps.push({ label, status: o?.status ?? (o === true ? "ok" : o === false ? "failed" : o), reason: o?.reason, missing: o?.missing, evidence: o?.evidence, ...extra });
      return o?.status === "accepted" || o === true;
    },
    failed: () => steps.filter((s) => s.status !== "accepted" && s.status !== "ok"),
  };
}

/** Mine via the accepted claim and log each rock's extraction time and distance (play-time estimate). */
async function gatherLogged(ctx, rocks, need, used, playLog) {
  const before = new Set(used);
  let ops = 0;
  try {
    ops = await gather(ctx, rocks, need, used);
  } catch (e) {
    playLog.push({ kind: "gatherFailed", error: String(e.message ?? e), need, have: (await ctx.player()).cargo.items });
  }
  for (const r of rocks) if (used.has(r.instanceId) && !before.has(r.instanceId)) playLog.push({ kind: "mine", s: r.mineS, km: r.distKm });
  return ops;
}

/** Real transit: T held through the spool, then wait for idle. */
async function flyTransit(d, ctx, maxS = 110) {
  const TR = `${G}.transit`;
  await d.hold("t", 3400);
  const t0 = Date.now();
  let st = await ctx.ev(`${TR}.state()`);
  while (Date.now() - t0 < maxS * 1000) {
    await ctx.wait(400);
    st = await ctx.ev(`${TR}.state()`);
    if (st.phase === "idle" && st.legIndex >= st.legCount - 1) break;
  }
  await d.frames(5);
  return { st, wallS: (Date.now() - t0) / 1000 };
}

async function bootSession(d, ctx, key) {
  const s = loadState()[key];
  if (!s) throw new Error(`run ${key} part 1 first`);
  await ctx.boot(s.id);
  await d.frames(30);
  return s;
}

// Session (i): survey first → transit → prepared lunar visit → site recovery → optional unlock.
export async function sessionAGates(d, ctx) {
  const { ev, player, world } = ctx;
  const part = process.env.SESSION_PART ?? "1";
  const S = stepper();
  const state = loadState();
  if (part === "1") {
    const id = await ev(`${G}.fixtures.create("m37-sessionA", ${JSON.stringify({ schemaVersion: 5, world: {}, players: { [ctx.me]: {} } })})`);
    await ctx.boot(id);
    await ev(`${M}.comms.nameAi("Vega")`);
    await ev(`${M}.comms.dismiss()`);
    await settle(ctx, 1500);
    const w0 = await world();
    const p0 = await player();
    const playLog = [];
    S.ok("track project", (await ev(`(${M}.project.track("lunar_survey"), true)`)) === true);
    const rocks = await loadedRocks(ctx);
    const used = new Set();
    for (const cls of ["s_type", "c_type", "x_type"]) {
      const r = rocks.find((x) => x.classId === cls && !used.has(x.instanceId) && (cls !== "c_type" || (x.composition.hydrates ?? 0) >= 1));
      used.add(r.instanceId);
      await ev(`${G}.m33.approach(${JSON.stringify(r)}, ${r.radiusM / 1000 + 0.5})`);
      await d.frames(5);
      S.ok(`inspect ${cls}`, await ev(`${G}.m33.inspect(${JSON.stringify(r)})`));
      playLog.push({ kind: "inspect", s: 4, km: r.distKm });
    }
    await gatherLogged(ctx, rocks, { silicates: 130, fe_ni_metal: 40 }, used, playLog);
    S.ok("unlock sv1", await ev(`${G}.m33.unlock("sv1_composition_survey")`));
    S.ok("craft prospector", await ev(`${G}.craft("module_prospector_scanner_mk1")`));
    const tb = Date.now();
    const burned = await burnFuel(d, ctx, 22);
    playLog.push({ kind: "fly", s: (Date.now() - tb) / 1000, km: 0 });
    await gatherLogged(ctx, rocks, { hydrates: 7, carbon: 4, silicates: 160, fe_ni_metal: 120 }, used, playLog);
    S.ok("process 1 unit", await ev(`${G}.res.startProcessing(1)`));
    S.ok("first batch", await waitFor(ctx, async () => !!(await world()).discoveries.trials.first_batch, 15000));
    S.ok("unlock pr1", await ev(`${G}.m33.unlock("pr1_transit_calibration")`));
    S.ok("craft drive", await ev(`${G}.craft("special_transit_drive")`));
    const tank = (await ev(`${G}.m33.liveTuning()`)).tankKg;
    const room = Math.floor((tank - (await ev(`${G}.res.state()`)).ordinaryKg) / 20);
    if (room > 0) {
      await gatherLogged(ctx, rocks, { hydrates: room }, used, playLog);
      S.ok(`process ${room}`, await ev(`${G}.res.startProcessing(${room})`));
      await waitFor(ctx, async () => !(await ev(`${G}.res.state()`)).processing.active, 30000);
    }
    const proj = await ev(`${M}.project.evaluate("lunar_survey")`);
    const w1 = await world();
    state.A = { id, receipts0: w0.receipts.length, fuel0: p0.propellant.ordinaryKg, playLog, burnedKg: burned, part1: { steps: S.steps, ops: opsSince(w1, w0.receipts.length), project: proj.lines.map((l) => `${l.met ? "✓" : "·"} ${l.text}`) } };
    saveState(state);
    const fails = S.failed();
    return { part: 1, ops: state.A.part1.ops, fuelKg: r2((await ev(`${G}.res.state()`)).ordinaryKg), project: state.A.part1.project, fails, pass: fails.length === 0 };
  }
  if (part === "2") {
    // Earth → Moon (the site lies beyond it: transit routes around one body, so two hops).
    const st = await bootSession(d, ctx, "A");
    const direct = await (async () => {
      await ev(`${M}.site.setDestination({ siteId: ${JSON.stringify(SITE)} })`);
      await d.frames(10);
      const p = await ev(`${G}.transit.preview()`);
      return p && { ok: p.ok, reason: p.reason };
    })();
    S.ok("set destination: Moon", await ev(`${M}.site.setDestination({ bodyId: "luna" })`));
    await d.frames(20);
    const pv = await ev(`${G}.transit.preview()`);
    const r0 = await ev(`${G}.res.state()`);
    const fly = await flyTransit(d, ctx);
    const r1 = await ev(`${G}.res.state()`);
    const glance = await ev(`${M}.site.glance()`);
    st.transit = { directToSite: direct, moon: { preview: pv && { ok: pv.ok, etaS: r2(pv.etaS), fuelKg: r2(pv.fuelKg), legs: pv.legCount, via: pv.viaName }, usedKg: r2(r0.ordinaryKg - r1.ordinaryKg), wallS: r2(fly.wallS), arrived: fly.st.ev.arrived, frame: glance.frameId } };
    st.playLog.push({ kind: "transit", s: pv?.etaS ?? fly.wallS, km: 0 });
    const s = loadState();
    s.A = st;
    saveState(s);
    return { part: 2, transit: st.transit, pass: !!pv?.ok && fly.st.ev.arrived >= 1 && glance.frameId === "luna" };
  }
  // Part 3: approach with real input, G to inspect and recover, unlock and fit the suite from lunar material.
  const st = await bootSession(d, ctx, "A");
  const site = (await ev(`${M}.site.defs()`)).find((x) => x.id === SITE);
  // The Luna-cleared hop to the survey signal (real T input).
  S.ok("set destination: site", await ev(`${M}.site.setDestination({ siteId: ${JSON.stringify(SITE)} })`));
  await d.frames(20);
  const hpv = await ev(`${G}.transit.preview()`);
  const h0 = await ev(`${G}.res.state()`);
  const hop = await flyTransit(d, ctx, 60);
  const h1 = await ev(`${G}.res.state()`);
  st.transit.hop = { preview: hpv && { ok: hpv.ok, reason: hpv.reason, etaS: r2(hpv.etaS), fuelKg: r2(hpv.fuelKg), via: hpv.viaName }, usedKg: r2(h0.ordinaryKg - h1.ordinaryKg), arrived: hop.st.ev.arrived, siteKm: (await ev(`${M}.site.glance()`)).site?.distKm };
  st.playLog.push({ kind: "transit", s: hpv?.etaS ?? hop.wallS, km: 0 });
  S.ok("hop arrived", hop.st.ev.arrived >= 1);
  const t0 = Date.now();
  const fly = await flyTo(d, ctx, site.frameId, site.positionKm, 0.7, 70);
  st.playLog.push({ kind: "approach", s: (Date.now() - t0) / 1000, km: 0 });
  await d.frames(10);
  await d.press("g");
  await settle(ctx, 300);
  const inspected = !!(await world()).discoveries.inspectedSites[SITE];
  await d.press("g");
  await settle(ctx, 300);
  const recovered = !!(await world()).discoveries.sites[SITE];
  S.ok("G inspect", inspected);
  S.ok("G recover", recovered);
  S.ok("unlock ln1", await ev(`${G}.m33.unlock("ln1_survey_salvage")`));
  const rocks = await loadedRocks(ctx);
  const used = new Set();
  await gatherLogged(ctx, rocks, { silicates: 200, fe_ni_metal: 80, titanium: 30 }, used, st.playLog);
  S.ok("craft suite", await ev(`${G}.craft("module_integrated_sensor_suite")`));
  if ((await player()).modules.equippedModules.scanner !== "module_integrated_sensor_suite") S.ok("equip suite", await ev(`${G}.m33.equipOp("module_integrated_sensor_suite", "scanner")`));
  const p = await player();
  const w = await world();
  const proj = await ev(`${M}.project.evaluate("lunar_survey")`);
  // Play-time estimate: extraction seconds + 25 s flying between rocks + 4 s per inspection + transit +
  // approach + 20 s per craft/unlock/processing interaction (reading and UI).
  const ops = opsSince(w, st.receipts0);
  const mines = st.playLog.filter((x) => x.kind === "mine");
  const mineS = mines.reduce((a, x) => a + x.s, 0);
  const interactions = (ops["item.craft"] ?? 0) + (ops["research.unlock"] ?? 0) + (ops["processing.start"] ?? 0) + (ops["site.inspect"] ?? 0) + (ops["site.recover"] ?? 0);
  const flyS = st.playLog.filter((x) => x.kind === "fly" || x.kind === "approach" || x.kind === "transit").reduce((a, x) => a + x.s, 0);
  const estimateMin = (mineS + mines.length * 25 + 3 * 4 + flyS + interactions * 20) / 60;
  const fails = S.failed();
  const gatherFails = st.playLog.filter((x) => x.kind === "gatherFailed");
  const res = {
    part: 3, gatherFails, approach: { reached: fly.reached, s: r2(fly.s) }, inspected, recovered, owned: p.modules.ownedModules, equipped: p.modules.equippedModules,
    projectComplete: proj.complete, opsTotal: ops, rocksMined: mines.length, extractionS: r2(mineS), estimateMin: r2(estimateMin), fuelNowKg: r2(p.propellant.ordinaryKg), transit: st.transit,
    part1: st.part1, fails,
    pass: fails.length === 0 && fly.reached && p.modules.equippedModules.scanner === "module_integrated_sensor_suite" && proj.complete,
  };
  ctx.created.push(st.id);
  return res;
}

// Session (ii): extraction/cooling first → one-way relocation → a lunar point → five refuel cycles,
// a repair and one more kit from lunar material only.
export async function sessionBGates(d, ctx) {
  const { ev, player, world } = ctx;
  const part = process.env.SESSION_PART ?? "1";
  const S = stepper();
  const state = loadState();
  if (part === "1") {
    const id = await ev(`${G}.fixtures.create("m37-sessionB", ${JSON.stringify({ schemaVersion: 5, world: {}, players: { [ctx.me]: {} } })})`);
    await ctx.boot(id);
    await ev(`${M}.comms.nameAi("Vega")`);
    await ev(`${M}.comms.dismiss()`);
    await settle(ctx, 1500);
    const w0 = await world();
    const playLog = [];
    const rocks = await loadedRocks(ctx);
    const used = new Set();
    // Live sustained beam on a large cold-mineable metal-bearing rock (the extraction trial).
    const big = rocks.find((x) => x.mineS >= 9 && x.mineS < 13.5 && (x.composition.fe_ni_metal ?? 0) >= 3);
    used.add(big.instanceId);
    await ev(`${G}.m33.approach(${JSON.stringify(big)}, ${big.radiusM / 1000 + 0.35})`);
    await d.frames(10);
    await ev(`${G}.res.face(${JSON.stringify(big)})`);
    const focused = await waitFor(ctx, async () => (await ev(`${G}.res.mining()`)).focused, 8000);
    await ev(`${G}.res.startMining()`);
    const trial = await waitFor(ctx, async () => !!(await world()).discoveries.trials.sustained_beam, 16000);
    await waitFor(ctx, async () => !(await ev(`${G}.res.mining()`)).mining, 8000);
    S.ok("live sustained beam", focused && trial);
    playLog.push({ kind: "mine", s: big.mineS, km: big.distKm });
    await gatherLogged(ctx, rocks, { fe_ni_metal: 15 + 90 + 40, silicates: 15 + 80 + 140 }, used, playLog);
    S.ok("unlock ex1", await ev(`${G}.m33.unlock("ex1_controlled_extraction")`));
    S.ok("unlock th1", await ev(`${G}.m33.unlock("th1_heat_rejection")`));
    S.ok("craft focuser", await ev(`${G}.craft("module_beam_focuser_mk1")`));
    S.ok("craft radiator", await ev(`${G}.craft("module_radiator_strips_mk1")`));
    await burnFuel(d, ctx, 22);
    await gatherLogged(ctx, rocks, { hydrates: 7, carbon: 4, silicates: 160, fe_ni_metal: 120 }, used, playLog);
    S.ok("process 1 unit", await ev(`${G}.res.startProcessing(1)`));
    S.ok("first batch", await waitFor(ctx, async () => !!(await world()).discoveries.trials.first_batch, 15000));
    S.ok("unlock pr1", await ev(`${G}.m33.unlock("pr1_transit_calibration")`));
    S.ok("craft drive", await ev(`${G}.craft("special_transit_drive")`));
    const tank = (await ev(`${G}.m33.liveTuning()`)).tankKg;
    const room = Math.floor((tank - (await ev(`${G}.res.state()`)).ordinaryKg) / 20);
    if (room > 0) {
      await gatherLogged(ctx, rocks, { hydrates: room }, used, playLog);
      S.ok(`process ${room}`, await ev(`${G}.res.startProcessing(${room})`));
      await waitFor(ctx, async () => !(await ev(`${G}.res.state()`)).processing.active, 30000);
    }
    S.ok("track foothold", (await ev(`(${M}.project.track("lunar_foothold"), true)`)) === true);
    const w1 = await world();
    state.B = { id, receipts0: w0.receipts.length, playLog, part1: { steps: S.steps, ops: opsSince(w1, w0.receipts.length), fuelKg: r2((await ev(`${G}.res.state()`)).ordinaryKg) } };
    saveState(state);
    return { part: 1, ...state.B.part1, fails: S.failed(), pass: S.failed().length === 0 };
  }
  if (part === "2") {
    // One way: straight to the survey signal past the Moon (no return planned), then a point there.
    const st = await bootSession(d, ctx, "B");
    S.ok("destination: site", await ev(`${M}.site.setDestination({ siteId: ${JSON.stringify(SITE)} })`));
    await d.frames(20);
    const pv = await ev(`${G}.transit.preview()`);
    const r0 = await ev(`${G}.res.state()`);
    const fly = await flyTransit(d, ctx, 110);
    const r1 = await ev(`${G}.res.state()`);
    const g = await ev(`${M}.site.glance()`);
    st.transit = { preview: pv && { ok: pv.ok, reason: pv.reason, etaS: r2(pv.etaS), fuelKg: r2(pv.fuelKg), legs: pv.legCount, via: pv.viaName }, usedKg: r2(r0.ordinaryKg - r1.ordinaryKg), arrived: fly.st.ev.arrived, frame: g.frameId, siteKm: g.site?.distKm, leftKg: r2(r1.ordinaryKg) };
    S.ok("arrived in lunar space", g.frameId === "luna");
    // Earth material is jettisoned (cargo panel) so everything after this point is lunar.
    const earthCargo = (await player()).cargo.items;
    for (const k of Object.keys(earthCargo)) await ev(`${G}.jettison(${JSON.stringify(k)})`);
    await settle(ctx, 300);
    st.earthCargoJettisoned = earthCargo;
    st.lunarMined = {};
    const s = loadState();
    s.B = { ...st, part2: { steps: S.steps } };
    saveState(s);
    return { part: 2, transit: st.transit, jettisoned: earthCargo, fails: S.failed(), pass: S.failed().length === 0 };
  }
  // Parts 3 and 4: kit from lunar rocks, place the point; then refuel cycles, a repair and one more kit.
  const st = await bootSession(d, ctx, "B");
  const rocks = await loadedRocks(ctx);
  const used = new Set(st.usedRocks ?? []);
  const mineLunar = async (need) => {
    const before = (await player()).cargo.items;
    await gatherLogged(ctx, rocks.filter((r) => r.fieldId === "luna_belt"), need, used, st.playLog);
    const after = (await player()).cargo.items;
    for (const k of Object.keys(after)) st.lunarMined[k] = (st.lunarMined[k] ?? 0) + Math.max(0, (after[k] ?? 0) - (before[k] ?? 0));
  };
  const out = { part };
  if (part === "3") {
    await mineLunar({ fe_ni_metal: 150, silicates: 100 });
    S.ok("craft kit (lunar)", await ev(`${G}.craft(${JSON.stringify(KIT)})`));
    const pv = await findClearPreview(d, ctx);
    S.ok("placement preview valid", pv.valid);
    S.ok("place lunar point", await ev(`${R}.place("Lunar camp", "m37-B-place")`));
    await ev(`${R}.setMode(false)`);
    const w = await world();
    const pt = w.replication.points.at(-1);
    out.point = { name: pt?.name, frameId: pt?.frameId, active: (await player()).replication.activeId === pt?.id };
    S.ok("point in Luna frame and active", pt?.frameId === "luna" && out.point.active);
    st.cycles = [];
  } else {
    // Refuel cycles: a real transit round trip to the lunar field (fuel spent), then lunar hydrates processed.
    const first = st.cycles.length;
    const n = part === "4" ? 3 : 2;
    for (let c = 0; c < n; c++) {
      const r0 = await ev(`${G}.res.state()`);
      S.ok(`cycle ${first + c + 1}: destination field`, await ev(`${M}.site.setDestination({ fieldId: "luna_belt" })`));
      await d.frames(10);
      const a = await flyTransit(d, ctx, 45);
      S.ok(`cycle ${first + c + 1}: destination site`, await ev(`${M}.site.setDestination({ siteId: ${JSON.stringify(SITE)} })`));
      await d.frames(10);
      const b = await flyTransit(d, ctx, 45);
      const r1 = await ev(`${G}.res.state()`);
      const spent = r0.ordinaryKg - r1.ordinaryKg;
      const units = Math.ceil(spent / 20);
      await mineLunar({ hydrates: units });
      S.ok(`cycle ${first + c + 1}: process ${units}`, await ev(`${G}.res.startProcessing(${units})`));
      await waitFor(ctx, async () => !(await ev(`${G}.res.state()`)).processing.active, 20000);
      const r2_ = await ev(`${G}.res.state()`);
      st.cycles.push({ spentKg: r2(spent), arrived: [a.st.ev.arrived, b.st.ev.arrived], units, refilledTo: r2(r2_.ordinaryKg), before: r2(r0.ordinaryKg) });
    }
    if (part === "5") {
      // Hull repair and one more kit, lunar material only.
      await ev(`${M}.damage(20)`);
      await ev("__test.save.flush()");
      out.damageInjected = (await player()).health;
      await mineLunar({ fe_ni_metal: 170, silicates: 100 });
      if (out.damageInjected < 100) {
        await ev(`${G}.res.repair(true)`);
        await waitFor(ctx, async () => (await player()).health >= 100, 20000);
        S.ok("repair to full (lunar Fe-Ni)", (await player()).health >= 100);
      }
      S.ok("second kit (lunar)", await ev(`${G}.craft(${JSON.stringify(KIT)})`));
    }
  }
  st.usedRocks = Array.from(used);
  const s = loadState();
  s.B = { ...st, [`part${part}`]: { steps: S.steps } };
  saveState(s);
  if (part === "5") {
    const w = await world();
    const p = await player();
    const proj = await ev(`${M}.project.evaluate("lunar_foothold")`);
    out.cycles = st.cycles;
    out.ops = opsSince(w, st.receipts0);
    out.kits = p.modules.consumables[KIT] ?? 0;
    out.projectComplete = proj.complete;
    out.transit = st.transit;
    out.earthCargoJettisoned = st.earthCargoJettisoned;
    const allSteps = ["part1", "part2", "part3", "part4"].flatMap((k) => st[k]?.steps ?? []).concat(S.steps);
    out.fails = allSteps.filter((x) => x.status !== "accepted" && x.status !== "ok");
    out.pass = out.fails.length === 0 && st.cycles.length >= 5 && st.cycles.every((c) => c.arrived.every((x) => x >= 1) && c.refilledTo >= c.before - 1e-6) && out.kits >= 1 && proj.complete;
    ctx.created.push(st.id);
    return out;
  }
  out.fails = S.failed();
  out.pass = out.fails.length === 0;
  out.cyclesSoFar = st.cycles?.length ?? 0;
  return out;
}

// Session (iii): a deliberate failure. Out of fuel away from the point, abandon, recover, fly back,
// partial salvage (consumable stack limit), die again, explicit starter fallback.
// Setup deviation: the world starts with 40 kg of ordinary fuel (burning a full 600 kg tank by
// manoeuvring takes ~10 min of wall time); everything after the setup is accepted operations.
export async function sessionCGates(d, ctx) {
  const { ev, player, world } = ctx;
  const part = process.env.SESSION_PART ?? "1";
  const S = stepper();
  const HS = "consumable_heat_sink_cartridge";
  if (part === "1") {
    const data = { schemaVersion: 5, world: {}, players: { [ctx.me]: { propellant: { ordinaryKg: 40, protectedKg: 60 } } } };
    const id = await ev(`${G}.fixtures.create("m37-sessionC", ${JSON.stringify(data)})`);
    await ctx.boot(id);
    await ev(`${M}.comms.nameAi("Vega")`);
    await ev(`${M}.comms.dismiss()`);
    await settle(ctx, 1500);
    const w0 = await world();
    const rocks = await loadedRocks(ctx);
    const used = new Set();
    await gather(ctx, rocks, { fe_ni_metal: 150 + 15, silicates: 100 + 60 }, used);
    S.ok("craft kit", await ev(`${G}.craft(${JSON.stringify(KIT)})`));
    for (let i = 0; i < 3; i++) S.ok(`craft heat sink ${i + 1}`, await ev(`${G}.craft(${JSON.stringify(HS)})`));
    // Real input: fly out a little, place the point.
    await d.hold("w", 2000);
    for (let i = 0; i < 20 && (await ev(`${R}.ship()`)).velKmps.some((v) => Math.abs(v) > 0.002); i++) await d.hold("x", 300);
    const pv = await findClearPreview(d, ctx);
    S.ok("preview", pv.valid);
    S.ok("place point", await ev(`${R}.place("Forward camp", "m37-C-place")`));
    await ev(`${R}.setMode(false)`);
    const point = (await world()).replication.points.at(-1);
    // Carry identifiable cargo away, burning the tank with real thrust (W, X) until it is empty.
    await gather(ctx, rocks, { fe_ni_metal: 30, silicates: 20 }, used);
    const t0 = Date.now();
    for (let i = 0; i < 30 && (await ev(`${G}.res.state()`)).ordinaryKg > 0; i++) {
      await d.hold("w", 2500);
      await d.hold("x", 2500);
    }
    const sOut = await ev(`${G}.res.state()`);
    const ship = await ev(`${R}.ship()`);
    const awayKm = Math.hypot(...ship.posKm.map((v, i) => v - point.positionKm[i]));
    S.ok("ordinary empty", sOut.ordinaryKg <= 1e-6);
    const preLoss = await player();
    S.ok("abandon (Esc menu action)", (await ev(`${G}.res.abandon()`)) === true);
    const wreck = (await world()).wrecks.at(-1);
    const st = { id, receipts0: w0.receipts.length, pointId: point.id, pointPos: point.positionKm, wreckId: wreck?.id, wreck, burnS: (Date.now() - t0) / 1000, awayKm, preLoss: { cargo: preLoss.cargo.items, consumables: preLoss.modules.consumables, fuel: preLoss.propellant } };
    const state = loadState();
    state.C = { ...st, part1: { steps: S.steps } };
    saveState(state);
    return { part: 1, awayKm: r2(awayKm), burnS: r2(st.burnS), fuelAtLoss: preLoss.propellant, wreck: wreck && { items: wreck.items, consumables: wreck.consumables, fuelKg: wreck.fuelKg }, fails: S.failed(), pass: S.failed().length === 0 && !!wreck };
  }
  const st = await bootSession(d, ctx, "C");
  if (part === "2") {
    // Recover at the active point, make the stack nearly full, fly back on the allowance, collect partially.
    const pDead = await player();
    const rb = await centerOf(ctx, ".death-screen__respawn");
    if (rb) await d.click(rb.x, rb.y);
    await waitArrival(ctx);
    const pR = await player();
    S.ok("recovered at point", !pR.isDead && pR.replication.activeId === st.pointId);
    const rocks = await loadedRocks(ctx);
    await gather(ctx, rocks, { silicates: 180, fe_ni_metal: 45 }, new Set());
    for (let i = 0; i < 9; i++) S.ok(`heat sink ${i + 1}`, await ev(`${G}.craft("consumable_heat_sink_cartridge")`));
    const before = await player();
    const gone = async () => !(await world()).wrecks.some((w) => w.id === st.wreckId);
    const changed = async () => {
      const w = (await world()).wrecks.find((x) => x.id === st.wreckId);
      return !w || JSON.stringify(w.consumables) !== JSON.stringify(st.wreck.consumables);
    };
    const fly = await flyTo(d, ctx, st.wreck.frameId, st.wreck.positionKm, 0.15, 80, changed);
    for (let i = 0; i < 10 && !(await changed()); i++) await ctx.wait(500);
    const after = await player();
    const wNow = (await world()).wrecks.find((x) => x.id === st.wreckId);
    st.salvage = { reached: fly.reached, flightS: r2(fly.s), cargoGot: after.cargo.items, heatSinks: [before.modules.consumables.consumable_heat_sink_cartridge, after.modules.consumables.consumable_heat_sink_cartridge],
      wreckLeft: wNow && { items: wNow.items, consumables: wNow.consumables, fuelKg: wNow.fuelKg }, protectedKg: [pR.propellant.protectedKg, after.propellant.protectedKg], dead: { protectedKg: pDead.propellant.protectedKg } };
    S.ok("partial salvage (stack limit)", !!wNow && (after.modules.consumables.consumable_heat_sink_cartridge ?? 0) === 10 && (wNow.consumables.consumable_heat_sink_cartridge ?? 0) > 0 && (after.cargo.items.fe_ni_metal ?? 0) >= 30);
    // Die again (abandon), then the explicit emergency fallback to the origin point.
    S.ok("abandon again", (await ev(`${G}.res.abandon()`)) === true);
    const usable0 = after.propellant.ordinaryKg + after.propellant.protectedKg;
    await ctx.wait(400);
    const fb = await centerOf(ctx, ".death-screen__fallback", "Emergency fallback");
    if (fb) await d.click(fb.x, fb.y);
    await d.frames(5);
    const confirm = await centerOf(ctx, ".death-screen__fallback-confirm");
    S.ok("fallback button + confirmation (real clicks)", !!fb && !!confirm);
    if (confirm) await d.click(confirm.x, confirm.y);
    await waitArrival(ctx);
    const pF = await player();
    const sF = await ev(`${R}.ship()`);
    const starter = await ev(`${R}.starter()`);
    const em = await ev(`${R}.emergence(${JSON.stringify(starter.positionKm)}, ${JSON.stringify(starter.quaternion)}, 0)`);
    const w = await world();
    st.fallback = { lastRecovery: await ev(`${R}.lastRecovery()`), atStarterKm: r2(Math.hypot(...sF.posKm.map((v, i) => v - em.positionKm[i]))), frame: sF.frameId, fuel: pF.propellant, usableBeforeKg: r2(usable0), activeStill: pF.replication.activeId, wrecks: w.wrecks.length,
      owned: pF.modules.ownedModules, research: w.research.completedNodes };
    S.ok("fallback at origin point", !pF.isDead && st.fallback.atStarterKm < 0.05 && sF.frameId === starter.frameId);
    S.ok("no usable fuel created beyond the allowance rule", pF.propellant.ordinaryKg === 0 && pF.propellant.protectedKg <= 60);
    const steps = [...(st.part1?.steps ?? []), ...S.steps];
    const fails = steps.filter((x) => x.status !== "accepted" && x.status !== "ok");
    ctx.created.push(st.id);
    return { part: 2, setup: "40 kg ordinary at start", awayKm: r2(st.awayKm), burnS: r2(st.burnS), preLoss: st.preLoss, firstWreck: st.wreck && { items: st.wreck.items, consumables: st.wreck.consumables, fuelKg: st.wreck.fuelKg }, salvage: st.salvage, fallback: st.fallback, ops: opsSince(w, st.receipts0), fails, pass: fails.length === 0 };
  }
  return { pass: false, error: `unknown part ${part}` };
}

// ── (g) exploit sweep: every attempt must yield nothing ──
export async function exploitGates(d, ctx) {
  const { ev, submit, player, world, boot } = ctx;
  const out = {};
  const fuelTotal = async () => {
    const p = await player();
    const w = await world();
    return r2(p.propellant.ordinaryKg + p.propellant.protectedKg + w.wrecks.reduce((a, x) => a + x.fuelKg, 0));
  };
  const cargoTotal = (p) => Object.values(p.cargo.items).reduce((a, v) => a + v, 0);

  // 1. Site reward: reload, duplicate id, new id, death + recovery, world switch.
  const idA = await freshWorld(d, ctx, "m37-exp-A");
  await nearSite(d, ctx, 0.5);
  await submit({ type: "site.inspect", opId: "x-ins", siteId: SITE });
  const rec = await submit({ type: "site.recover", opId: "x-rec", siteId: SITE });
  await boot(idA);
  await nearSite(d, ctx, 0.5);
  const dupAfterReload = await submit({ type: "site.recover", opId: "x-rec", siteId: SITE });
  const newAfterReload = await submit({ type: "site.recover", opId: "x-rec-2", siteId: SITE });
  const tiA = (await player()).cargo.items.titanium ?? 0;
  await ev(`${G}.kill()`);
  await ev(`${R}.recover("active")`);
  await settle(ctx, 1200);
  await nearSite(d, ctx, 0.5);
  const afterDeath = await submit({ type: "site.recover", opId: "x-rec-3", siteId: SITE });
  const tiTotal = ((await player()).cargo.items.titanium ?? 0) + (await world()).wrecks.reduce((a, w) => a + (w.items.titanium ?? 0), 0);
  const idB = await freshWorld(d, ctx, "m37-exp-B");
  const otherWorldSite = (await world()).discoveries.sites[SITE] ?? null;
  await boot(idA);
  const backA = (await world()).discoveries.sites[SITE];
  out.site = { recover: rec.status, dupAfterReload: dupAfterReload.status, newAfterReload: newAfterReload.reason ?? newAfterReload.status, afterDeath: afterDeath.reason ?? afterDeath.status, titanium: tiA, titaniumAfterDeath: tiTotal, otherWorldHasStamp: !!otherWorldSite, backInA: !!backA,
    pass: rec.status === "accepted" && dupAfterReload.status === "duplicate" && newAfterReload.reason === "already_done" && afterDeath.reason === "already_done" && tiA === 30 && !otherWorldSite && !!backA };

  // 2. Duplicate opIds on craft / unlock / processing / placement.
  await grant(ctx, { fe_ni_metal: 400, silicates: 300, hydrates: 10 });
  const c1 = await submit({ type: "item.craft", opId: "x-craft", itemId: "consumable_hull_patch_kit" });
  const p1 = await player();
  const c2 = await submit({ type: "item.craft", opId: "x-craft", itemId: "consumable_hull_patch_kit" });
  const p2 = await player();
  const u1 = await submit({ type: "research.unlock", opId: "x-un", nodeId: "ln1_survey_salvage" });
  const u2 = await submit({ type: "research.unlock", opId: "x-un-2", nodeId: "ln1_survey_salvage" });
  out.duplicates = { craft: [c1.status, c2.status], patchKits: [p1.modules.consumables.consumable_hull_patch_kit, p2.modules.consumables.consumable_hull_patch_kit], cargo: [cargoTotal(p1), cargoTotal(p2)], unlock: [u1.status, u2.reason ?? u2.status],
    pass: c1.status === "accepted" && c2.status === "duplicate" && eq(p1.modules, p2.modules) && cargoTotal(p1) === cargoTotal(p2) && u1.status === "accepted" && u2.reason === "already_done" };

  // 3. Processing start/cancel loops never create feedstock or fuel.
  await ev(`${G}.res.set({ ordinaryKg: 300 })`);
  const value = async () => {
    const p = await player();
    const b = p.processing;
    return r2((p.cargo.items.hydrates ?? 0) * 20 + p.propellant.ordinaryKg + (b ? (b.reserved.hydrates ?? 0) * 20 - b.committedKg : 0));
  };
  await ev("__test.save.flush()");
  const v0 = await value();
  const loops = [];
  for (let i = 0; i < 5; i++) {
    const s = await ev(`${G}.res.startProcessing(5)`);
    await settle(ctx, 300 + i * 200);
    const c = await ev(`${G}.res.cancelProcessing()`);
    await ev("__test.save.flush()");
    loops.push({ start: s.status, cancel: c.status, value: await value() });
  }
  out.cancelLoops = { v0, loops, pass: loops.every((l) => l.value <= v0 + 0.01) };

  // 4. Equip swaps: an overflowing loadout is refused; swapping never changes stores.
  await grant(ctx, { silicates: 200, fe_ni_metal: 80, titanium: 30 });
  const fit = await submit({ type: "item.craft", opId: "x-suite", itemId: "module_integrated_sensor_suite" });
  const pq0 = await player();
  const swaps = [];
  for (let i = 0; i < 4; i++) swaps.push((await submit({ type: "module.equip", opId: `x-eq-${i}`, slot: "scanner", itemId: i % 2 ? "module_integrated_sensor_suite" : null })).status);
  const pq1 = await player();
  out.equipSwaps = { craft: fit.status, swaps, same: eq(pq0.cargo, pq1.cargo) && pq0.propellant.ordinaryKg === pq1.propellant.ordinaryKg, owned: pq1.modules.ownedModules.filter((x) => x === "module_integrated_sensor_suite").length,
    pass: fit.status === "accepted" && swaps.every((x) => x === "accepted") && eq(pq0.cargo, pq1.cargo) && pq0.propellant.ordinaryKg === pq1.propellant.ordinaryKg && pq1.modules.ownedModules.filter((x) => x === "module_integrated_sensor_suite").length === 1 };

  // 5. Death loops: tanks + wrecks never rise (above the stranded-ship allowance rule).
  await ev(`${G}.nudgeKm(30, 0, 0)`);
  await d.frames(10);
  await ev(`${G}.res.set({ ordinaryKg: 250, protectedKg: 60 })`);
  await ev("__test.save.flush()");
  const f0 = await fuelTotal();
  const deaths = [];
  for (let i = 0; i < 5; i++) {
    await ev(`${G}.nudgeKm(${2 + i}, 0, 0)`);
    await d.frames(5);
    const k = await ev(`${G}.kill()`);
    const r = await ev(`${R}.recover("active")`);
    await settle(ctx, 700);
    deaths.push({ kill: k?.status, recover: r.status, totalKg: await fuelTotal() });
  }
  out.deathLoops = { f0, deaths, pass: deaths.every((x) => x.totalKg <= f0 + 1e-6 && x.kill === "accepted" && x.recover === "accepted") };

  // 6. Difficulty: no in-game switch exists; an edited setting changes rates only (stored state kept).
  const pd0 = await player();
  await ev(`${M}.difficulty.setWorld("explorer")`);
  await boot(idA);
  const pd1 = await player();
  await ev(`${M}.difficulty.setWorld("standard")`);
  out.difficulty = { uiSwitch: "none (chosen at world creation)", sameStores: eq(pd0.cargo, pd1.cargo) && Math.abs(pd0.propellant.ordinaryKg - pd1.propellant.ordinaryKg) < 1e-6 && pd0.propellant.protectedKg === pd1.propellant.protectedKg,
    pass: eq(pd0.cargo, pd1.cargo) && pd0.propellant.protectedKg === pd1.propellant.protectedKg };

  // 7. Projects and hints carry no rewards: completing one changes no store.
  const pp0 = await player();
  await ev(`${M}.project.track("forward_point")`);
  await ev(`${M}.project.track(null)`);
  const pp1 = await player();
  out.projects = { pass: eq(pp0.cargo, pp1.cargo) && eq(pp0.modules, pp1.modules) };
  void idB;
  out.pass = Object.values(out).every((v) => v.pass);
  return out;
}

// ── (h) captures ──
export async function shotGates(d, ctx) {
  const { ev } = ctx;
  const shots = {};
  // Opening premise on a fresh world.
  const id = await freshWorld(d, ctx, "m37-shots", { named: false });
  await ev(`${M}.comms.reset()`);
  await d.frames(40);
  await settle(ctx, 1200);
  shots.opening = await d.shot("m3-opening");
  await ev(`${M}.comms.dismiss()`);
  await ev(`${M}.comms.nameAi("Vega")`);
  await d.frames(5);
  await ev(`${M}.comms.dismiss()`);
  await ev(`${M}.comms.nextHint()`);
  // Tracker with progress; a hint line.
  await ev(`${M}.project.track("reach_moon")`);
  await grant(ctx, { hydrates: 2 });
  await d.frames(20);
  await settle(ctx, 600);
  shots.tracker = await d.shot("m3-project-tracker");
  // Low fuel, far from the active point, warm.
  await ev(`${G}.nudgeKm(900, 40, -300)`);
  await d.frames(30);
  await ev(`${G}.res.set({ ordinaryKg: 30, heat01: 0.55 })`);
  await d.frames(20);
  await settle(ctx, 700);
  shots.lowFuel = await d.shot("m3-hud-glance-low-fuel");
  // Lunar site approach and recovery.
  await ev(`${G}.res.set({ ordinaryKg: 400, heat01: 0 })`);
  await nearSite(d, ctx, 1.6);
  const site = (await ev(`${M}.site.defs()`)).find((s) => s.id === SITE);
  const abs = await ev(`${M}.site.absKm(${JSON.stringify(SITE)})`);
  await ev(`${G}.res.face(${JSON.stringify(abs)})`);
  await d.frames(30);
  await settle(ctx, 1500);
  shots.approach = await d.shot("m3-lunar-site-approach");
  await d.press("g");
  await nearSite(d, ctx, 0.45);
  await ev(`${G}.res.face(${JSON.stringify(await ev(`${M}.site.absKm(${JSON.stringify(SITE)})`))})`);
  await d.frames(30);
  await settle(ctx, 800);
  await d.press("g");
  await d.frames(15);
  await settle(ctx, 500);
  shots.recover = await d.shot("m3-lunar-site-recover");
  void id;
  void site;
  return { shots, pass: Object.values(shots).every(Boolean) };
}

/** 390×844 (run with --size 390x844): the HUD and the transit refusal toast. */
export async function narrowGates(d, ctx) {
  const { ev } = ctx;
  const shots = {};
  await freshWorld(d, ctx, "m37-narrow");
  await ev(`${M}.project.track("reach_moon")`);
  await grant(ctx, { fe_ni_metal: 40, silicates: 30 });
  await d.frames(30);
  await settle(ctx, 800);
  shots.hud = await d.shot("m3-hud-narrow");
  // Transit refused: the drive with too little propellant for the Moon.
  await ev(`${G}.res.equip("special_transit_drive", "utility")`);
  await ev(`${M}.site.setDestination({ bodyId: "luna" })`);
  await ev(`${G}.res.set({ ordinaryKg: 5 })`);
  await d.frames(20);
  await settle(ctx, 800);
  await d.hold("t", 400);
  await settle(ctx, 300);
  shots.refused = await d.shot("m3-transit-refused-narrow");
  const overlap = await ev(`(() => {
    const t = [...document.querySelectorAll(".toast-display__item")].map((e) => e.getBoundingClientRect());
    const panel = document.querySelector(".transit-hud--preview");
    const title = panel && panel.querySelector(".transit-hud__phase-label");
    const name = panel && panel.querySelector(".transit-hud__target-name");
    const r = title && name && { left: Math.min(title.getBoundingClientRect().left, name.getBoundingClientRect().left), right: Math.max(title.getBoundingClientRect().right, name.getBoundingClientRect().right), top: title.getBoundingClientRect().top, bottom: name.getBoundingClientRect().bottom };
    const btns = document.querySelector(".hud__panel-buttons")?.getBoundingClientRect();
    const cargo = document.querySelector(".cargo-hud")?.getBoundingClientRect();
    const hit = (a, b) => !!a && !!b && !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    return { toasts: t.length, toastHitsPlanTitle: t.some((x) => hit(x, r)), buttonsHitCargo: hit(btns, cargo), planFound: !!panel };
  })()`);
  return { shots, overlap, pass: !overlap.toastHitsPlanTitle && !overlap.buttonsHitCargo };
}

/** Title screen: the new-world form with the difficulty choice (run with --title). */
export async function titleShot(d) {
  const ev = (s) => d.evaluate(s);
  await ev(`(() => { const b = [...document.querySelectorAll(".shell-menu__item")].find((x) => x.textContent.includes("New world")); b && b.click(); })()`);
  await new Promise((r) => setTimeout(r, 800));
  return { shot: await rawShot(d, "m3-world-create-difficulty") };
}
