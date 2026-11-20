/**
 * Playtest-1 WP3 HUD gates (parts of gameplay-check.mjs; needs --no-isolate, disposable "[gc] " worlds):
 *   hud          captures of every HUD state + DOM: no two HUD homes intersect, all inside the viewport
 *                (run twice: default 1280×720 and --size 390x844); real G inspect with voice sampling
 *   hudTransit   transit panel geometry sampled every 60 ms through a two-leg trip (width constant,
 *                height changes only with the plan → active state)
 *   hudSite      real keys from a transit arrival: lock the canister, one G, recovered
 *   lunarShots   captures at the field arrival (Luna, nearest big rock) and at the canister (lighting check)
 *   hudKeys      keybinds v2 → v3: untouched defaults move to C/P, custom bindings stay (restores storage)
 *   hudHotbar    keys 1…9, 0; a crafted kit fills a slot; its key opens placement with editable name
 */
import { freshWorld } from "./gameplay-m37.mjs";
import { findClearPreview, waitArrival } from "./gameplay-m36.mjs";
import { loadedRocks, waitFor } from "./gameplay-m33.mjs";

const G = "__test.gameplay";
const M = `${G}.m37`;
const R = `${G}.rep`;
const TR = `${G}.transit`;
const SITE = "luna_survey_canister";
const KIT = "consumable_replication_kit";
const PATCH = "consumable_hull_patch_kit";
const SINK = "consumable_heat_sink_cartridge";
const DEFAULT_EPOCH_MS = Date.UTC(2941, 8, 22, 0, 0, 0);
const log = (...a) => console.log("[hud]", ...a);
const slotKey = (i) => String((i + 1) % 10);

/** In-page: every HUD home's rect; pairs that intersect; homes outside the viewport. */
const LAYOUT = `(() => {
  const homes = { card: ".target-card--visible", tracker: ".objective-tracker", transit: ".transit-hud--side", dash: ".ship-dashboard", hotbar: ".hotbar", buttons: ".hud__panel-buttons", cargo: ".cargo-hud", gear: ".settings__open-button", comms: ".comms-overlay" };
  const rects = [];
  const vis = (e) => { const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0 ? r : null; };
  for (const [k, sel] of Object.entries(homes)) for (const e of document.querySelectorAll(sel)) { const r = vis(e); if (r) rects.push({ k, r }); }
  document.querySelectorAll(".notif-stack__item").forEach((e, i) => { const r = vis(e); if (r) rects.push({ k: "stack" + i, r }); });
  const hit = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  const hits = [];
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (hit(rects[i].r, rects[j].r)) hits.push(rects[i].k + "×" + rects[j].k);
  const W = innerWidth, H = innerHeight;
  const outside = rects.filter(({ r }) => r.left < -0.5 || r.top < -0.5 || r.right > W + 0.5 || r.bottom > H + 0.5).map(({ k }) => k);
  const box = (r) => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  const card = document.querySelector(".target-card");
  return { size: [W, H], homes: Object.fromEntries(rects.map(({ k, r }) => [k, box(r)])), hits, outside, card: card ? card.dataset.kind : null,
    cardText: card ? card.innerText.replace(/\\s+/g, " ").trim() : "", stack: [...document.querySelectorAll(".notif-stack__item")].map((e) => e.innerText.replace(/\\s+/g, " ").trim()) };
})()`;

async function state(d, ctx, name, expectCard, narrow, settleMs = 350) {
  if (settleMs) await ctx.wait(settleMs);
  const shot = await d.shot(`wp3-hud-${name}${narrow ? "-narrow" : ""}`);
  const l = await ctx.ev(LAYOUT);
  const pass = l.hits.length === 0 && l.outside.length === 0 && (expectCard === undefined || l.card === expectCard);
  log(name, pass ? "PASS" : "FAIL", JSON.stringify({ card: l.card, hits: l.hits, outside: l.outside, cardText: l.cardText, stack: l.stack }));
  return { shot, card: l.card, cardText: l.cardText, stack: l.stack, hits: l.hits, outside: l.outside, homes: l.homes, pass };
}

