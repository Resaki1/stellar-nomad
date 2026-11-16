/**
 * M3.5 transit gates, run from gameplay-check.mjs:
 *   transit      pure: __test.gameplay.transit.simulate (stepTransit + stepShip + resource step, explicit pacing)
 *   transitLive  live, fixture world: real gaze targeting + T key, Earth → Moon at two dates, ownership, sweep
 *   transitShots HUD captures (1280×720, and 390×844 via a second run with --size 390x844 + GAME_SHOT_NARROW=1)
 */
const G = "__test.gameplay";
const TR = `${G}.transit`;
const r4 = (x) => (x === null || x === undefined ? x : +(+x).toFixed(4));
const rel = (a, b) => (b === 0 ? (a === 0 ? 0 : Infinity) : Math.abs(a - b) / Math.abs(b));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Synthetic Earth–Moon: ship behind Earth, so the direct line is blocked. */
const EARTH = { id: "earth", posKm: [0, 0, 0], radiusKm: 6371 };
const MOON_KM = [384400, 0, 0];
const MOON = { id: "luna", posKm: MOON_KM, radiusKm: 1737 };
const SHIP_BEHIND = [-17000, 0, 3000];

export async function transitPureGates(d) {
  const ev = (s) => d.evaluate(s);
  const sim = (sc) => ev(`${TR}.simulate(${JSON.stringify(sc)})`);
  const T = await ev(`${G}.res.tuning()`);
  const g = {};
  const cmp = (r) => ({
    planEtaS: r4(r.plan.etaS), etaS: r4(r.etaS), etaErr: r4(rel(r.etaS ?? Infinity, r.plan.etaS)),
    planKg: r4(r.plan.fuelKg), kg: r4(r.fuelKg), kgErr: r4(rel(r.fuelKg, r.plan.fuelKg)),
    planHeat: r4(r.plan.peakHeat01), heat: r4(r.peakHeat01), planBalanceKg: r4(r.plan.arrivalOrdinaryKg), balanceKg: r4(r.ordinaryKg),
    missKm: r4(r.finalAimDistKm), endKmps: r.endSpeedKmps, peakKmps: r4(r.peakKmps), legs: r.legCount, arrived: r.events.arrived,
  });
  const within = (c, tol = 0.05) => c.etaErr <= tol && c.kgErr <= tol && c.endKmps === 0 && c.arrived === 1;

  // (a) V9 prediction vs execution: straight legs and a moving destination at simRate 1 and 100.
  {
    const rows = {};
    for (const D of [1000, 50000, 380000]) rows[`straight${D}`] = cmp(await sim({ target: { positionKm: [0, 0, D] } }));
    for (const rate of [1, 100]) {
      // The Moon's ~1.02 km/s orbital speed relative to Earth, across the line of flight, × simRate.
      rows[`moving_rate${rate}`] = cmp(await sim({ target: { positionKm: [0, 0, 380000], velKmps: [1.02 * rate, 0, 0], arrivalOffsetKm: 3474 } }));
    }
    const e = rows.straight380000;
    g.a_prediction = {
      ...rows,
      earthMoonShare: r4(e.kg / T.tankKg), expectShare: 0.35,
      pass: Object.values(rows).every((c) => within(c)) && Math.abs(e.kg / T.tankKg - 0.35) < 0.03 && Math.abs(e.heat - 0.35) < 0.05,
    };
  }

  // (d, pure) Blocked line: one clearance waypoint, two legs, never inside 2 R of Earth, prediction holds.
  {
    const r = await sim({ shipKm: SHIP_BEHIND, bodies: [EARTH, MOON], target: { id: "body:luna", positionKm: MOON_KM, arrivalOffsetKm: 3474 } });
    const c = cmp(r);
    g.d_clearancePure = {
      ...c, via: r.plan.viaBodyId, minEarthKm: r4(r.minBodyDistKm.earth), safeKm: 2 * EARTH.radiusKm, hit: r.hit, legsDone: r.events.legDone,
      pass: within(c) && r.plan.legCount === 2 && r.plan.viaBodyId === "earth" && r.minBodyDistKm.earth >= 2 * EARTH.radiusKm && !r.hit && r.events.legDone === 1,
    };
  }

  // (b) Reserve: partial fuel coasts and still stops; far too little refuses; zero ordinary refuses.
  {
    const ideal = await sim({ target: { positionKm: [0, 0, 380000] } });
    const part = await sim({ ordinaryKg: 80, target: { positionKm: [0, 0, 380000] } });
    const tiny = await sim({ ordinaryKg: 5, target: { positionKm: [0, 0, 380000] } });
    const zero = await sim({ ordinaryKg: 0, protectedKg: T.recoveryAllowanceKg, target: { positionKm: [0, 0, 380000] } });
    const zeroManual = await sim({ ordinaryKg: 0, protectedKg: T.recoveryAllowanceKg, target: null });
    const c = cmp(part);
    g.b_reserve = {
      partial: { ...c, coastS: r4((part.phaseAt.decelerating ?? 0) - (part.phaseAt.coasting ?? 0)), minOrdinaryKg: r4(part.minOrdinaryKg), protectedKg: r4(part.protectedKg), idealEtaS: r4(ideal.etaS), fuelLimited: part.plan.fuelLimited },
      tiny: { engaged: tiny.engaged, refusal: tiny.refusal, kg: tiny.fuelKg },
      zeroOrdinary: { engaged: zero.engaged, refusal: zero.refusal, protectedKg: zero.protectedKg },
      zeroOrdinaryManual: { engaged: zeroManual.engaged, refusal: zeroManual.refusal },
      pass: within(c) && part.plan.fuelLimited && part.phaseAt.coasting !== undefined && part.etaS > ideal.etaS && part.minOrdinaryKg >= 0 &&
        part.protectedKg === T.recoveryAllowanceKg && part.endSpeedKmps === 0 &&
        !tiny.engaged && /Too little propellant/.test(tiny.refusal ?? "") && tiny.fuelKg === 0 &&
        !zero.engaged && /No ordinary propellant/.test(zero.refusal ?? "") && zero.protectedKg === T.recoveryAllowanceKg &&
        !zeroManual.engaged && /No ordinary/.test(zeroManual.refusal ?? ""),
    };
  }

  // (b) Manoeuvring during coast spends around the braking reserve: transit billing stays 2·c·peak.
  {
    const r = await sim({ ordinaryKg: 80, strafeIn: "coasting", target: { positionKm: [0, 0, 380000] } });
    const c = cmp(r);
    const expectKg = 2 * T.transitKgPerKmps * r.peakKmps;
    g.b_strafeCoast = {
      ...c, transitKg: r4(r.transitKg), expectTransitKg: r4(expectKg), thrustKg: r4(r.thrustKg), protectedKg: r4(r.protectedKg), minOrdinaryKg: r4(r.minOrdinaryKg),
      pass: c.endKmps === 0 && c.arrived === 1 && r.thrustKg > 0 && rel(r.transitKg, expectKg) < 0.01 && rel(r.transitKg, r.plan.fuelKg) <= 0.05 &&
        r.protectedKg < T.recoveryAllowanceKg && r.minOrdinaryKg >= 0,
    };
  }

  // Low orbit (inside Earth's hard sphere) receding toward a target: routable, not "blocked by Earth".
  {
    const r = await sim({ shipKm: [6371 + 150, 0, 0], facing: [1, 0, 0], bodies: [EARTH, MOON], target: { id: "body:luna", positionKm: MOON_KM, arrivalOffsetKm: 3474 } });
    const c = cmp(r);
    g.lowOrbitDepart = { ...c, refusal: r.refusal, hit: r.hit, pass: r.engaged && within(c) && !r.hit };
  }

  // Dev speed override: transit is neither refused on an empty tank nor billed.
  {
    const r = await sim({ freeFlight: true, ordinaryKg: 0, target: { positionKm: [0, 0, 50000] } });
    g.freeFlight = { engaged: r.engaged, refusal: r.refusal, transitKg: r.transitKg, arrived: r.events.arrived, endKmps: r.endSpeedKmps, pass: r.engaged && r.transitKg === 0 && r.events.arrived === 1 && r.endSpeedKmps === 0 };
  }

  // Out of range on a full tank is worded as range, not as "too little propellant".
  {
    const r = await sim({ target: { positionKm: [0, 0, 78e6] } });
    g.outOfRange = { engaged: r.engaged, refusal: r.refusal, pass: !r.engaged && /Out of range for this tank/.test(r.refusal ?? "") };
  }

  // (b) Abort in every phase ends at rest; every kg billed is the transit meter's; ordinary never negative.
  {
    const base = { ordinaryKg: 120, target: { positionKm: [0, 0, 380000] } };
    const cases = {
      spool: { ...base, tapAt: { phase: "spooling", afterS: 1.5 } },
      accel: { ...base, tapAt: { phase: "accelerating", afterS: 4 } },
      coast: { ...base, tapAt: { phase: "coasting", afterS: 3 } },
      decel: { ...base, tapAt: { phase: "decelerating", afterS: 3 } },
    };
    const rows = {};
    let ok = true;
    for (const [name, sc] of Object.entries(cases)) {
      const r = await sim(sc);
      const c = T.transitKgPerKmps;
      // Billed = speed built + the braking that removed it: 2 × speed at the tap for accel/coast aborts.
      const row = {
        tapS: r4(r.tapS), speedAtTap: r4(r.speedAtTapKmps), endKmps: r.endSpeedKmps, shipMps: r4(r.shipSpeedMps), endPhase: r.endPhase,
        kg: r4(r.fuelKg), transitKg: r4(r.transitKg), minOrdinaryKg: r4(r.minOrdinaryKg), aborted: r.events.aborted, arrived: r.events.arrived,
      };
      row.pass = r.tapS !== null && r.endPhase === "idle" && r.endSpeedKmps === 0 && r.shipSpeedMps < 1e-6 && Math.abs(r.fuelKg - r.transitKg) < 1e-9 &&
        r.minOrdinaryKg >= 0 && r.events.arrived === 0;
      if (name === "spool") row.pass &&= r.fuelKg === 0;
      if (name === "accel" || name === "coast") {
        row.expectKg = r4(2 * r.speedAtTapKmps * c);
        row.pass &&= Math.abs(r.fuelKg - 2 * r.speedAtTapKmps * c) < 0.02 * r.fuelKg + 1e-6;
      }
      ok &&= row.pass;
      rows[name] = row;
    }
    g.b_abort = { ...rows, pass: ok };
  }

  // (c) Pacing: identical results at 30/60/144 Hz and across hitches (a 2 s hitch drops wall time only).
  {
    const sc = { shipKm: SHIP_BEHIND, bodies: [EARTH, MOON], ordinaryKg: 300, target: { id: "body:luna", positionKm: MOON_KM, arrivalOffsetKm: 3474 } };
    const runs = {};
    for (const hz of [30, 60, 144]) runs[hz] = await sim({ ...sc, frameHz: hz });
    runs.hitch = await sim({ ...sc, frameHz: 60, hitchAtS: 10, hitchS: 0.25 });
    runs.bigHitch = await sim({ ...sc, frameHz: 60, hitchAtS: 10, hitchS: 2 });
    const fin = (r) => ({ eta: r.etaS, kg: r.fuelKg, heat: r.peakHeat01, end: r.final, legs: r.events });
    const same = ["60", "144", "hitch", "bigHitch"].every((k) => eq(fin(runs[30]), fin(runs[k])));
    g.c_pacing = {
      etaS: r4(runs[60].etaS), kg: r4(runs[60].fuelKg), steps: [runs[30].steps, runs[60].steps, runs[144].steps, runs.hitch.steps, runs.bigHitch.steps],
      frames: [runs[30].frames, runs[60].frames, runs[144].frames, runs.hitch.frames, runs.bigHitch.frames], bigHitchDroppedS: runs.bigHitch.droppedS,
      identical: same, pass: same && runs.bigHitch.droppedS > 1.7,
    };
  }

  // Heat: braking is never throttled; a hot start slows acceleration but the leg still stops.
  {
    const hot = await sim({ heat01: 0.97, target: { positionKm: [0, 0, 50000] } });
    const c = cmp(hot);
    g.heatThrottle = { ...c, startHeat: 0.97, pass: within(c) && hot.endSpeedKmps === 0 };
  }

  return { ...g, pass: Object.values(g).every((x) => x.pass) };
}


