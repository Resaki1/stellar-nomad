/**
 * Pace gate (playtest 1, WP2; part of gameplay-check.mjs, needs --no-isolate):
 *   GAME_PARTS=pace   a competent player's first trip, fresh Standard world → drive → lunar field.
 * Real input for every flight hop (W/X), every extraction (the live laser on a focused rock) and
 * the transit (T held); evidence-aware rock choice (class known at lock), surplus jettisoned when
 * the hold fills. Harness-instant actions are charged a fixed modelled time (MODEL below).
 * Resumable: each run works ~90 s of wall time and saves to .captures/pace.json; rerun until
 * `done: true` (delete the file to start over). Reports minutes to pr1, the drive and arrival
 * against docs §13 WP2 / spec §5.5: the bot's minutes are an expert LOWER BOUND (25-50) and the
 * derived new-player estimate must land in the owner's 60-90 min (see paceSummary).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const G = "__test.gameplay";
const STATE_FILE = process.env.PACE_STATE ?? ".captures/pace.json";
/** Optional cap on a chosen rock's extraction time (PACE_MAX_MINE_S=13 keeps to the spec model's mid-size rocks). */
const MAX_MINE_S = Number(process.env.PACE_MAX_MINE_S ?? Infinity);
const BUDGET_MS = 100_000;
/** Seconds charged for actions the harness does instantly (a competent player's time). */
const MODEL = { opening: 120, inspect: 6, menu: 12, jettison: 5 };
/** Material per task (spec §5.2 / §5.5 expert line). */
const TASKS = [
  { id: "sv1", kind: "unlock", node: "sv1_composition_survey", need: { silicates: 20 } },
  { id: "sink", kind: "craft", item: "consumable_heat_sink_cartridge", need: { silicates: 20, fe_ni_metal: 5 } },
  { id: "batch", kind: "batch", need: { hydrates: 1 } },
  { id: "th1", kind: "unlock", node: "th1_heat_rejection", need: { silicates: 30 } },
  { id: "lg1", kind: "unlock", node: "lg1_bulk_handling", need: { fe_ni_metal: 30 } },
  { id: "radiator", kind: "craft", item: "module_radiator_strips_mk1", need: { silicates: 140, fe_ni_metal: 40 } },
  { id: "rack", kind: "craft", item: "module_cargo_rack_mk1", need: { silicates: 50, fe_ni_metal: 150 } },
  { id: "pr1", kind: "unlock", node: "pr1_transit_calibration", need: { hydrates: 15, fe_ni_metal: 40 } },
  { id: "drive", kind: "craft", item: "special_transit_drive", need: { silicates: 600, fe_ni_metal: 550, hydrates: 30, carbon: 20, sulfur: 12 } },
  // Playtest 2: Earth -> Moon needs more than the base 600 kg tank. The rack stays fitted while hauling drive material.
  // Crafted after the drive (the tracker's order): an earlier craft auto-fits it and blocks the rack.
  { id: "tank", kind: "craft", item: "module_aux_tank_mk1", after: "drive", need: { fe_ni_metal: 120, silicates: 40 } },
  { id: "tankEquip", kind: "equip", item: "module_aux_tank_mk1", slot: "cargo", after: "drive", need: {} },
];
/** The tracker's "Fuel for Earth to Moon" step (projects.ts). */
const FUEL_GOAL_KG = 900;
/** Below this the bot refuels from any hydrates aboard (to the refill level), like a player told "Fuel low". */
const LOW_FUEL_KG = 80;
const LOW_FUEL_REFILL_KG = 160;
const r1 = (x) => Math.round(x * 10) / 10;
const sum = (o) => Object.values(o ?? {}).reduce((a, v) => a + v, 0);
const log = (...a) => console.log("[pace]", ...a);

const load = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : null);
const save = (s) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));