/** Face a frame-relative point in ONE evaluate (frames move ~30 km/s in system km: a stale abs misses). */
const faceRel = (ctx, frameId, posKm) => ctx.ev(`${G}.res.face(${R}.abs(${JSON.stringify(frameId)}, ${JSON.stringify(posKm)}))`);
const faceSite = (ctx) => ctx.ev(`${G}.res.face(${M}.site.absKm(${JSON.stringify(SITE)}))`);

const focusKind = async (ctx) => {
  const f = await ctx.ev(`${M}.site.focus()`);
  return f.focused && f.target ? f.target.kind : null;
};

// ── hud ──
export async function hudGates(d, ctx) {
  const { ev, world } = ctx;
  const narrow = (await ev("innerWidth")) < 600;
  const out = {};
  await freshWorld(d, ctx, `hud${narrow ? "-narrow" : ""}`);
  await ev(`${M}.comms.nextHint()`);
  await ctx.wait(1500);
  await ev(`${M}.comms.dismiss()`);
  await ev(`${M}.project.track("reach_moon")`);
  await ev("__test.audio.unlock()").catch(() => null);
  await d.frames(30);
  out.idle = await state(d, ctx, "idle", "", narrow);

  // Rock: lock, then a real G inspection with the voice table sampled.
  const rocks = await loadedRocks(ctx);
  const rock = rocks.find((r) => r.radiusM > 40 && r.radiusM < 160 && r.distKm < 20) ?? rocks[0];
  await ev(`${G}.m33.approach(${JSON.stringify(rock)}, ${rock.radiusM / 1000 + 0.6})`);
  await d.frames(10);
  await ev(`${G}.res.face(${JSON.stringify(rock)})`);
  const focused = await waitFor(ctx, async () => (await ev(`${G}.res.mining()`)).focused, 8000);
  out.rock = { focused, ...(await state(d, ctx, "rock", "rock", narrow)) };
  await ev(`(() => { window.__wp3Ev = new Set(); window.__wp3T = setInterval(() => {
    for (const v of (__audio.voices() ?? [])) window.__wp3Ev.add(v.event ?? v.id ?? JSON.stringify(v));
    for (const v of (__audio.emitters() ?? [])) window.__wp3Ev.add(v.event ?? v.id ?? JSON.stringify(v));
  }, 100); })()`);
  await d.press("g");
  const inspecting = await waitFor(ctx, () => ev('!!document.querySelector(".target-card__bar--info")'), 6000);
  out.inspecting = await state(d, ctx, "inspecting", "rock", narrow, 0);
  out.inspecting.pass &&= inspecting && out.inspecting.cardText.endsWith("Stop");
  const inspected = await waitFor(ctx, async () => (await ev(`document.querySelectorAll(".target-card__row--contents .sn-res__n").length`)) > 0, 9000);
  await ctx.wait(400);
  const events = await ev(`(() => { clearInterval(window.__wp3T); return [...window.__wp3Ev].filter((x) => /inspect/.test(x)); })()`);
  out.inspectAudio = { events, pass: ["mining.inspect.start", "mining.inspect.loop", "mining.inspect.complete"].every((id) => events.some((e) => e.includes(id))) };
  log("inspectAudio", JSON.stringify(out.inspectAudio));
  out.inspected = { inspected, ...(await state(d, ctx, "rock-inspected", "rock", narrow)) };
  // The card's amounts are the mine claim (fresh world: efficiency 1), not the stored inspection.
  const card = await ev(`[...document.querySelectorAll(".target-card__row--contents .sn-res__n")].map((e) => Number(e.textContent))`);
  const claim = Object.values(await ev(`${G}.m37.difficulty.mineClaim(${JSON.stringify(rock)})`)).sort((a, b) => b - a).slice(0, 5);
  out.cardClaim = { card, claim, pass: JSON.stringify(card) === JSON.stringify(claim) };
  log("cardClaim", JSON.stringify(out.cardClaim));

  // Mining: the card's bar, then the Mined item in the stack.
  await d.press("m");
  const mining = await waitFor(ctx, () => ev('!!document.querySelector(".target-card__bar--heat")'), 6000);
  out.mining = await state(d, ctx, "mining", "rock", narrow, 0);
  out.mining.pass &&= mining && out.mining.cardText.endsWith("Stop");
  await waitFor(ctx, async () => !(await ev(`${G}.res.mining()`)).mining, 30000);
  await ctx.wait(300);
  out.mined = await state(d, ctx, "mined", undefined, narrow);
  out.mined.pass &&= out.mined.stack.some((s) => s.startsWith("Mined"));

  // A crafted kit's hotbar key opens the NEW POINT card; focus selects the name.
  for (const [r, n] of Object.entries({ fe_ni_metal: 150, silicates: 100 })) await ev(`__dev.grantCargo(${JSON.stringify(r)}, ${n})`);
  await ev(`${G}.craft(${JSON.stringify(KIT)})`);
  await findClearPreview(d, ctx);
  await ev(`${R}.setMode(false)`);
  await d.frames(10);
  const kitSlot = (await ctx.player()).modules.hotbar.indexOf(KIT);
  await d.press(slotKey(kitSlot));
  await d.frames(10);
  await ev('document.querySelector(".target-card__input")?.focus()');
  const input = await ev(`(() => { const i = document.activeElement; return i && i.classList.contains("target-card__input") ? { value: i.value, all: i.selectionStart === 0 && i.selectionEnd === i.value.length } : null; })()`);
  out.placement = { kitSlot, input, ...(await state(d, ctx, "placement", "place", narrow)) };
  out.placement.pass &&= !!input?.all;
  await d.type("Camp");
  await d.press("Enter");
  await d.frames(20);
  const point = (await world()).replication.points.find((p) => p.name === "Camp");
  out.placed = { point: point?.name ?? null, pass: !!point };

  // The placed point under the reticle.
  if (point) {
    await waitFor(ctx, async () => (await faceRel(ctx, point.frameId, point.positionKm), (await focusKind(ctx)) === "point"), 6000);
    out.point = await state(d, ctx, "point", "point", narrow);
  }

  // A wreck: abandon, respawn at Camp, look back at the loss site.
  await ev(`${G}.res.abandon()`);
  await d.frames(10);
  await ev(`${R}.recover("active")`);
  await waitArrival(ctx);
  await ctx.wait(500);
  const wreck = (await world()).wrecks.at(-1);
  out.wreckFound = { pass: !!wreck };
  if (wreck) {
    const nav = await ev(`${G}.res.nav(${R}.abs(${JSON.stringify(wreck.frameId)}, ${JSON.stringify(wreck.positionKm)}))`);
    if (nav.distKm > 4 || nav.distKm < 0.5) await ev(`${R}.teleportRel(${JSON.stringify(wreck.frameId)}, ${JSON.stringify([wreck.positionKm[0] + 1.2, wreck.positionKm[1], wreck.positionKm[2]])})`);
    await d.frames(20);
    await waitFor(ctx, async () => (await faceRel(ctx, wreck.frameId, wreck.positionKm), (await focusKind(ctx)) === "wreck"), 6000);
    out.wreck = await state(d, ctx, "wreck", "wreck", narrow);
    // Control: out of salvage range G rejects; in range it has nothing to do, so no reject.
    const sampleRejects = async () => {
      await ev(`(() => { window.__wp3WR = 0; window.__wp3WT = setInterval(() => { for (const v of (__audio.voices() ?? [])) if ((v.eventId ?? v.event ?? v.id) === "ui.reject") window.__wp3WR++; }, 50); })()`);
      await d.press("g");
      await ctx.wait(400);
      return ev(`(() => { clearInterval(window.__wp3WT); return window.__wp3WR; })()`);
    };
    const farRejects = await sampleRejects();
    await ev(`${R}.teleportRel(${JSON.stringify(wreck.frameId)}, ${JSON.stringify([wreck.positionKm[0] + 0.2, wreck.positionKm[1], wreck.positionKm[2]])})`);
    await d.frames(10);
    const inRange = await waitFor(ctx, async () => (await faceRel(ctx, wreck.frameId, wreck.positionKm), (await ev(`${M}.site.focus()`))?.target?.inRange === true), 4000);
    const rejects = await sampleRejects();
    out.wreckG = { farRejects, inRange, rejects, pass: farRejects > 0 && inRange && rejects === 0 };
    log("wreckG", JSON.stringify(out.wreckG));
  }

  // Survey site from 1.5 km.
  const site = (await ev(`${M}.site.defs()`)).find((s) => s.id === SITE);
  await ev(`${R}.teleportRel("luna", ${JSON.stringify([site.positionKm[0] + 1.5, site.positionKm[1], site.positionKm[2]])})`);
  await d.frames(30);
  await waitFor(ctx, async () => (await faceSite(ctx), (await focusKind(ctx)) === "site"), 6000);
  out.site = await state(d, ctx, "site", "site", narrow);

  // Transit: the idle plan, then the active panel (abort with T).
  await ev(`${G}.res.equip("special_transit_drive", "utility")`);
  // Playtest 2: Luna -> Earth needs the Auxiliary Tank.
  await ev(`${G}.res.equip("module_aux_tank_mk1", "cargo")`);
  await d.frames(5);
  await ev(`${G}.res.set({ ordinaryKg: 1000 })`);
  await ev(`${M}.site.setDestination({ bodyId: "earth" })`);
  await ev(`${G}.res.face(${R}.abs("earth", [0, 0, 0]))`);
  await d.frames(30);
  await ctx.wait(800);
  out.transitPlan = await state(d, ctx, "transit-plan", undefined, narrow);
  await d.hold("t", 3400);
  await ctx.wait(2500);
  out.transitActive = await state(d, ctx, "transit-active", undefined, narrow);
  await d.press("t");
  await waitFor(ctx, async () => (await ev(`${TR}.state()`)).phase === "idle", 60000);
  const panelOk = (s) => !!s.homes.transit;
  out.transitPlan.pass &&= panelOk(out.transitPlan);
  out.transitActive.pass &&= panelOk(out.transitActive);
  return { narrow, ...out, pass: Object.values(out).every((x) => x.pass !== false) };
}