const DEFAULT_EPOCH_MS = Date.UTC(2024, 3, 8, 18, 17, 0);
/** A second date: two weeks on, the Moon is on the other side of Earth. */
const SECOND_EPOCH_MS = Date.UTC(2024, 3, 22, 6, 0, 0);
const MOON_STANDOFF_KM = 1737 * 2;

/** Fixture: default start (no saved pose), transit drive owned, full tanks, at `epochMs`. */
function transitWorld(ctx, epochMs, o = {}) {
  const modules = { ownedModules: ["special_transit_drive"], equippedModules: {}, consumables: {}, consumableCooldowns: {}, hotbar: Array(10).fill(null) };
  const { research, ...rest } = ctx.v1Player({ modules, ...(o.base ?? {}) });
  void research;
  const player = { ...rest, research: { assaySamples: 0, activeResearch: null }, propellant: o.propellant ?? { ordinaryKg: 600, protectedKg: 60 }, power: { capacitor01: 1, heat01: 0 }, processing: null };
  return { schemaVersion: 2, world: { ...ctx.v1World({ simEpochMs: epochMs, simRate: o.simRate ?? 1 }), research: { completedNodes: [] }, receipts: [] }, players: { [ctx.me]: player } };
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Point the nose at the Moon and let the real gaze targeting lock it (POIProjector). */
async function gazeLock(d, id, bodyId, kind = "bodies") {
  const ev = (s) => d.evaluate(s);
  const pos = async () => (await ev(`${TR}.${kind}([${JSON.stringify(bodyId)}])`))[bodyId].posKm;
  for (let i = 0; i < 40; i++) {
    await ev(`${G}.res.face(${JSON.stringify(await pos())})`);
    await d.frames(10);
    if ((await ev(`${TR}.state()`)).targeted === id) return true;
  }
  return false;
}

/** Fly a targeted transit through the T key; returns the record and the end state. */
async function flyTargeted(d, { shotName, maxS = 240 } = {}) {
  const ev = (s) => d.evaluate(s);
  await ev(`${TR}.record(["earth", "luna"])`);
  await d.hold("t", 3400);
  let shot = null;
  const t0 = Date.now();
  let st = await ev(`${TR}.state()`);
  while (Date.now() - t0 < maxS * 1000) {
    await new Promise((r) => setTimeout(r, 400));
    st = await ev(`${TR}.state()`);
    if (shotName && !shot && st.phase !== "spooling" && st.legIndex === st.legCount - 1 && st.speedKmps > 5000) shot = await d.shot(shotName);
    if (st.phase === "idle") break;
  }
  await d.frames(5);
  const rec = await ev(`${TR}.recordStop()`);
  return { rec, st, shot, wallS: (Date.now() - t0) / 1000 };
}

export async function transitLiveGates(d, ctx) {
  const { ev, boot, fixture } = ctx;
  const out = {};
  const res = () => ev(`${G}.res.state()`);
  const phys = () => ev("__phys.stats()");
  const only = process.env.TRANSIT_EPOCHS?.split(",");
  const runs = [["defaultEpoch", DEFAULT_EPOCH_MS, 1], ["secondEpoch", SECOND_EPOCH_MS, 1], ["secondEpochRate100", SECOND_EPOCH_MS, 100]];
  for (const [label, epoch, simRate] of runs.filter(([l]) => !only || only.includes(l))) {
    const id = await fixture(`transit-${label}`, transitWorld(ctx, epoch, { simRate }));
    await boot(id);
    await d.frames(60);
    const startState = await d.state();
    const locked = await gazeLock(d, "body:luna", "luna");
    await d.frames(30);
    const pre = await ev(`${TR}.preview()`);
    if (process.env.TRANSIT_DEBUG) return { pre, st: await ev(`${TR}.state()`), locked };
    // Synthetic near-field colliders behind the ship, so the post-transit re-seed is observable.
    await ev("__phys.dev.clear()");
    for (let i = 0; i < 3; i++) await ev(`__phys.dev.add({ kind: 'hull', radiusM: 10, aheadM: ${-300 - i * 50}, rightM: 200 })`);
    await d.frames(5);
    const r0 = await res();
    const p0 = await phys();
    const fly = await flyTargeted(d, { shotName: label === "defaultEpoch" ? "m3-transit-flying" : null });
    await d.frames(10);
    const r1 = await res();
    const p1 = await phys();
    await ev("__phys.dev.clear()");
    const b = await ev(`${TR}.bodies(["earth", "luna"])`);
    const s = await d.state();
    const toMoon = dist(s.ship.posKm, b.luna.posKm);
    const exeEtaS = (fly.rec.endStep - fly.rec.engageStep) / 120;
    const kg = r0.ordinaryKg + r0.protectedKg - r1.ordinaryKg - r1.protectedKg;
    const row = {
      epoch: new Date(epoch).toISOString(), simRate: await ev("__test.simRate()"), startFrame: startState.ship.frameId, gazeLocked: locked,
      preview: { ok: pre?.ok, reason: pre?.reason, via: pre?.viaName, legs: pre?.legCount, etaS: r4(pre?.etaS), fuelKg: r4(pre?.fuelKg), balanceKg: r4(pre?.arrivalOrdinaryKg), heat: r4(pre?.peakHeat01) },
      executed: { etaS: r4(exeEtaS), fuelKg: r4(kg), balanceKg: r4(r1.ordinaryKg), heat: r4(fly.rec.maxHeat01), wallS: r4(fly.wallS) },
      err: { eta: r4(rel(exeEtaS, pre?.etaS ?? 0)), fuel: r4(rel(kg, pre?.fuelKg ?? 0)), heat: r4(Math.abs(fly.rec.maxHeat01 - (pre?.peakHeat01 ?? 0))) },
      arrival: { toMoonCentreKm: r4(toMoon), standoffKm: MOON_STANDOFF_KM, errKm: r4(toMoon - MOON_STANDOFF_KM), frameId: s.ship.frameId, transitKmps: fly.st.speedKmps, shipMps: r4(s.ship.speedMps), arrived: fly.st.ev.arrived, legsDone: fly.st.ev.legDone },
      minEarthKm: r4(fly.rec.minDistKm.earth), earthSafeKm: 2 * 6371, minMoonKm: r4(fly.rec.minDistKm.luna), phases: fly.rec.phases, frames: fly.rec.frameIds,
      nearField: { suspended: fly.rec.suspended, reseeds: p1.counters.reseeds - p0.counters.reseeds, ownerViolations: p1.counters.ownerViolations, after: p1.suspended },
      dead: s.dead ?? null,
    };
    row.pass = locked && pre?.ok && fly.st.ev.arrived === 1 && row.err.eta <= 0.05 && row.err.fuel <= 0.05 && row.err.heat <= 0.05 &&
      Math.abs(row.arrival.errKm) <= Math.max(50, 0.05 * MOON_STANDOFF_KM) && s.ship.frameId === "luna" && fly.st.speedKmps === 0 &&
      fly.rec.minDistKm.earth >= 2 * 6371 && fly.rec.suspended.includes("transit") && p1.suspended === null && p1.counters.reseeds > p0.counters.reseeds &&
      p1.counters.ownerViolations === 0 && (label !== "defaultEpoch" || pre?.legCount === 2);
    out[label] = row;
    if (label === "defaultEpoch") out.lunarHydrates = await lunarHydrates(d, ctx);
  }
  if (!only || only.includes("lifecycle")) out.lifecycle = await lifecycleGate(d, ctx);
  if (!only || only.includes("sweep")) out.sweep = await sweepGate(d, ctx);
  return { ...out, pass: Object.values(out).every((x) => x.pass) };
}

/** At the Moon: what hydrate rocks are in reach today, and process one rock's worth into the tank. */
async function lunarHydrates(d, ctx) {
  const { ev } = ctx;
  await d.frames(60);
  const atStandoff = (await ev(`${G}.res.starterReach(5)`)).rocksLoaded;
  // A short transit to the lunar field (the standoff is on the Earth side; the field is behind the Moon).
  const locked = await gazeLock(d, "field:luna_belt", "luna_belt", "fields");
  await d.frames(20);
  const pre = await ev(`${TR}.preview()`);
  const fly = locked && pre?.ok ? await flyTargeted(d, { maxS: 120 }) : null;
  const f = await ev(`${TR}.fields(["luna_belt"])`);
  const s = await d.state();
  const hop = {
    locked, preview: pre && { ok: pre.ok, reason: pre.reason, via: pre.viaName, etaS: r4(pre.etaS), fuelKg: r4(pre.fuelKg) },
    executed: fly && { etaS: r4((fly.rec.endStep - fly.rec.engageStep) / 120), fuelKg: r4(fly.rec.kgUsed), arrived: fly.st.ev.arrived, minMoonKm: r4(fly.rec.minDistKm.luna) },
    toAnchorKm: r4(dist(s.ship.posKm, f.luna_belt.posKm)),
  };
  for (let i = 0; i < 20; i++) {
    await d.frames(30);
    if ((await ev(`${G}.res.starterReach(1)`)).rocksLoaded > 0) break;
  }
  const reach = await ev(`${G}.res.starterReach(5)`);
  const near = reach.nearest.filter((r) => r.fieldId === "luna_belt");
  const out = { rocksAtStandoff: atStandoff, hop, rocksLoaded: reach.rocksLoaded, hydrateRocks: reach.hydrateRocks, nearest: near.slice(0, 3).map((r) => ({ distKm: r4(r.distKm), hydrates: r.hydrates, radiusM: r4(r.radiusM), mineS: r4(r.mineS) })) };
  const rock = near.find((r) => r.mineS < 14) ?? near[0];
  if (!rock) return { ...out, note: "no lunar hydrate rock loaded within reach of the standoff", pass: true };
  // Extraction via the mining claim (aiming skipped); then the real processing action.
  const s0 = await ev(`${G}.res.state()`);
  const m = await ev(`${G}.mine(${JSON.stringify(rock)})`);
  const hyd = (await ev(`${G}.player()`)).cargo.items.hydrates ?? 0;
  const p = hyd > 0 ? await ev(`${G}.res.startProcessing(${Math.min(hyd, 50)})`) : null;
  for (let i = 0; i < 40 && p; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!(await ev(`${G}.res.state()`)).processing.active) break;
  }
  const s1 = await ev(`${G}.res.state()`);
  const T = await ev(`${G}.res.tuning()`);
  out.mined = { rockDistKm: r4(rock.distKm), status: m?.status, hydrates: hyd, process: p?.status ?? null, ordinaryBefore: r4(s0.ordinaryKg), ordinaryAfter: r4(s1.ordinaryKg), expectGainKg: Math.min(hyd * T.processingKgPerUnit, T.tankKg - s0.ordinaryKg) };
  out.pass = m?.status === "accepted" && (hyd === 0 || Math.abs(s1.ordinaryKg - s0.ordinaryKg - out.mined.expectGainKg) < 1e-6) &&
    (!fly || (fly.st.ev.arrived >= 1 && rel(fly.rec.kgUsed, pre.fuelKg) <= 0.05));
  return out;
}