export async function paceGates(d, ctx) {
  const { ev } = ctx;
  const wall0 = Date.now();
  let st = load();
  if (!st) {
    const id = await ev(`${G}.fixtures.create("pace", ${JSON.stringify({ schemaVersion: 5, world: {}, players: { [ctx.me]: {} } })})`);
    st = { id, maxMineS: Number.isFinite(MAX_MINE_S) ? MAX_MINE_S : null, clock: { realS: 0, simS: 0, modelS: MODEL.opening }, done: {}, used: [], milestones: {}, rocks: 0, inspections: 0, menus: 0, jettisons: 0, deaths: 0, overflowUnits: 0, flyKg: 0, runs: 0, log: [] };
  }
  st.runs++;
  await ctx.boot(st.id);
  if (st.runs === 1) {
    await ev(`${G}.m37.comms.nameAi("Vega")`);
    await ev(`${G}.m37.comms.dismiss()`);
  }
  await d.frames(30);
  await ctx.wait(1500);
  const used = new Set(st.used);
  const simNow = async () => (await ev("__test.state()")).simEpochMs;
  const clockMin = () => r1((st.clock.realS + st.clock.modelS) / 60);
  /** Time a real-input segment: wall and sim seconds both go into the ledger. */
  const real = async (fn) => {
    const s0 = await simNow();
    const w0 = Date.now();
    const out = await fn();
    st.clock.realS += (Date.now() - w0) / 1000;
    st.clock.simS += ((await simNow()) - s0) / 1000;
    return out;
  };
  const charge = (k, n = 1) => (st.clock.modelS += MODEL[k] * n);
  const mark = (name) => {
    if (!st.milestones[name]) st.milestones[name] = { min: clockMin(), simMin: r1((st.clock.simS + st.clock.modelS) / 60), rocks: st.rocks };
    log("milestone", name, JSON.stringify(st.milestones[name]));
  };

  const remainingNeed = async () => {
    const need = {};
    for (const t of TASKS) if (!st.done[t.id]) for (const [k, n] of Object.entries(t.need)) need[k] = (need[k] ?? 0) + n;
    const r = await ev(`${G}.res.state()`);
    const fuelUnits = Math.max(0, Math.ceil((FUEL_GOAL_KG + 40 - r.ordinaryKg) / 20));
    need.hydrates = (need.hydrates ?? 0) + fuelUnits;
    return need;
  };

  /** Execute every task that is affordable now (in order), plus fuel processing with spare hydrates. */
  const doTasks = async () => {
    for (const t of TASKS) {
      if (st.done[t.id] || (t.after && !st.done[t.after]) || (t.kind === "equip" && !st.done.tank)) continue;
      const p = await ctx.player();
      if (Object.entries(t.need).some(([k, n]) => (p.cargo.items[k] ?? 0) < n)) continue;
      let o = null;
      if (t.kind === "unlock") o = await ev(`${G}.m33.unlock(${JSON.stringify(t.node)})`);
      else if (t.kind === "craft") o = await ev(`${G}.craft(${JSON.stringify(t.item)})`);
      else if (t.kind === "equip") o = await ev(`${G}.m33.equipOp(${JSON.stringify(t.item)}, ${JSON.stringify(t.slot)})`);
      else if (t.kind === "batch") {
        if ((await ev(`${G}.res.state()`)).processing?.active) continue;
        o = await ev(`${G}.res.startProcessing(${Math.min(5, p.cargo.items.hydrates ?? 0)})`);
      }
      if (o?.status === "accepted") {
        charge("menu");
        st.menus++;
        st.done[t.id] = true;
        st.log.push({ t: clockMin(), task: t.id });
        log(clockMin(), "min", t.id);
        if (t.id === "pr1") mark("pr1Unlocked");
        if (t.id === "drive") mark("driveCrafted");
        if (t.id === "tankEquip") mark("tankEquipped");
      } else if (o && o.reason !== "evidence") st.log.push({ t: clockMin(), task: t.id, refused: o.reason, missing: o.missing });
    }
    // Spare hydrates beyond the remaining recipes go into the tank.
    const r = await ev(`${G}.res.state()`);
    if (!r.processing?.active && st.done.batch) {
      const p = await ctx.player();
      // A low tank comes first (the player gets "Fuel low"): recipe hydrates are mined again later.
      const low = r.ordinaryKg < LOW_FUEL_KG;
      const keep = low ? 0 : TASKS.filter((t) => !st.done[t.id]).reduce((a, t) => a + (t.need.hydrates ?? 0), 0);
      const tank = (await ev(`${G}.m33.liveTuning()`)).tankKg;
      const room = Math.floor(((low ? Math.min(tank, LOW_FUEL_REFILL_KG) : tank) - r.ordinaryKg) / 20);
      const units = Math.min(50, (p.cargo.items.hydrates ?? 0) - keep, room);
      if (units >= (low ? 1 : 3)) {
        const o = await ev(`${G}.res.startProcessing(${units})`);
        if (o?.status === "accepted") {
          charge("menu");
          st.menus++;
        }
      }
    }
  };

  const evidenceWanted = async () => {
    const w = await ctx.world();
    const classes = new Set((w.discoveries.sources ?? []).map((s) => s.classId));
    return { classes: ["s_type", "c_type", "x_type"].filter((c) => !classes.has(c)), beam: !w.discoveries.trials.sustained_beam };
  };

  /** Choose the next rock: evidence first, then the best useful-units-per-second among nearby rocks. */
  const pick = async (need, have, ev0) => {
    const rocks = await ev(`${G}.m33.rocks(400)`);
    // "Fuel low" with no hydrates aboard: a player goes for the nearest hydrate rock first.
    if ((await ev(`${G}.res.state()`)).ordinaryKg < LOW_FUEL_KG && (have.hydrates ?? 0) < 4) need = { hydrates: 40 };
    const radiator = (await ctx.player()).modules.equippedModules.cooling === "module_radiator_strips_mk1";
    const maxMine = Math.min(MAX_MINE_S, radiator ? 18.5 : 13);
    let best = null;
    for (const r of rocks) {
      if (used.has(r.instanceId) || r.mineS > maxMine || r.distKm > 35 || r.radiusM < 15) continue;
      let useful = 0;
      for (const [k, n] of Object.entries(need)) useful += Math.min(r.composition[k] ?? 0, Math.max(0, n - (have[k] ?? 0)));
      const hopS = 10 + (r.distKm * 1000) / 220;
      let score = useful / (hopS + r.mineS);
      if (ev0.classes.includes(r.classId)) score *= 3;
      if (ev0.beam && r.mineS >= 8.6 && r.mineS <= 12.5) score *= 2;
      if (!best || score > best.score) best = { r, score, useful };
    }
    return best;
  };

  /** Real input: fly to within reach of the rock and stop (W / X holds, nose on the rock). */
  const flyRock = async (rock, maxS = 75) => {
    const stopKm = rock.radiusM / 1000 + 0.3;
    const t0 = Date.now();
    let nav = null;
    while (Date.now() - t0 < maxS * 1000) {
      await ev(`${G}.res.face(${JSON.stringify(rock)})`);
      nav = await ev(`${G}.res.nav(${JSON.stringify(rock)})`);
      if (!nav) return { ok: false, nav };
      if (nav.distKm <= stopKm && nav.speedMps < 5) return { ok: true, nav };
      const brakeKm = (nav.speedMps * nav.speedMps) / (2 * 60) / 1000 + 0.15;
      if (nav.distKm - stopKm <= brakeKm && nav.speedMps > 3) await d.hold("x", 200);
      else if (nav.distKm > stopKm && nav.speedMps < 400) await d.hold("w", 200);
      else if (nav.distKm > stopKm) await ctx.wait(200);
      else await d.hold("x", 200);
    }
    return { ok: false, nav };
  };

  /** Real input: focus and run the laser until the rock is extracted. */
  const mineLive = async (rock) => {
    const p0 = await ctx.player();
    await ev(`${G}.res.face(${JSON.stringify(rock)})`);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !(await ev(`${G}.res.mining()`)).focused) await ctx.wait(150);
    // Cool down first if this rock would trip the laser (a player waits, the clock runs).
    for (let i = 0; i < 60 && (await ev(`${G}.res.state()`)).heat01 > 0.35; i++) await ctx.wait(500);
    await ev(`${G}.res.startMining()`);
    const t1 = Date.now();
    while (Date.now() - t1 < (rock.mineS + 8) * 1000) {
      await ctx.wait(250);
      if ((await ctx.player()).minedLifetime > p0.minedLifetime) return true;
      const m = await ev(`${G}.res.mining()`);
      if (!m.mining && Date.now() - t1 > 1500) {
        if ((await ctx.player()).minedLifetime > p0.minedLifetime) return true;
        await ev(`${G}.res.face(${JSON.stringify(rock)})`);
        if (m.overheated) await ctx.wait(1000);
        else await ev(`${G}.res.startMining()`);
      }
    }
    return (await ctx.player()).minedLifetime > p0.minedLifetime;
  };

  let phase = "gather";
  while (Date.now() - wall0 < BUDGET_MS) {
    const p = await ctx.player();
    if (p.isDead) {
      st.deaths++;
      await real(async () => {
        await ev(`${G}.rep.recover("active")`);
        await ctx.wait(1500);
      });
      continue;
    }
    // Stranded (both fuels spent): the dashboard reads "No fuel · Esc › Respawn".
    const r0 = await ev(`${G}.res.state()`);
    if (r0.ordinaryKg + r0.protectedKg < 0.5) {
      st.deaths++;
      st.log.push({ t: clockMin(), respawn: "no fuel" });
      charge("menu");
      await real(async () => {
        await ev(`${G}.res.abandon()`);
        await ctx.wait(1000);
        await ev(`${G}.rep.recover("active")`);
        await ctx.wait(1500);
      });
      continue;
    }
    if (st.done.drive && st.done.tankEquip) {
      phase = "fuel";
      const r = await ev(`${G}.res.state()`);
      if (r.ordinaryKg >= FUEL_GOAL_KG && !r.processing?.active) {
        phase = "transit";
        break;
      }
      if (r.processing?.active) {
        await real(() => ctx.wait(1000));
        continue;
      }
    }
    await doTasks();
    const need = await remainingNeed();
    const have = (await ctx.player()).cargo.items;
    if (Object.entries(need).every(([k, n]) => (have[k] ?? 0) >= n)) {
      await doTasks();
      if (st.done.drive) continue;
    }
    const ev0 = await evidenceWanted();
    const choice = await pick(need, have, ev0);
    if (!choice) {
      st.log.push({ t: clockMin(), noRock: true });
      await real(async () => {
        await d.hold("w", 2000);
        await d.hold("x", 2500);
      });
      continue;
    }
    const rock = choice.r;
    const estS = 15 + (rock.distKm * 1000) / 350 + rock.mineS;
    if (Date.now() - wall0 + estS * 1000 > 150_000) break;
    used.add(rock.instanceId);
    const fuel0 = (await ev(`${G}.res.state()`)).ordinaryKg;
    const fly = await real(() => flyRock(rock, 30 + (rock.distKm * 1000) / 250));
    if (!fly.ok) {
      st.log.push({ t: clockMin(), unreached: rock.instanceId, distKm: r1(fly.nav?.distKm ?? -1), speedMps: r1(fly.nav?.speedMps ?? -1), startKm: r1(rock.distKm) });
      continue;
    }
    // Inspect the first rock of each missing class, or a hydrate/metal rock the evidence needs.
    if (ev0.classes.includes(rock.classId)) {
      const o = await ev(`${G}.m33.inspect(${JSON.stringify(rock)})`);
      if (o?.status === "accepted") {
        charge("inspect");
        st.inspections++;
      }
    }
    // Make room: by-products beyond the remaining need go overboard.
    const cap = await ev(`${G}.mirrors().cargoCapacity`);
    const items = (await ctx.player()).cargo.items;
    if (cap - sum(items) < sum(rock.composition)) {
      for (const [k, n] of Object.entries(items)) {
        const extra = n - (need[k] ?? 0);
        if (extra > 0) await ev(`${G}.jettison(${JSON.stringify(k)}, ${extra})`);
      }
      charge("jettison");
      st.jettisons++;
    }
    const mined = await real(() => mineLive(rock));
    st.flyKg += Math.max(0, fuel0 - (await ev(`${G}.res.state()`)).ordinaryKg);
    if (mined) st.rocks++;
    else st.log.push({ t: clockMin(), notMined: rock.instanceId, mineS: rock.mineS });
    log(clockMin(), "min", mined ? "mined" : "MISS", rock.classId, `${Math.round(rock.radiusM)} m`, `${r1(rock.mineS)} s`, `${r1(rock.distKm)} km`, "rocks", st.rocks);
  }

  // Transit only at the start of a run (the trip can take ~60 s of wall time).
  if (phase === "transit" && !st.milestones.arrived && Date.now() - wall0 < 25_000) {
    await ev(`${G}.m33.targetBody("luna")`);
    await d.frames(10);
    const pv = await ev(`${G}.transit.preview()`);
    st.transit = pv && { ok: pv.ok, reason: pv.reason, etaS: r1(pv.etaS), fuelKg: r1(pv.fuelKg), legs: pv.legCount };
    if (pv?.ok) {
      const fuel0 = (await ev(`${G}.res.state()`)).ordinaryKg;
      const arrived = await real(async () => {
        await d.hold("t", 3400);
        const t0 = Date.now();
        while (Date.now() - t0 < 110_000) {
          await ctx.wait(400);
          const t = await ev(`${G}.transit.state()`);
          if (t.phase === "idle" && t.legIndex >= t.legCount - 1 && t.ev.arrived >= 1) return true;
        }
        return false;
      });
      const s = await ev("__test.state()");
      st.transit.usedKg = r1(fuel0 - (await ev(`${G}.res.state()`)).ordinaryKg);
      st.transit.frame = s.ship.frameId;
      if (arrived && s.ship.frameId === "luna") mark("arrived");
    }
  } else if (phase === "transit") log("transit next run");

  st.used = Array.from(used);
  save(st);
  return paceSummary(st, ctx.created);
}