// ── hudTransit: panel geometry through a two-leg trip ──
function transitWorld(ctx) {
  const modules = { ownedModules: ["special_transit_drive", "module_aux_tank_mk1"], equippedModules: { cargo: "module_aux_tank_mk1" }, consumables: {}, consumableCooldowns: {}, hotbar: Array(10).fill(null) };
  const { research, ...rest } = ctx.v1Player({ modules });
  void research;
  const player = { ...rest, research: { assaySamples: 0, activeResearch: null }, propellant: { ordinaryKg: 1000, protectedKg: 60 }, power: { capacitor01: 1, heat01: 0 }, processing: null, aiName: "Vega", commsPlayed: ["opening_001", "opening_002", "hint_projects", "hint_lock", "drive_online_001", "hint_drive"] };
  return { schemaVersion: 2, world: { ...ctx.v1World({ simEpochMs: DEFAULT_EPOCH_MS, simRate: 1 }), research: { completedNodes: [] }, receipts: [] }, players: { [ctx.me]: player } };
}

/** Hold T through the spool, then poll until idle (logs every 10 s for the watchdog). */
async function flyHeld(d, ctx, maxS = 200) {
  await d.hold("t", 3600);
  const t0 = Date.now();
  let st = await ctx.ev(`${TR}.state()`);
  let lastLog = 0;
  while (st.phase !== "idle" && Date.now() - t0 < maxS * 1000) {
    await ctx.wait(400);
    st = await ctx.ev(`${TR}.state()`);
    if (Date.now() - lastLog > 10000) {
      lastLog = Date.now();
      log("flying", st.phase, `leg ${st.legIndex + 1}/${st.legCount}`, Math.round(st.distKm ?? 0), "km");
    }
  }
  return st;
}