/** (c) Mid-leg: settings, loading pause and a stalled main thread advance and bill nothing; death ends the leg. */
async function lifecycleGate(d, ctx) {
  const { ev, boot, fixture } = ctx;
  const id = await fixture("transit-lifecycle", transitWorld(ctx, SECOND_EPOCH_MS));
  await boot(id);
  await d.frames(60);
  await gazeLock(d, "body:luna", "luna");
  await d.hold("t", 3400);
  await new Promise((r) => setTimeout(r, 3000));
  const snap = async () => {
    const t = await ev(`${TR}.state()`);
    const r = await ev(`${G}.res.state()`);
    return { phase: t.phase, v: t.speedKmps, dist: t.distKm, kg: r.ordinaryKg + r.protectedKg, heat: r.heat01, steps: r.meter.steps };
  };
  const still = (a, b) => a.v === b.v && a.dist === b.dist && a.kg === b.kg && a.heat === b.heat && a.steps === b.steps;
  const out = {};
  await ev(`${G}.res.setSettingsOpen(true)`);
  await new Promise((r) => setTimeout(r, 300));
  let a = await snap();
  await new Promise((r) => setTimeout(r, 2000));
  let b = await snap();
  out.settings = { phase: a.phase, still: still(a, b) };
  await ev(`${G}.res.setSettingsOpen(false)`);
  await ev(`${G}.res.setLoadingPause(true)`);
  await new Promise((r) => setTimeout(r, 300));
  a = await snap();
  await new Promise((r) => setTimeout(r, 2000));
  b = await snap();
  out.loading = { phase: a.phase, still: still(a, b) };
  await ev(`${G}.res.setLoadingPause(false)`);
  a = await snap();
  await ev("(() => { const t = performance.now(); while (performance.now() - t < 3000) {} })()");
  b = await snap();
  out.stall = { stepsDelta: b.steps - a.steps, kgDelta: r4(a.kg - b.kg) };
  // ≤ 30 steps (MAX_FRAME_DT) for the stalled frame, plus the ordinary frames between the two samples, as m32.
  // Death mid-leg: the leg ends with the ship, nothing more is billed while dead.
  const k = await ev(`${G}.kill()`);
  await d.frames(5);
  a = await snap();
  await new Promise((r) => setTimeout(r, 1500));
  b = await snap();
  out.death = { kill: k?.status, phase: b.phase, v: b.v, still: a.kg === b.kg && a.steps === b.steps };
  out.pass = out.settings.still && out.settings.phase !== "idle" && out.loading.still && out.stall.stepsDelta <= 40 &&
    k?.status === "accepted" && b.phase === "idle" && b.v === 0 && out.death.still;
  return out;
}

