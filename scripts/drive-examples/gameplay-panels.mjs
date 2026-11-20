/**
 * Playtest-1 WP4 panel gates (part `panels` of gameplay-check.mjs; needs --no-isolate; run at the
 * default 1280×720 and with --size 390x844): captures of Research (options + discoveries), Projects
 * (mixed progress + records), Crafting (every category), the tracker, the death screen and the respawn
 * confirm; DOM: fixed panel height across tabs/states, ResourceIcon tooltips, completed projects
 * untrackable and last, no `.pp-section`, and the R1 text budget (glance ≤ 3 words, menu ≤ 8).
 */
import { writeFileSync } from "node:fs";
import { freshWorld } from "./gameplay-m37.mjs";
import { loadedRocks } from "./gameplay-m33.mjs";

const G = "__test.gameplay";
const M = `${G}.m37`;
const log = (...a) => console.log("[panels]", ...a);
const ALL_NODES = ["sv1_composition_survey", "sv2_volatile_mapping", "ex1_controlled_extraction", "ex2_yield_analysis", "th1_heat_rejection", "lg1_bulk_handling", "pr1_transit_calibration", "pr2_thruster_tuning", "hl1_hull_reinforcement", "ln1_survey_salvage"];

/** In-page R1 check: own text of every visible element under `sel`, numbers/units and names excluded. */
const budget = (sel, limit) => `(() => {
  const unit = /^([\\d.,:/%×+−–-]+|kg|km|m|s|kW|kg\\/s|units|—|→|·|r|of|\\?|:)$/;
  const out = [];
  for (const root of document.querySelectorAll(${JSON.stringify(sel)})) {
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (el.closest("kbd,.sn-tooltip,.pp-record,.comms-overlay,[data-name],input,svg")) continue;
      if (el.getClientRects().length === 0) continue;
      let own = "";
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent + " ";
      const words = own.trim().split(/\\s+/).filter((w) => w && !unit.test(w));
      if (words.length > ${limit}) out.push(own.trim().replace(/\\s+/g, " "));
    }
  }
  return out;
})()`;

const panelBox = `(() => { const p = document.querySelector(".panel"); if (!p) return null; const r = p.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()`;
const clickText = (sel, text) => `(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`;