export async function hudTransitGates(d, ctx) {
  const { ev } = ctx;
  const id = await ctx.fixture("hud-transit", transitWorld(ctx));
  await ctx.boot(id);
  await d.frames(60);
  // A point on Luna's far side: the straight line crosses Luna, so the route has two legs.
  const s = await d.state();
  const luna = (await ev(`${TR}.bodies(["luna"])`)).luna.posKm;
  const r = s.ship.posKm.map((x, i) => x - luna[i]);
  const k = -2600 / Math.hypot(...r);
  await ev(`${TR}.targetProbe("luna", ${JSON.stringify(r.map((x) => x * k))})`);
  await d.frames(30);
  await ctx.wait(800);
  const pre = await ev(`${TR}.preview()`);
  await ev(`(() => { window.__wp3G = []; window.__wp3GT = setInterval(() => {
    const e = document.querySelector(".transit-hud--side");
    const r = e && e.getBoundingClientRect();
    window.__wp3G.push(r ? [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10, e.classList.contains("transit-hud--active") ? "active" : "plan", ${TR}.state().phase] : [0, 0, "none", ${TR}.state().phase]);
  }, 60); })()`);
  await ctx.wait(1000);
  const shotPlan = await d.shot("wp3-transit-plan-2leg");
  const st = await flyHeld(d, ctx);
  await ctx.wait(600);
  const g = await ev(`(() => { clearInterval(window.__wp3GT); return window.__wp3G; })()`);
  const shown = g.filter((x) => x[2] !== "none");
  const widths = [...new Set(shown.map((x) => x[0]))];
  let heightChanges = 0, heightChangesWithoutState = 0;
  for (let i = 1; i < shown.length; i++) {
    if (shown[i][1] !== shown[i - 1][1]) {
      heightChanges++;
      if (shown[i][2] === shown[i - 1][2]) heightChangesWithoutState++;
    }
  }
  const heights = Object.fromEntries(["plan", "active"].map((k) => [k, [...new Set(shown.filter((x) => x[2] === k).map((x) => x[1]))]]));
  const phases = [...new Set(g.map((x) => x[3]))];
  return {
    preview: { ok: pre?.ok, legs: pre?.legCount, via: pre?.viaName }, samples: g.length, shownSamples: shown.length, widths, heights, heightChanges, heightChangesWithoutState, phases,
    arrived: st.phase === "idle", shotPlan,
    pass: pre?.ok && pre?.legCount === 2 && shown.length > 100 && widths.length === 1 && heightChangesWithoutState === 0 && heights.plan.length <= 1 && heights.active.length === 1,
  };
}