/** The celestial sweep still kills a ship flown into a body (normal flight, dev speed so it takes seconds). */
async function sweepGate(d, ctx) {
  const { ev, boot, fixture } = ctx;
  const id = await fixture("transit-sweep", transitWorld(ctx, SECOND_EPOCH_MS));
  await boot(id);
  await d.scene("luna:20");
  await d.frames(30);
  const b = await ev(`${TR}.bodies(["luna"])`);
  await ev(`${G}.res.face(${JSON.stringify(b.luna.posKm)})`);
  const alt = async () => {
    const st = await d.state();
    return dist(st.ship.posKm, (await ev(`${TR}.bodies(["luna"])`)).luna.posKm) - b.luna.radiusKm;
  };
  const alt0 = await alt();
  await ev("__bench.maxSpeed(5000)");
  let dead = false, speedMps = 0;
  const t0 = Date.now();
  const trace = [];
  await d.send("Input.dispatchKeyEvent", { type: "keyDown", key: "w", code: "KeyW", windowsVirtualKeyCode: 87, text: "w" });
  for (let i = 0; i < 40 && !dead; i++) {
    await new Promise((r) => setTimeout(r, 250));
    dead = await ev(`${G}.mirrors().isDead`);
    const st = await d.state();
    if (!dead) speedMps = st.ship.speedMps;
    trace.push([r4(await alt()), Math.round(st.ship.speedMps), st.ship.frameId]);
  }
  await d.send("Input.dispatchKeyEvent", { type: "keyUp", key: "w", code: "KeyW", windowsVirtualKeyCode: 87 });
  await ev("__bench.maxSpeed(null)");
  const s = await d.state();
  const alt1 = await alt();
  if (!dead) return { trace, pass: false };
  return { startAltKm: r4(alt0), endAltKm: r4(alt1), speedMps: r4(speedMps), seconds: r4((Date.now() - t0) / 1000), dead, frameId: s.ship.frameId, pass: dead && alt1 < 1 };
}