/** Real mouse hover over the first match; returns the portalled tooltip's text. */
async function hoverTip(d, ctx, sel) {
  const c = await ctx.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, e.querySelector("img,[aria-label]")?.getAttribute("alt") ?? e.querySelector("[aria-label]")?.getAttribute("aria-label") ?? null]; })()`);
  if (!c) return { found: false };
  await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c[0] + 1, y: c[1] });
  await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: c[0], y: c[1] });
  await ctx.wait(400);
  const tip = await ctx.ev(`document.querySelector(".sn-tooltip")?.textContent ?? null`);
  await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
  await ctx.wait(100);
  return { found: true, name: c[2], tip, pass: !!tip && !!c[2] && tip.includes(c[2]) };
}

async function shot(d, ctx, name, narrow, sel, limit, raw = false) {
  await ctx.wait(350);
  const stem = `wp4-${name}${narrow ? "-narrow" : ""}`;
  // The settings menu stops the render loop, so d.shot's frame wait would hang there.
  const file = raw ? (writeFileSync(`.captures/${stem}.png`, Buffer.from((await d.send("Page.captureScreenshot", { format: "png" })).data, "base64")), `.captures/${stem}.png`) : await d.shot(stem);
  const over = sel ? await ctx.ev(budget(sel, limit)) : [];
  const box = await ctx.ev(panelBox);
  log(name, JSON.stringify({ box, over }));
  return { file, box, over };
}

export async function panelGates(d, ctx) {
  const { ev } = ctx;
  const narrow = (await ev("innerWidth")) < 600;
  const out = {};
  await freshWorld(d, ctx, `panels${narrow ? "-narrow" : ""}`);
  await ev(`${M}.comms.dismiss()`);
  await ctx.wait(800);

  // Partial progress: two classes inspected, one trial, Heat Rejection unlocked, a little cargo.
  const rocks = await loadedRocks(ctx);
  const s = rocks.find((r) => r.classId === "s_type");
  const c = rocks.find((r) => r.classId === "c_type");
  for (const r of [s, c].filter(Boolean)) await ev(`${G}.m33.inspect(${JSON.stringify(r)})`);
  const disc = (await ev(`${G}.world()`)).discoveries;
  disc.trials.sustained_beam = disc.trials.sustained_beam ?? { at: 1, by: ctx.me };
  await ev(`${G}.m33.devSetWorld(${JSON.stringify({ discoveries: disc, completedNodes: ["th1_heat_rejection"] })})`);
  for (const [k, n] of Object.entries({ silicates: 112, fe_ni_metal: 160, hydrates: 14, carbon: 30, sulfur: 5 })) await ev(`__dev.grantCargo(${JSON.stringify(k)}, ${n})`);
  const kit = await ev(`${G}.craft("consumable_replication_kit")`);
  await ev(`${M}.project.track("research:sv1_composition_survey")`);
  await d.frames(10);
  out.tracker = await shot(d, ctx, "tracker", narrow, ".objective-tracker", 3);
  out.tracker.pass = out.tracker.over.length === 0 && (await ev(`document.querySelectorAll(".objective-tracker .sn-req").length`)) > 0;

  // Research: options then discoveries, same panel box; tooltips on a material.
  await d.press("r");
  await ctx.wait(600);
  const opt = await shot(d, ctx, "research-options", narrow, ".panel", 8);
  const cards = await ev(`[...document.querySelectorAll(".rp-card:not(.rp-card--industry)")].map((e) => Math.round(e.getBoundingClientRect().height))`);
  const research = { options: opt, cardHeights: [...new Set(cards)], intro: await ev(`!!document.querySelector(".rp-intro,.rp-card__purpose")`),
    count: await ev(`document.querySelector("[data-testid=research-count]")?.textContent`), unlockedStrip: await ev(`!!document.querySelector("[data-testid=research-unlocked]")`) };
  research.industryFits = await ev(`[...document.querySelectorAll(".rp-card--industry")].every(card => {
    const equipment = card.querySelector(".rp-card__industry");
    return equipment?.textContent && card.scrollHeight <= card.clientHeight + 1 && card.scrollWidth <= card.clientWidth + 1;
  })`);
  const optionCount = await ev(`${G}.m33.audit().nodes`);
  research.chipTip = await hoverTip(d, ctx, ".rp-card .sn-req");
  research.chipTip.pass = !!research.chipTip.tip;
  await ev(clickText(".rp-tabs__btn", "Discoveries"));
  research.discoveries = await shot(d, ctx, "research-discoveries", narrow, ".panel", 8);
  research.resTip = await hoverTip(d, ctx, ".rp-source .sn-res");
  // A state change (cargo arrives) must not move the panel either.
  await ev(`__dev.grantCargo("silicates", 40)`);
  await ev(clickText(".rp-tabs__btn", "Options"));
  research.afterGrant = await shot(d, ctx, "research-options-ready", narrow, ".panel", 8);
  await ev(`document.querySelector(".panel__body").scrollTop = 1e6`);
  research.unlockedShot = await shot(d, ctx, "research-unlocked", narrow, ".panel", 8);
  const rBoxes = [opt.box, research.discoveries.box, research.afterGrant.box, research.unlockedShot.box].map(String);
  research.pass = new Set(rBoxes).size === 1 && research.cardHeights.length === 1 && research.cardHeights[0] === 112 && !research.intro && research.industryFits && research.count === `1/${optionCount}` &&
    research.unlockedStrip && research.resTip.pass && research.chipTip.pass && [opt, research.discoveries, research.afterGrant, research.unlockedShot].every((x) => x.over.length === 0);
  out.research = research;
  await d.press("Escape");
  await ctx.wait(400);

  // Projects: one sorted list, completed last without Track, no subtitle/section; records same box.
  await d.press("p");
  await ctx.wait(600);
  const pj = await shot(d, ctx, "projects", narrow, ".panel", 8);
  const rows = await ev(`[...document.querySelectorAll("[data-project]")].map((e) => ({ id: e.dataset.project, done: e.classList.contains("pp-done"), n: e.querySelector(".pp-count")?.textContent ?? null, track: !!e.querySelector(".pp-btn") }))`);
  const frac = (r) => (r.done ? -1 : (() => { const [a, b] = r.n.split("/").map(Number); return a / b; })());
  let sorted = true;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (a.done && !b.done) sorted = false;
    if (!a.done && !b.done) {
      const fa = frac(a), fb = frac(b);
      if (fa === 0 && fb > 0) sorted = false;
      if (fa > 0 && fb > 0 && fb > fa + 1e-9) sorted = false;
    }
  }
  await ev(clickText(".pp-tabs__btn", "Records"));
  const rec = await shot(d, ctx, "projects-records", narrow, null);
  const recWords = await ev(`[...document.querySelectorAll(".pp-record__text")].map((e) => e.textContent.split(/\\s+/).length)`);
  await ev(clickText(".pp-tabs__btn", "Projects"));
  out.projects = { shot: pj, records: rec, rows, sorted, completed: rows.filter((r) => r.done).map((r) => r.id), completedTrack: rows.filter((r) => r.done && r.track).length,
    section: await ev(`document.querySelectorAll(".pp-section").length`), subtitle: await ev(`!!document.querySelector(".panel__subtitle")`), recWords,
    fractions: rows.map((r) => (r.done ? "✓" : r.n)) };
  out.projects.pass = sorted && out.projects.completed.length > 0 && out.projects.completedTrack === 0 && out.projects.section === 0 && !out.projects.subtitle &&
    String(pj.box) === String(rec.box) && pj.over.length === 0 && rows.some((r) => !r.done && frac(r) === 0) && rows.some((r) => !r.done && frac(r) > 0);
  await d.press("Escape");
  await ctx.wait(400);

  // Crafting: every option unlocked, every category captured; the box never moves.
  await ev(`${G}.m33.devSetWorld(${JSON.stringify({ completedNodes: ALL_NODES })})`);
  await d.press("c");
  await ctx.wait(600);
  const cats = await ev(`[...document.querySelectorAll(".crafting-panel__filter-btn[data-category]")].map((e) => e.dataset.category)`);
  const craft = { cats, shots: {}, boxes: [], over: [], chipOver: [] };
  for (const cat of cats) {
    await ev(`document.querySelector('.crafting-panel__filter-btn[data-category="${cat}"]').click()`);
    const r = await shot(d, ctx, `craft-${cat}`, narrow, ".panel", 8);
    const n = await ev(`document.querySelectorAll(".crafting-panel__list .crafting-panel__item").length + document.querySelectorAll(".crafting-panel__workshop").length`);
    craft.shots[cat] = { file: r.file, items: n };
    craft.boxes.push(String(r.box));
    craft.over.push(...r.over);
    // Effect chips are glance-tier (R1): ≤ 3 words.
    craft.chipOver.push(...(await ev(budget(".crafting-panel__item-effect", 3))));
  }
  await ev(`document.querySelector('.crafting-panel__filter-btn[data-category="all"]').click()`);
  craft.recipeTip = await hoverTip(d, ctx, ".crafting-panel__recipe .sn-res");
  await ev(`document.querySelector('.crafting-panel__filter-btn[data-category="drive"]')?.click()`);
  await ctx.wait(200);
  craft.driveTab = await ev(`[...document.querySelectorAll(".crafting-panel__list .crafting-panel__item-name")].map((e) => e.textContent)`);
  const expectOrder = ["all", "drive", "scanner", "mining", "cooling", "cargo", "propulsion", "hull", "utility", "consumables", "processing"];
  craft.pass = String(cats) === String(expectOrder) && new Set(craft.boxes).size === 1 && craft.over.length === 0 && craft.chipOver.length === 0 && craft.recipeTip.pass && String(craft.driveTab) === "Transit Drive" &&
    Object.values(craft.shots).every((x) => x.items > 0);
  out.craft = craft;
  await d.press("Escape");
  await ctx.wait(400);

  // Death screen, then the respawn confirm from Settings.
  await ev(`${G}.kill()`);
  await ctx.wait(2600);
  const death = await shot(d, ctx, "death", narrow, ".death-screen", 8);
  out.death = { ...death, text: await ev(`document.querySelector(".death-screen")?.innerText.replace(/\\s+/g, " ")`), chips: await ev(`document.querySelectorAll("[data-testid=wreck-row] .sn-res").length`) };
  out.death.pass = death.over.length === 0 && out.death.chips > 0 && /Ship destroyed/i.test(out.death.text) && /Respawn at/i.test(out.death.text);
  await ev(`document.querySelector(".death-screen__respawn")?.click()`);
  await ctx.wait(2500);
  // A running batch: its unconverted feedstock must show in the confirm's wreck row (ship.destroy moves it).
  await ev(`__dev.grantCargo("hydrates", 12)`);
  const batch = await ev(`${G}.res.startProcessing(10)`);
  await d.frames(3);
  const cargoHyd = Math.floor((await ctx.player()).cargo.items.hydrates ?? 0);
  await ev(`(() => { const b = document.querySelector(".settings__open-button"); b && b.click(); })()`);
  await ctx.wait(500);
  await ev(`document.querySelector('[data-action="respawn"]')?.click()`);
  await ctx.wait(300);
  const conf = await shot(d, ctx, "respawn-confirm", narrow, ".settings-menu__abandon", 8, true);
  out.respawn = { ...conf, text: await ev(`document.querySelector(".settings-menu__abandon")?.innerText.replace(/\\s+/g, " ")`), button: await ev(`document.querySelector('[data-action="respawn"]')?.textContent ?? null`) };
  out.respawn.batch = { start: batch?.status, cargoHyd, wreckHyd: await ev(`(() => { const c = [...document.querySelectorAll(".settings-menu__abandon [data-testid=wreck-row] .sn-res")].find((e) => /hydrat/i.test(e.querySelector("img,[aria-label]")?.getAttribute("alt") ?? e.querySelector("[aria-label]")?.getAttribute("aria-label") ?? "")); return c ? Number(c.querySelector(".sn-res__n")?.textContent) : null; })()`) };
  out.respawn.batch.pass = out.respawn.batch.start === "accepted" && out.respawn.batch.wreckHyd >= cargoHyd + 9;
  out.respawn.pass = conf.over.length === 0 && /^Respawn at .+\?/.test(out.respawn.text ?? "") && out.respawn.batch.pass;
  await ev(clickText(".settings-menu__abandon button", "Cancel"));
  await ctx.wait(200);
  out.respawn.buttonLabel = await ev(`document.querySelector('[data-action="respawn"]')?.textContent ?? null`);
  out.respawn.pass = out.respawn.pass && out.respawn.buttonLabel === "Respawn";
  await d.press("Escape");
  out.kit = kit?.status;
  out.pass = ["tracker", "research", "projects", "craft", "death", "respawn"].every((k) => out[k].pass);
  log("result", JSON.stringify(Object.fromEntries(["tracker", "research", "projects", "craft", "death", "respawn"].map((k) => [k, out[k].pass]))));
  return out;
}