// ── hudSite: real keys from a transit arrival ──
export async function hudSiteGates(d, ctx) {
  const { ev, world, player } = ctx;
  const id = await ctx.fixture("hud-site", transitWorld(ctx));
  await ctx.boot(id);
  await d.frames(60);
  const lock = async (poiId, absExpr) => {
    for (let i = 0; i < 40; i++) {
      await ev(`${G}.res.face(${absExpr})`);
      await d.frames(10);
      if ((await ev(`${TR}.state()`)).targeted === poiId) return true;
    }
    return false;
  };
  const out = {};
  out.lockLuna = await lock("body:luna", `${R}.abs("luna", [0, 0, 0])`);
  log("to the lunar field");
  const a = await flyHeld(d, ctx);
  out.arrival1 = { phase: a.phase, frame: (await d.state()).ship.frameId };
  await ctx.wait(1500);
  out.lockSite = await lock(`site:${SITE}`, `${M}.site.absKm(${JSON.stringify(SITE)})`);
  log("to the site", out.lockSite);
  const b = await flyHeld(d, ctx);
  await ctx.wait(800);
  const nav = await ev(`${G}.res.nav(${M}.site.absKm(${JSON.stringify(SITE)}))`);
  out.arrival2 = { phase: b.phase, distKm: Math.round(nav.distKm * 1000) / 1000 };
  out.focused = await waitFor(ctx, async () => (await faceSite(ctx), (await focusKind(ctx)) === "site"), 6000);
  out.before = await state(d, ctx, "site-arrival", "site", false);
  const ti0 = (await player()).cargo.items.titanium ?? 0;
  await ev(`(() => { window.__wp3Rej = 0; window.__wp3RT = setInterval(() => { for (const v of (__audio.voices() ?? [])) if ((v.eventId ?? v.event ?? v.id) === "ui.reject") window.__wp3Rej++; }, 100); })()`);
  await d.press("g");
  await ctx.wait(500);
  const scanning = (await ev(`${M}.site.focus()`)).scanning;
  out.during = await state(d, ctx, "site-recovering", "site", false);
  const recovered = await waitFor(ctx, async () => !!(await world()).discoveries.sites[SITE], 9000);
  const rejects = await ev(`(() => { clearInterval(window.__wp3RT); return window.__wp3Rej; })()`);
  const ti1 = (await player()).cargo.items.titanium ?? 0;
  await ctx.wait(500);
  out.after = await state(d, ctx, "site-recovered", undefined, false);
  out.recover = { scanning, recovered, rejects, titanium: [ti0, ti1], pass: scanning && recovered && rejects === 0 && ti1 - ti0 === 30 };
  out.pass = out.lockLuna && out.lockSite && out.focused && out.arrival2.distKm <= 2 && out.recover.pass && out.after.stack.some((s) => s.startsWith("Canister recovered"));
  return out;
}