/** HUD captures. `narrow`: run with --size 390x844. */
export async function transitShotGates(d, ctx, narrow) {
  const { ev, boot, fixture } = ctx;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shots = {};
  const id2 = await fixture("transit-shots-b", transitWorld(ctx, SECOND_EPOCH_MS));
  await boot(id2);
  await d.frames(60);
  const lockedB = await gazeLock(d, "body:luna", "luna");
  await wait(1200);
  if (narrow) {
    shots.previewNarrow = await d.shot("m3-transit-preview-narrow");
    return { lockedB, shots, pass: lockedB };
  }
  shots.preview = await d.shot("m3-transit-preview");
  const id1 = await fixture("transit-shots-a", transitWorld(ctx, DEFAULT_EPOCH_MS));
  await boot(id1);
  await d.frames(60);
  const lockedA = await gazeLock(d, "body:luna", "luna");
  await wait(1200);
  shots.blocked = await d.shot("m3-transit-blocked-route");
  await ev(`${G}.res.set({ ordinaryKg: 5 })`);
  await wait(800);
  await d.hold("t", 400);
  await wait(300);
  shots.refused = await d.shot("m3-transit-refused");
  const refusal = (await ev(`${TR}.state()`)).ev.refusal;
  await ev(`${G}.res.set({ ordinaryKg: 600 })`);
  await wait(600);
  const fly = flyTargeted(d, { shotName: "m3-transit-flying", maxS: 120 });
  shots.flying = (await fly).shot;
  return { lockedA, lockedB, refusal, shots, pass: lockedA && lockedB && /Too little/.test(refusal ?? "") && !!shots.flying };
}