/**
 * The run's result (pure: also scores a saved state file offline). The bot's minutes are an EXPERT
 * LOWER BOUND (no wandering, misses, overheat deaths). The new-player estimate is spec §5.5's line:
 * real minutes ×1.4 plus its new-player overheads (inspect 1.5, cool-down 3, menus 6, opening 8),
 * compared with the owner's 60-90 min.
 */
export function paceSummary(st, created = []) {
  const done = !!st.milestones.arrived;
  const steps = st.log.filter((x) => x.task).map((x, i, a) => ({ task: x.task, min: x.t, dMin: r1(x.t - (i ? a[i - 1].t : MODEL.opening / 60)) }));
  const res = {
    run: st.runs, done, clockMin: r1((st.clock.realS + st.clock.modelS) / 60), simMin: r1((st.clock.simS + st.clock.modelS) / 60), realMin: r1(st.clock.realS / 60), modelMin: r1(st.clock.modelS / 60),
    milestones: st.milestones, steps, rocks: st.rocks, inspections: st.inspections, menus: st.menus, jettisons: st.jettisons, deaths: st.deaths, flyKg: r1(st.flyKg),
    tasks: Object.keys(st.done), transit: st.transit ?? null, issues: st.log.filter((x) => !x.task).slice(-8),
  };
  if (done) {
    created.push(st.id);
    const expert = st.milestones.arrived.min;
    const newPlayer = r1(1.4 * (st.clock.realS / 60) + 1.5 + 3 + 6 + 8);
    res.verdict = { expertLowerBoundMin: expert, expertBand: [25, 50], newPlayerEstMin: newPlayer, ownerBand: [60, 90], maxMineS: st.maxMineS ?? null };
    res.pass = expert >= 25 && expert <= 50 && newPlayer >= 60 && newPlayer <= 90;
  }
  return res;
}