// ── lunarShots: what the player sees at the field arrival point and at the canister (lighting check) ──
export async function lunarShotGates(d, ctx) {
  const { ev } = ctx;
  const sfx = process.env.GAME_SHOT_NARROW ? "-390" : "";
  const id = await ctx.fixture("lunar-shots", transitWorld(ctx));
  await ctx.boot(id);
  await d.frames(60);
  for (let i = 0; i < 40 && (await ev(`${TR}.state()`)).targeted !== "body:luna"; i++) {
    await ev(`${G}.res.face(${R}.abs("luna", [0, 0, 0]))`);
    await d.frames(10);
  }
  log("to the lunar field");
  await flyHeld(d, ctx);
  await ctx.wait(2000);
  const out = { shots: {} };
  const look = async (name, faceExpr) => {
    await ev(`${G}.res.face(${faceExpr})`);
    await ctx.wait(1500);
    out.shots[name] = await d.shot(`lunar-${name}${sfx}`);
  };
  // Phase angle at Luna (sun–Luna–ship), deg: 0 = full, 90 = half lit as seen from here.
  const b = await ev(`${TR}.bodies(["sol", "luna"])`);
  const ship = (await d.state()).ship.posKm;
  const u = b.sol.posKm.map((x, i) => x - b.luna.posKm[i]);
  const v = ship.map((x, i) => x - b.luna.posKm[i]);
  const dot = u.reduce((a, x, i) => a + x * v[i], 0);
  out.lunaPhaseDeg = Math.round((Math.acos(dot / Math.hypot(...u) / Math.hypot(...v)) * 180) / Math.PI);
  out.lunaDistKm = Math.round(Math.hypot(...v));
  await look("luna", `${R}.abs("luna", [0, 0, 0])`);
  const rocks = (await ev(`${G}.m33.rocks(40)`)).sort((a, b) => b.radiusM / b.distKm - a.radiusM / a.distKm);
  out.rock = rocks[0] ? { distKm: rocks[0].distKm, radiusM: rocks[0].radiusM } : null;
  if (rocks[0]) await look("rocks", JSON.stringify({ fieldId: rocks[0].fieldId, chunkKey: rocks[0].chunkKey, instanceId: rocks[0].instanceId }));
  for (let i = 0; i < 40 && (await ev(`${TR}.state()`)).targeted !== `site:${SITE}`; i++) {
    await faceSite(ctx);
    await d.frames(10);
  }
  log("to the site");
  await flyHeld(d, ctx);
  await ctx.wait(1500);
  out.siteDistKm = (await ev(`${G}.res.nav(${M}.site.absKm(${JSON.stringify(SITE)}))`)).distKm;
  await look("canister", `${M}.site.absKm(${JSON.stringify(SITE)})`);
  out.pass = !!out.rock && out.siteDistKm < 2;
  return out;
}

// ── hudKeys: v2 → v3 migration ──
export async function hudKeysGates(d, ctx) {
  const { ev } = ctx;
  const saved = await ev(`({ v2: localStorage.getItem("keybinds-v2"), v3: localStorage.getItem("keybinds-v3") })`);
  const v2Defaults = {
    pitchUp: ["arrowup"], pitchDown: ["arrowdown"], yawLeft: ["arrowleft"], yawRight: ["arrowright"], rollLeft: ["q"], rollRight: ["e"], strafeLeft: ["a"], strafeRight: ["d"], strafeUp: [" "], strafeDown: ["control"],
    accelerate: ["w"], decelerate: ["s"], boost: ["shift"], brake: ["x"], toggleFlightAssist: ["v"], freeLook: ["alt"], toggleCargo: ["tab", "i"], toggleResearch: ["r"], toggleCrafting: ["f"], toggleLoadout: ["l"],
    toggleProjects: ["o"], mine: ["m"], inspect: ["g"], togglePulseMining: ["p"], transitDrive: ["t"], placePoint: ["b"], activatePoint: ["h"], toggleSettings: ["escape"],
  };
  const run = async (v2) => {
    await ev(`(() => { localStorage.removeItem("keybinds-v3"); localStorage.setItem("keybinds-v2", ${JSON.stringify(JSON.stringify(v2))}); })()`);
    await d.reload();
    await d.frames(10);
    return ev(`JSON.parse(localStorage.getItem("keybinds-v3") ?? "null")`);
  };
  const out = {};
  const a = await run(v2Defaults);
  out.defaults = { crafting: a?.toggleCrafting, projects: a?.toggleProjects, pulse: a?.togglePulseMining, place: a?.placePoint, activate: a?.activatePoint ?? null,
    pass: !!a && a.toggleCrafting.join() === "c" && a.toggleProjects.join() === "p" && a.togglePulseMining.length === 0 && a.placePoint.length === 0 && !("activatePoint" in a) };
  const b = await run({ ...v2Defaults, toggleCrafting: ["k"], togglePulseMining: ["n"], placePoint: ["j"] });
  out.custom = { crafting: b?.toggleCrafting, projects: b?.toggleProjects, pulse: b?.togglePulseMining, place: b?.placePoint,
    pass: !!b && b.toggleCrafting.join() === "k" && b.toggleProjects.join() === "p" && b.togglePulseMining.join() === "n" && b.placePoint.join() === "j" };
  const c = await run({ ...v2Defaults, brake: ["c"] });
  out.taken = { crafting: c?.toggleCrafting, brake: c?.brake, pass: !!c && c.toggleCrafting.length === 0 && c.brake.join() === "c" };
  // Restore the profile's own bindings.
  await ev(`(() => { const s = ${JSON.stringify(saved)}; for (const [k, v] of [["keybinds-v2", s.v2], ["keybinds-v3", s.v3]]) v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); })()`);
  await d.reload();
  await d.frames(10);
  return { ...out, pass: out.defaults.pass && out.custom.pass && out.taken.pass };
}

// ── hudHotbar ──
export async function hudHotbarGates(d, ctx) {
  const { ev, me, player, world } = ctx;
  const hotbar = [PATCH, null, null, null, null, null, null, null, null, SINK];
  const data = await ev(`(() => {
    const a = ${G}.parse(${JSON.stringify(ctx.v1({ [me]: ctx.v1Player({ aiName: "Vega", commsPlayed: ["opening_001", "opening_002"] }) }))});
    const p = a.players[${JSON.stringify(me)}];
    p.health = 70;
    p.modules.consumables = { ${PATCH}: 3, ${SINK}: 2 };
    p.modules.hotbar = ${JSON.stringify(hotbar)};
    return a;
  })()`);
  const id = await ctx.fixture("hud-hotbar", data);
  await ctx.boot(id);
  await d.frames(60);
  const out = {};
  const c0 = (await player()).modules.consumables;
  await d.press("1");
  await d.frames(10);
  const c1 = (await player()).modules.consumables;
  out.key1 = { patch: [c0[PATCH], c1[PATCH]], pass: c1[PATCH] === c0[PATCH] - 1 };
  await ev(`${G}.res.set({ heat01: 0.6 })`);
  await d.frames(5);
  await d.press("0");
  await d.frames(10);
  const c2 = (await player()).modules.consumables;
  out.key0 = { sink: [c0[SINK], c2[SINK]], pass: c2[SINK] === c0[SINK] - 1 };
  const labels = await ev(`[...document.querySelectorAll(".hotbar__key")].map((e) => e.textContent).join("")`);
  out.labels = { labels, pass: labels === "1234567890" };
  for (const [r, n] of Object.entries({ fe_ni_metal: 150, silicates: 100 })) await ev(`__dev.grantCargo(${JSON.stringify(r)}, ${n})`);
  await ev(`${G}.craft(${JSON.stringify(KIT)})`);
  await d.frames(10);
  const kitSlot = (await player()).modules.hotbar.indexOf(KIT);
  out.kitSlotted = { kitSlot, pass: kitSlot === 1 };
  await findClearPreview(d, ctx);
  await ev(`${R}.setMode(false)`);
  await d.frames(10);
  await d.press(slotKey(kitSlot));
  await d.frames(10);
  await ev('document.querySelector(".target-card__input")?.focus()');
  const input = await ev(`(() => { const i = document.activeElement; return i && i.classList.contains("target-card__input") ? { value: i.value, all: i.selectionStart === 0 && i.selectionEnd === i.value.length } : null; })()`);
  // A digit typed into the name must not press the kit's own slot key.
  await d.type(`Camp ${slotKey(kitSlot)}`);
  await d.frames(5);
  const stillPlacing = await ev(`document.querySelector(".target-card")?.dataset.kind === "place"`);
  await d.press("Enter");
  await d.frames(20);
  const point = (await world()).replication.points.find((p) => p.name === `Camp ${slotKey(kitSlot)}`);
  out.place = { input, stillPlacing, point: point?.name ?? null, pass: !!input?.all && stillPlacing && !!point };
  // Esc while placing cancels placement only.
  await ev(`__dev.grantCargo("fe_ni_metal", 150)`);
  await ev(`__dev.grantCargo("silicates", 100)`);
  await ev(`${G}.craft(${JSON.stringify(KIT)})`);
  await d.frames(10);
  await d.press(slotKey((await player()).modules.hotbar.indexOf(KIT)));
  await d.frames(10);
  const opened = await ev(`document.querySelector(".target-card")?.dataset.kind === "place"`);
  await d.press("Escape");
  await d.frames(10);
  const esc = await ev(`({ placing: document.querySelector(".target-card")?.dataset.kind === "place", settings: !!document.querySelector(".settings-menu__button") })`);
  out.esc = { opened, ...esc, pass: opened && !esc.placing && !esc.settings };
  // "Clear slot" on the kit sticks (no auto re-add); a kit crafted onto a full bar says so.
  const clearSlot = async (i) => {
    await ev(`(() => { const el = document.querySelectorAll(".hotbar__slot")[${i}]; const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 })); })()`);
    await d.frames(5);
    await ev(`[...document.querySelectorAll(".context-menu__item")].find((e) => e.textContent.includes("Clear slot"))?.click()`);
    await d.frames(10);
  };
  await clearSlot((await player()).modules.hotbar.indexOf(KIT));
  await d.frames(30);
  const afterClear = (await player()).modules.hotbar.indexOf(KIT);
  out.kitClear = { afterClear, pass: afterClear === -1 };

  // A full bar: the crafted kit gets no slot and the stack says "Hotbar full".
  const full = await ev(`(() => {
    const a = ${G}.parse(${JSON.stringify(ctx.v1({ [me]: ctx.v1Player({ aiName: "Vega", commsPlayed: ["opening_001", "opening_002"] }) }))});
    const p = a.players[${JSON.stringify(me)}];
    p.modules.consumables = { ${PATCH}: 3, ${SINK}: 2 };
    p.modules.hotbar = ${JSON.stringify(Array.from({ length: 10 }, (_, i) => (i % 2 ? SINK : PATCH)))};
    return a;
  })()`);
  await ctx.boot(await ctx.fixture("hud-hotbar-full", full));
  await d.frames(60);
  const barBefore = (await player()).modules.hotbar;
  for (const [r, n] of Object.entries({ fe_ni_metal: 150, silicates: 100 })) await ev(`__dev.grantCargo(${JSON.stringify(r)}, ${n})`);
  await ev(`${G}.craft(${JSON.stringify(KIT)})`);
  await d.frames(20);
  const pf = await player();
  const stack = await ev(`[...document.querySelectorAll(".notif-stack__item")].map((e) => e.innerText.replace(/\s+/g, " ").trim())`);
  out.kitFull = { filled: barBefore.filter(Boolean).length, kits: pf.modules.consumables[KIT] ?? 0, slotted: pf.modules.hotbar.includes(KIT), stack,
    pass: barBefore.every(Boolean) && (pf.modules.consumables[KIT] ?? 0) === 1 && !pf.modules.hotbar.includes(KIT) && stack.some((x) => x.startsWith("Hotbar full")) };
  return { ...out, pass: Object.values(out).every((x) => x.pass) };
}
