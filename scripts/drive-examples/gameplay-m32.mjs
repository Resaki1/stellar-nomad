/**
 * M3.2 gates (ship resources), run from gameplay-check.mjs:
 *   res     pure: __test.gameplay.res.simulate (stepShip + resource step, explicit frame pacing)
 *   m32     live, fixture world: processing / repair / death / reload / lifecycle / emergency
 *   reach   live, fixture world: recover with only the protected allowance, reach + mine + process
 *   shots   HUD/panel captures (1280×720); `narrow` the 390×844 one (run with --size 390x844)
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

const G = "__test.gameplay";
const R = `${G}.res`;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const r4 = (x) => (x === null || x === undefined ? x : +(+x).toFixed(4));
const near = (a, b, rel) => Math.abs(a - b) <= Math.abs(b) * rel;

export async function resGates(d) {
  const ev = (s) => d.evaluate(s);
  const T = await ev(`${R}.tuning()`);
  const sim = (sc) => ev(`${R}.simulate(${JSON.stringify(sc)})`);
  const g = {};
  const seg = (r, i) => r.segments[i];
  const kg = (s) => s.meter.thrustKg + s.meter.rotationKg + s.meter.transitKg;

  // V1 — idle and coast cost exactly 0 over 60 s (decoupled coast, and coupled at its set-point).
  {
    const vLim = await ev("__test.flight.speedLimitMps()");
    const idle = await sim({ segments: [{ seconds: 60 }] });
    const coastD = await sim({ start: { velocityBodyMps: [20, -10, 300] }, segments: [{ decoupled: true, seconds: 60 }] });
    const coastC = await sim({ start: { velocityBodyMps: [0, 0, 0.75 * vLim] }, segments: [{ throttle: 0.75, seconds: 60 }] });
    g.v1_idleCoast = {
      kg: [kg(seg(idle, 0)), kg(seg(coastD, 0)), kg(seg(coastC, 0))],
      coastSpeedMps: [r4(seg(coastD, 0).end.speedMps), r4(seg(coastC, 0).end.speedMps)],
      pass: kg(seg(idle, 0)) === 0 && kg(seg(coastD, 0)) === 0 && kg(seg(coastC, 0)) === 0 && seg(coastD, 0).end.speedMps > 300,
    };
  }

  // V1 — each axis costs k × delivered Δv; Δv matches the commanded acceleration.
  {
    const k = T.propellantKgPerMps;
    const axes = {
      main: await sim({ segments: [{ decoupled: true, throttle: 1, seconds: 2 }] }),
      strafeX: await sim({ segments: [{ decoupled: true, strafeX: 1, seconds: 2 }] }),
      strafeY: await sim({ segments: [{ decoupled: true, strafeY: -1, seconds: 2 }] }),
      retro: await sim({ start: { velocityBodyMps: [0, 0, 200] }, segments: [{ decoupled: true, seconds: 0.5 }, { brake: true, seconds: 4 }] }),
      // Coupled at speed, full yaw for 1 s: grip drags the velocity round to the nose.
      gripTurn: await sim({ start: { velocityBodyMps: [0, 0, 300] }, segments: [{ throttle: 300 / (await ev("__test.flight.speedLimitMps()")), yaw: 1, seconds: 1 }] }),
      rotate180: await sim({ segments: [{ yaw: 1, seconds: 3 }, { seconds: 1 }] }),
    };
    const expectDv = { main: 240, strafeX: 120, strafeY: 120, retro: 200 };
    const rows = {};
    let ok = true;
    for (const [name, r] of Object.entries(axes)) {
      const s = name === "retro" ? seg(r, 1) : seg(r, 0);
      const extra = name === "rotate180" ? seg(r, 1).meter.rotationKg : 0;
      const row = { dvMps: r4(s.meter.dvMps), thrustKg: r4(s.meter.thrustKg), rotationKg: r4(s.meter.rotationKg + extra), linear: Math.abs(s.meter.thrustKg - s.meter.dvMps * k) < 1e-9 };
      if (expectDv[name] !== undefined) row.dvOk = near(s.meter.dvMps, expectDv[name], 0.01);
      if (name === "gripTurn") row.dvOk = s.meter.dvMps > 50 && s.meter.rotationKg > 0;
      if (name === "rotate180") {
        row.pctOfHop = r4(((s.meter.rotationKg + extra) / (1500 * k)) * 100);
        row.dvOk = s.meter.dvMps === 0 && row.pctOfHop < 1;
      }
      ok = ok && row.linear && row.dvOk !== false;
      rows[name] = row;
    }
    g.v1_axes = { ...rows, pass: ok };
  }

  // V1 — scripted hop (accelerate to the limit, 90° turn, stop) vs the 12 kg target ±10 %.
  const hopScript = { segments: [{ throttle: 1, seconds: 5 }, { throttle: 1, yaw: 1, seconds: 1.65 }, { throttle: 1, seconds: 0.5 }, { brake: true, seconds: 6 }] };
  {
    const hop = await sim(hopScript);
    const total = hop.segments.reduce((a, s) => a + kg(s), 0);
    const dv = hop.segments.reduce((a, s) => a + s.meter.dvMps, 0);
    const target = 1500 * T.propellantKgPerMps;
    g.v1_hop = { dvMps: r4(dv), kg: r4(total), targetKg: r4(target), hopsPerTank: r4(T.tankKg / total), hopsInAllowance: r4(T.recoveryAllowanceKg / total), endSpeedMps: r4(hop.final.speedMps), pass: near(total, target, 0.1) && hop.final.speedMps === 0 };
  }

  // V1 — identical results at 30/60/144 Hz and across a capped hitch (same executed inputs).
  {
    const script = {
      start: { ordinaryKg: 300 },
      segments: [...hopScript.segments.map((s) => ({ ...s, seconds: Math.round(s.seconds * 10) / 10 })), { seconds: 1, mining: true, startBatchUnits: 30 }, { seconds: 6, mining: true }, { seconds: 4, boost: true, throttle: 1 }],
    };
    // Segment lengths must be whole frames at every rate; round to 1/6 s grid (30/60/144 all divide).
    script.segments = script.segments.map((s) => ({ ...s, seconds: Math.max(1 / 6, Math.round(s.seconds * 6) / 6) }));
    const runs = {};
    for (const hz of [30, 60, 144]) runs[hz] = await sim({ ...script, frameHz: hz });
    runs.hitch = await sim({ ...script, frameHz: 60, hitchAtS: 3, hitchS: 0.25 });
    runs.bigHitch = await sim({ ...script, frameHz: 60, hitchAtS: 3, hitchS: 2 });
    const fin = (r) => ({ ...r.final, t: undefined });
    const same = eq(fin(runs[30]), fin(runs[60])) && eq(fin(runs[60]), fin(runs[144])) && eq(fin(runs[60]), fin(runs.hitch));
    g.v1_pacing = {
      final60: { ordinaryKg: r4(runs[60].final.ordinaryKg), heat01: r4(runs[60].final.heat01), committedKg: r4(runs[60].final.committedKg) },
      steps: [runs[30].stepsRun, runs[60].stepsRun, runs[144].stepsRun, runs.hitch.stepsRun],
      frames: [runs[30].framesRun, runs[60].framesRun, runs[144].framesRun, runs.hitch.framesRun],
      identical: same,
      bigHitch: { droppedS: runs.bigHitch.droppedS, steps: runs.bigHitch.stepsRun, ordinaryKg: r4(runs.bigHitch.final.ordinaryKg) },
      // A hitch beyond MAX_FRAME_DT drops wall time: executed time (and every store) is unchanged, no catch-up bill.
      pass: same && runs.bigHitch.droppedS > 1.7 && eq(fin(runs.bigHitch), fin(runs[60])),
    };
  }

  // V1 — a contact bounce and a frame switch are free; assist that cancels a bounce is thrust.
  {
    const bounceD = await sim({ start: { velocityBodyMps: [0, 0, 50] }, segments: [{ decoupled: true, seconds: 0.5 }, { decoupled: true, kickBodyMps: [30, 0, -80], seconds: 2 }] });
    const bounceC = await sim({ segments: [{ seconds: 0.5 }, { kickBodyMps: [30, 0, 0], seconds: 3 }] });
    const frames = await ev("__test.frameList()");
    const fid = frames.find((f) => f.id === "earth") ? "earth" : frames.find((f) => f.id !== "system")?.id;
    const sw = await sim({ start: { frameEdge: fid, velocityBodyMps: [0, 0, 400] }, segments: [{ decoupled: true, seconds: 3 }] });
    g.v1_bounceFrames = {
      decoupledBounceKg: kg(seg(bounceD, 1)),
      coupledAssistAfterBounce: { kg: r4(kg(seg(bounceC, 1))), dvMps: r4(seg(bounceC, 1).meter.dvMps) },
      frameSwitch: { frame: fid, switches: seg(sw, 0).frameSwitches, kg: kg(seg(sw, 0)) },
      pass: kg(seg(bounceD, 1)) === 0 && seg(sw, 0).frameSwitches >= 1 && kg(seg(sw, 0)) === 0 && near(seg(bounceC, 1).meter.dvMps, 30, 0.02),
    };
  }

  // V1 — exhaustion: ordinary first, protected last; then thrust suppressed, velocity kept; no NaN/negative.
  {
    const r = await sim({ sampleEvery: 1, start: { ordinaryKg: 1, protectedKg: 1 }, segments: [{ decoupled: true, throttle: 1, seconds: 4 }, { decoupled: true, throttle: 1, strafeX: 1, yaw: 0.5, seconds: 3 }] });
    const tr = [...seg(r, 0).trace, ...seg(r, 1).trace];
    const finite = tr.every((s) => [s.ordinaryKg, s.protectedKg, s.heat01, s.speedMps].every((x) => Number.isFinite(x) && x >= 0));
    const protectedFirstDrop = tr.findIndex((s) => s.protectedKg < 1);
    const ordinaryAtThat = protectedFirstDrop >= 0 ? tr[protectedFirstDrop].ordinaryKg : null;
    const emptyIdx = tr.findIndex((s) => s.ordinaryKg === 0 && s.protectedKg === 0);
    const vEmpty = emptyIdx >= 0 ? tr[emptyIdx].speedMps : null;
    g.v1_exhaustion = {
      protectedUsedOnlyAfterOrdinary: ordinaryAtThat === 0,
      emptyAtS: emptyIdx >= 0 ? r4(tr[emptyIdx].t) : null,
      speedAtEmptyMps: r4(vEmpty), speedEndMps: r4(r.final.speedMps), minThrustScale: seg(r, 1).minThrustScale,
      stores: [r.final.ordinaryKg, r.final.protectedKg], finite,
      pass: ordinaryAtThat === 0 && emptyIdx >= 0 && finite && r.final.ordinaryKg === 0 && r.final.protectedKg === 0 && seg(r, 1).minThrustScale === 0 &&
        vEmpty > 100 && Math.abs(r.final.speedMps - vEmpty) < 1,
    };
  }

  // V2 — boost uses the one M1 capacitor: same trace as __test.flight.simulate.
  {
    const script = [{ throttle: 1, boost: true, seconds: 7 }, { throttle: 1, seconds: 12 }];
    const fl = await ev(`__test.flight.simulate(${JSON.stringify({ sampleEvery: 1, segments: script })})`);
    const rs = await sim({ sampleEvery: 1, segments: script });
    const ft = [...fl.segments[0].trace.slice(1), ...fl.segments[1].trace.slice(1)].map((s) => s.boostCharge);
    const rt = [...seg(rs, 0).trace.slice(1), ...seg(rs, 1).trace.slice(1)].map((s) => s.capacitor01);
    const firstT = (trace, pred) => trace.find(pred)?.t ?? null;
    const t0 = fl.segments[0].trace, t1 = fl.segments[1].trace;
    const rel = t1[0].t;
    g.v2_boost = {
      sameTrace: eq(ft, rt), samples: ft.length,
      emptyAtS: r4(firstT(t0, (s) => s.boostCharge === 0)), refillStartS: r4(firstT(t1, (s) => s.boostCharge > 0) - rel), fullAtS: r4(firstT(t1, (s) => s.boostCharge === 1) - rel),
      heatAfter5sBoost: r4(seg(await sim({ segments: [{ boost: true, throttle: 1, seconds: 5 }] }), 0).end.heat01),
      pass: eq(ft, rt),
    };
  }

  // V2 — reactor: either alone unthrottled; together both throttled by the same factor, output too.
  {
    const mine = seg(await sim({ segments: [{ mining: true, seconds: 5 }] }), 0);
    const proc = seg(await sim({ start: { ordinaryKg: 0 }, segments: [{ startBatchUnits: 50, seconds: 5 }] }), 0);
    const both = seg(await sim({ start: { ordinaryKg: 0 }, segments: [{ mining: true, startBatchUnits: 50, seconds: 5 }] }), 0);
    const scale = both.meter.miningWorkS / 5;
    g.v2_power = {
      alone: { miningWorkS: r4(mine.meter.miningWorkS), processedKg: r4(proc.meter.processedKg) },
      both: { miningWorkS: r4(both.meter.miningWorkS), processedKg: r4(both.meter.processedKg), scale: r4(scale), heatMax: r4(both.maxHeat01) },
      pass: near(mine.meter.miningWorkS, 5, 1e-6) && near(proc.meter.processedKg, 50, 1e-6) && scale < 0.95 && near(both.meter.processedKg / 50, scale, 1e-6) && both.maxHeat01 < T.heatThrottle01,
    };
  }

  // V2 — mining-only heat as before M3.2: overheat ≈ 15 s continuous, 100 % → 0 in ≈ 10 s.
  {
    const r = await sim({ sampleEvery: 1, segments: [{ mining: true, seconds: 15.5 }, { seconds: 12 }] });
    const trip = seg(r, 0).firstTripS;
    const cool = seg(r, 1).trace;
    const peak = seg(r, 0).maxHeat01;
    const t100 = seg(r, 0).trace.find((s) => s.heat01 >= 1)?.t ?? null;
    const zero = cool.find((s) => s.heat01 === 0)?.t ?? null;
    const coolS = zero !== null && t100 !== null ? zero - t100 : null;
    g.v2_miningHeat = { tripS: r4(trip), expectTripS: 15, coolFrom100S: r4(coolS), expectCoolS: 10, peak: r4(peak), pass: trip !== null && near(trip, 15, 0.05) && coolS !== null && near(coolS, 10, 0.05) };
  }

  // V2 — mining heat modules keep the pre-M3 law: trip = 15 s / heatBuildUp, cool = 10 s × 1/cooldownSpeed.
  {
    const cases = { build080: [0.8, 1], build065: [0.65, 1], build090: [0.9, 1], build052: [0.8 * 0.65, 1], cool130: [1, 1.3] };
    const rows = {};
    let ok = true;
    for (const [name, [hm, cm]] of Object.entries(cases)) {
      const expTrip = 15 / hm, expCool = 10 / cm;
      const r = await sim({ sampleEvery: 1, miningHeatMult: hm, coolingMult: cm, segments: [{ mining: true, seconds: expTrip + 0.5 }, { seconds: expCool + 2 }] });
      const trip = seg(r, 0).firstTripS;
      const t100 = seg(r, 0).trace.find((x) => x.heat01 >= 1)?.t ?? null;
      const zero = seg(r, 1).trace.find((x) => x.heat01 === 0)?.t ?? null;
      const coolS = zero !== null && t100 !== null ? zero - t100 : null;
      const pass = trip !== null && near(trip, expTrip, 0.05) && coolS !== null && near(coolS, expCool, 0.05);
      ok &&= pass;
      rows[name] = { tripS: r4(trip), expectTripS: r4(expTrip), coolS: r4(coolS), expectCoolS: r4(expCool), pass };
    }
    g.v2_miningHeatModules = { ...rows, pass: ok };
  }

  // V1 — sub-deadband thrust is carried, not free; empty tank: boost spends no capacitor and adds no heat.
  {
    const r = seg(await sim({ segments: [{ decoupled: true, throttle: 0.0005, seconds: 60 }] }), 0);
    const e = seg(await sim({ start: { ordinaryKg: 0, protectedKg: 0 }, segments: [{ boost: true, throttle: 1, seconds: 5 }] }), 0);
    g.v1_deadbandCarry = {
      speedMps: r4(r.end.speedMps), dvMps: r4(r.meter.dvMps), thrustKg: r4(r.meter.thrustKg),
      emptyBoost: { capacitor: r4(e.end.capacitor01), heat: r4(e.end.heat01), speedMps: r4(e.end.speedMps) },
      pass: r.end.speedMps > 0 && near(r.meter.dvMps, r.end.speedMps, 0.01) && r.meter.thrustKg > 0 && e.end.capacitor01 === 1 && e.end.heat01 === 0 && e.end.speedMps === 0,
    };
  }

  // V2 — ladder: warning, then throttling, then (only from boost above 100 %) hull damage.
  {
    const r = await sim({ sampleEvery: 1, start: { ordinaryKg: 0, heat01: 0.7 }, segments: [{ mining: true, startBatchUnits: 50, boost: true, throttle: 1, seconds: 5 }, { seconds: 4 }] });
    const s = seg(r, 0);
    const order = [s.firstWarnS, s.firstThrottleS, s.firstTripS, s.firstOver100S, s.firstDamageS];
    g.v2_ladder = {
      warnS: r4(s.firstWarnS), throttleS: r4(s.firstThrottleS), laserTripS: r4(s.firstTripS), over100S: r4(s.firstOver100S), damageS: r4(s.firstDamageS),
      reactionWindowS: r4(s.firstDamageS - s.firstWarnS), damage01: r4(r.final.heatDamage01), peak: r4(s.maxHeat01),
      pass: order.every((x) => x !== null) && order.every((x, i) => i === 0 || x >= order[i - 1]) && s.firstDamageS - s.firstWarnS >= 2,
    };
  }

  // V2 — essential control under any load: thrust identical with every load on and the store hot.
  {
    const base = seg(await sim({ segments: [{ throttle: 1, seconds: 3 }] }), 0);
    const loaded = seg(await sim({ start: { ordinaryKg: 0, protectedKg: 600, heat01: 1.2 }, segments: [{ throttle: 1, mining: true, repair: true, startBatchUnits: 50, seconds: 3 }] }), 0);
    g.v2_essential = { speed: [r4(base.end.speedMps), r4(loaded.end.speedMps)], minThrustScale: loaded.minThrustScale, pass: base.end.speedMps === loaded.end.speedMps && loaded.minThrustScale === 1 };
  }

  // V3 (pure) — batch conserves input/output: kg/unit from the tuning table, full-tank stop keeps the remainder reserved, cancel refunds unstarted units only.
  {
    const full = await sim({ start: { ordinaryKg: 590 }, segments: [{ startBatchUnits: 10, seconds: 6 }, { cancelBatch: true, seconds: 0.5 }] });
    const part = await sim({ start: { ordinaryKg: 0 }, segments: [{ startBatchUnits: 20, seconds: 3.05 }, { cancelBatch: true, seconds: 1 }] });
    const committedPart = seg(part, 0).meter.processedKg;
    g.v3_pureBatch = {
      fullTank: { deliveredKg: r4(seg(full, 0).meter.processedKg), tankFullAtS: r4(seg(full, 0).firstTankFullS), ordinaryKg: r4(seg(full, 0).end.ordinaryKg), refund: seg(full, 1).refundUnits },
      partial: { committedKg: r4(committedPart), refund: seg(part, 1).refundUnits, expectRefund: 20 - Math.ceil(committedPart / T.processingKgPerUnit - 1e-9) },
      pass: near(seg(full, 0).meter.processedKg, 10, 1e-9) && seg(full, 0).end.ordinaryKg === 600 && seg(full, 1).refundUnits === 10 - Math.ceil(10 / T.processingKgPerUnit - 1e-9) &&
        seg(part, 1).refundUnits === 20 - Math.ceil(committedPart / T.processingKgPerUnit - 1e-9) && seg(part, 1).meter.processedKg === 0,
    };
  }

  return { ...g, pass: Object.values(g).every((x) => x.pass) };
}


/** Schema-2 fixture player (fuel, power, processing slices present). */
function m32Player(ctx, o = {}) {
  const { research, ...rest } = ctx.v1Player(o.base ?? {});
  void research;
  return {
    ...rest,
    research: { assaySamples: 0, activeResearch: null },
    propellant: o.propellant ?? { ordinaryKg: 500, protectedKg: 60 },
    power: { capacitor01: 1, heat01: 0 },
    processing: null,
  };
}
const m32World = (ctx, players) => ({ schemaVersion: 2, world: { ...ctx.v1World(), research: { completedNodes: [] }, receipts: [] }, players });

const KEY = {
  w: { key: "w", code: "KeyW", windowsVirtualKeyCode: 87, text: "w" },
  s: { key: "s", code: "KeyS", windowsVirtualKeyCode: 83, text: "s" },
  x: { key: "x", code: "KeyX", windowsVirtualKeyCode: 88, text: "x" },
};
/** Screenshot without waiting for a rendered frame (the settings menu stops the render loop). */
async function shotNow(d, name) {
  const r = await d.send("Page.captureScreenshot", { format: "png" });
  const p = path.join(d.out, `${name}.png`);
  writeFileSync(p, Buffer.from(r.data, "base64"));
  return p;
}

const keyDown = (d, k) => d.send("Input.dispatchKeyEvent", { type: "keyDown", ...KEY[k] });
const keyUp = (d, k) => {
  const { text, ...p } = KEY[k];
  void text;
  return d.send("Input.dispatchKeyEvent", { type: "keyUp", ...p });
};

export async function m32Gates(d, ctx) {
  const { ev, wait, player, world, submit, boot, fixture, me } = ctx;
  const T = await ev(`${R}.tuning()`);
  const batchUnits = Math.max(1, Math.round(160 / T.processingKgPerUnit));
  const st = () => ev(`${R}.state()`);
  const L = {};
  let nSec = 0;
  /** One gate section; a throw is recorded as that section's failure and the run continues. */
  const sec = async (fn) => {
    nSec++;
    try {
      await fn();
    } catch (e) {
      L[`error${nSec}`] = { pass: false, error: String(e?.message ?? e).slice(0, 300) };
      await ev(`${R}.setSettingsOpen(false)`).catch(() => {});
      await ev(`${R}.setLoadingPause(false)`).catch(() => {});
      await ev(`${R}.forceMining(false)`).catch(() => {});
    }
  };
  const id = await fixture("m32", m32World(ctx, { [me]: m32Player(ctx, { base: { cargo: { capacityUnits: 2000, items: { hydrates: 120, fe_ni_metal: 30 } } } }) }));
  await boot(id);
  await d.scene("belt");
  await d.frames(60);
  const recipeId = "hydrate_propellant";

  // Idle live: a parked ship spends nothing (the 60 s case is the pure gate).
  await sec(async () => {
    const a = await st();
    await wait(8000);
    const b = await st();
    L.idleLive = { kg: [a.ordinaryKg, b.ordinaryKg, a.protectedKg, b.protectedKg], steps: b.meter.steps - a.meter.steps, pass: a.ordinaryKg === b.ordinaryKg && a.protectedKg === b.protectedKg && b.meter.steps - a.meter.steps > 500 };
  });

  // Partial batch + cancel: input reserved once, committed output kept, only unstarted units return.
  await sec(async () => {
    const p0 = await player();
    const s1 = await submit({ type: "processing.start", opId: "ps-1", recipeId, units: 20 });
    const s1dup = await submit({ type: "processing.start", opId: "ps-1", recipeId, units: 20 });
    const busy = await ev(`${R}.startProcessing(5)`);
    const p1 = await player();
    await wait(1500);
    const c = await ev(`${R}.cancelProcessing()`);
    const p2 = await player();
    const again = await ev(`${R}.cancelProcessing()`);
    const committed = c.result?.committedKg ?? -1;
    const refund = c.result?.refunded?.hydrates ?? 0;
    L.partialCancel = {
      start: [s1.status, s1dup.status, busy.reason], reservedOut: p0.cargo.items.hydrates - p1.cargo.items.hydrates, committedKg: r4(committed), refund,
      expectRefund: 20 - Math.ceil(committed / T.processingKgPerUnit - 1e-9), tankDelta: r4(p2.propellant.ordinaryKg - p0.propellant.ordinaryKg), again: again.reason, batchAfter: p2.processing,
      pass: s1.status === "accepted" && s1dup.status === "duplicate" && busy.reason === "busy" && p0.cargo.items.hydrates - p1.cargo.items.hydrates === 20 &&
        committed > 0 && refund === 20 - Math.ceil(committed / T.processingKgPerUnit - 1e-9) && p2.cargo.items.hydrates === p0.cargo.items.hydrates - 20 + refund &&
        Math.abs(p2.propellant.ordinaryKg - p0.propellant.ordinaryKg - committed) < 1e-6 && again.reason === "not_active" && p2.processing === null,
    };
  });

  // Full tank: clean stop with the remainder still reserved, a reason, then cancel returns the rest.
  await sec(async () => {
    await ev(`${R}.set({ ordinaryKg: 590 })`);
    const s = await ev(`${R}.startProcessing(10)`);
    await wait(2500);
    const a = await st();
    const c = await ev(`${R}.cancelProcessing()`);
    const full = await ev(`${R}.startProcessing(5)`);
    L.fullTank = {
      start: s.status, ordinaryKg: r4(a.ordinaryKg), tankFull: a.tankFull, active: a.processing.active, committedKg: r4(a.processing.committedKg), reason: a.hud.reason, refund: c.result?.refunded?.hydrates, refusedWhenFull: full.reason,
      pass: s.status === "accepted" && a.ordinaryKg === 600 && a.tankFull && a.processing.active && Math.abs(a.processing.committedKg - 10) < 1e-6 && /Tank full/.test(a.hud.reason ?? "") &&
        c.result?.refunded?.hydrates === 10 - Math.ceil(10 / T.processingKgPerUnit - 1e-9) && full.reason === "tank_full",
    };
  });

  // Lifecycle (V11): a running batch + forced mining beam; nothing advances while paused.
  await sec(async () => {
    await ev(`${R}.set({ ordinaryKg: 100, heat01: 0 })`);
    // ~160 kg of output (it fits the tank, so the batch completes in the reload section).
    const s = await ev(`${R}.startProcessing(${batchUnits})`);
    await ev(`${R}.forceMining(true)`);
    await wait(500);
    const snap = async () => {
      const x = await st();
      return { committed: x.processing.committedKg, work: x.meter.miningWorkS, heat: x.heat01, ord: x.ordinaryKg, steps: x.meter.steps };
    };
    const still = (a, b) => a.committed === b.committed && a.work === b.work && a.heat === b.heat && a.ord === b.ord && a.steps === b.steps;
    const lc = { start: s.status };
    // Settings menu (frameloop "never").
    await ev(`${R}.setSettingsOpen(true)`);
    await wait(300);
    let a = await snap();
    await wait(2000);
    let b = await snap();
    lc.settings = still(a, b);
    await ev(`${R}.setSettingsOpen(false)`);
    // Loading gate (simPause).
    await ev(`${R}.setLoadingPause(true)`);
    await wait(300);
    a = await snap();
    await wait(2000);
    b = await snap();
    lc.loading = still(a, b);
    await ev(`${R}.setLoadingPause(false)`);
    // Hidden tab / long stall: no frame for 3 s (main thread blocked, as rAF stops when hidden);
    // on resume at most MAX_FRAME_DT (0.25 s) executes, no catch-up bill.
    a = await snap();
    await ev("(() => { const t = performance.now(); while (performance.now() - t < 3000) {} })()");
    b = await snap();
    lc.frozen = { committedDeltaKg: r4(b.committed - a.committed), workDeltaS: r4(b.work - a.work), stepsDelta: b.steps - a.steps };
    // Sim rate 1e4 changes ephemeris time only.
    const rate0 = await ev("__test.simRate()");
    await ev("__test.simRate(1e4)");
    a = await snap();
    const t0 = Date.now();
    await wait(2000);
    b = await snap();
    const dtS = (b.steps - a.steps) / 120;
    await ev(`__test.simRate(${rate0})`);
    lc.simRate = { committedPerExecutedS: r4((b.committed - a.committed) / dtS), wallS: r4((Date.now() - t0) / 1000), executedS: r4(dtS) };
    lc.pass = s.status === "accepted" && lc.settings && lc.loading && lc.frozen.stepsDelta <= 40 && lc.frozen.committedDeltaKg < 4 &&
      lc.simRate.committedPerExecutedS < 10.001 && lc.simRate.committedPerExecutedS > 0;
    L.lifecycle = lc;
    await ev(`${R}.forceMining(false)`);
  });

  // Reload mid-batch: output delivered once (ordinary − committed is invariant), no catch-up.
  // Fuel progress is sampled, not urgent: a reload resumes from the last written record.
  await sec(async () => {
    await wait(2500);
    const saved = (await ctx.idb(id)).players[me];
    await d.reload();
    await d.frames(10);
    const after = await player();
    const inv = (p) => p.propellant.ordinaryKg - (p.processing?.committedKg ?? 0);
    let done = null;
    for (let i = 0; i < 40 && !done; i++) {
      await wait(500);
      const x = await st();
      if (!x.processing.active) done = x;
    }
    await wait(2500);
    const fin = await player();
    await d.reload();
    await d.frames(10);
    const fin2 = await player();
    L.reloadBatch = {
      saved: { committed: r4(saved.processing?.committedKg), invariant: r4(inv(saved)) }, after: { committed: r4(after.processing?.committedKg), invariant: r4(inv(after)) },
      finalOrdinaryKg: r4(fin.propellant.ordinaryKg), afterSecondReload: r4(fin2.propellant.ordinaryKg), batch: fin2.processing,
      pass: !!saved.processing && !!after.processing && Math.abs(inv(saved) - 100) < 1e-6 && Math.abs(inv(after) - 100) < 1e-6 &&
        after.processing.committedKg >= saved.processing.committedKg && after.processing.committedKg - saved.processing.committedKg < 5 &&
        !!done && Math.abs(fin.propellant.ordinaryKg - (100 + batchUnits * T.processingKgPerUnit)) < 1e-6 && fin2.propellant.ordinaryKg === fin.propellant.ordinaryKg && fin2.processing === null,
    };
  });

  // Death mid-batch: ordinary fuel + unconverted feedstock to the wreck, protected excluded; recovery.
  await sec(async () => {
    // Die away from the recovery point, or the wreck collector would take the drop straight back.
    await ev(`${G}.nudgeKm(5, 0, 0)`);
    await d.frames(20);
    await ev(`${R}.set({ ordinaryKg: 200 })`);
    const s = await ev(`${R}.startProcessing(30)`);
    await wait(1000);
    const k = await ev(`(() => { const s = ${R}.state(); const c = ${G}.mirrors().cargo.items; const o = ${G}.kill(); return { s, c, o }; })()`);
    const exp = { fuel: k.s.ordinaryKg, hyd: (k.c.hydrates ?? 0) + (k.s.processing.units - Math.ceil(k.s.processing.committedKg / T.processingKgPerUnit - 1e-9)) };
    const w = (await world()).wrecks.find((x) => x.id === k.o?.result?.wreckId);
    const pd = await player();
    await d.reload();
    await d.frames(10);
    const pdr = await player();
    const wr = (await world()).wrecks.find((x) => x.id === w?.id);
    const clicked = await ev(`(() => { const b = document.querySelector(".death-screen__respawn"); if (!b) return false; b.click(); return true; })()`);
    await d.frames(30);
    const pa = await player();
    const sa = await st();
    L.death = {
      start: s.status, wreck: w ? { fuelKg: r4(w.fuelKg), items: w.items } : null, expect: { fuelKg: r4(exp.fuel), hydrates: exp.hyd, protectedKg: k.s.protectedKg },
      dead: { ordinaryKg: pd.propellant.ordinaryKg, processing: pd.processing, cargo: pd.cargo.items }, deadAfterReload: { isDead: pdr.isDead, wreckSame: eq(wr, w), ordinaryKg: pdr.propellant.ordinaryKg },
      recovered: { clicked, isDead: pa.isDead, health: pa.health, propellant: pa.propellant, heat: sa.heat01, runtime: [sa.ordinaryKg, sa.protectedKg] },
      pass: s.status === "accepted" && k.o?.status === "accepted" && !!w && Math.abs(w.fuelKg - exp.fuel) < 1e-9 && w.items.hydrates === exp.hyd &&
        pd.propellant.ordinaryKg === 0 && pd.processing === null && eq(pd.cargo.items, {}) && pdr.isDead && eq(wr, w) && clicked && !pa.isDead &&
        pa.health === sa.maxHealth && pa.propellant.ordinaryKg === 0 && pa.propellant.protectedKg === 60 && sa.ordinaryKg === 0 && sa.protectedKg === 60 && sa.heat01 === 0,
    };
  });

  // Repair: material spent once per percent, stops at max hull / out of material, refuses with a reason; no free regeneration.
  await sec(async () => {
    const hullOf = async () => (await st()).health;
    const waitRepairStop = async () => {
      for (let i = 0; i < 80; i++) {
        await wait(500);
        const x = await st();
        if (!x.req.repair) return x;
      }
      return st();
    };
    await ev("__phys.game.setHealth(50)");
    const refused = await ev(`${R}.repair(true)`);
    const refusal = (await st()).control.refusal;
    await ev(`__dev.grantCargo("fe_ni_metal", 12)`);
    const ok1 = await ev(`${R}.repair(true)`);
    const x1 = await waitRepairStop();
    const p1 = await player();
    await ev(`__dev.grantCargo("fe_ni_metal", 100)`);
    const ok2 = await ev(`${R}.repair(true)`);
    const x2 = await waitRepairStop();
    const p2 = await player();
    // Legacy regeneration module: with no material it repairs nothing; with material it pays per percent.
    await ev(`${G}.jettison("fe_ni_metal")`);
    await ev(`${R}.equip("module_nanite_repair_mk1", "hull")`);
    await ev("__phys.game.setHealth(90)");
    await wait(4000);
    const h0 = await hullOf();
    await ev(`__dev.grantCargo("fe_ni_metal", 3)`);
    await wait(6000);
    const p3 = await player();
    L.repair = {
      refused: [refused, refusal], first: { ok: ok1, health: p1.health, feNi: p1.cargo.items.fe_ni_metal ?? 0, reason: x1.control.refusal },
      second: { ok: ok2, health: p2.health, feNi: p2.cargo.items.fe_ni_metal },
      nanite: { noMaterialHealthAfter4s: h0, withMaterial: { health: r4(p3.health), feNi: p3.cargo.items.fe_ni_metal ?? 0 } },
      pass: refused === false && /Fe-Ni/.test(refusal ?? "") && ok1 && p1.health === 62 && !(p1.cargo.items.fe_ni_metal > 0) && /no Fe-Ni/.test(x1.control.refusal ?? "") &&
        ok2 && p2.health === 100 && p2.cargo.items.fe_ni_metal === 62 && h0 === 90 && p3.health > 90 && Math.round(p3.health - 90) === 3 - (p3.cargo.items.fe_ni_metal ?? 0),
    };
  });

  // Emergency abandonment at zero fuel, far from anything: reachable, confirms, wreck keeps the cargo.
  await sec(async () => {
    await ev(`${G}.nudgeKm(40000, 0, 0)`);
    await d.frames(30);
    await ev(`${R}.set({ ordinaryKg: 0, protectedKg: 0 })`);
    await ev(`__dev.grantCargo("silicates", 7)`);
    await keyDown(d, "w");
    await wait(1500);
    await keyUp(d, "w");
    const drift = await ev(`${R}.nav([0,0,0])`);
    const cargoBefore = (await player()).cargo.items;
    const opened = await ev(`(() => { const b = document.querySelector(".settings__open-button"); if (!b) return false; b.click(); return true; })()`);
    await wait(300);
    const asked = await ev(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "emergency: abandon ship"); if (!b) return false; b.click(); return true; })()`);
    await wait(300);
    const dialog = await ev(`document.querySelector(".settings-menu__abandon")?.textContent ?? null`);
    const shot = await shotNow(d, "m3-abandon-confirm");
    const confirmed = await ev(`(() => { const b = [...document.querySelectorAll(".settings-menu__abandon button")].find((x) => x.textContent.trim() === "abandon ship"); if (!b) return false; b.click(); return true; })()`);
    await wait(500);
    const pd = await player();
    const w = (await world()).wrecks.at(-1);
    const clicked = await ev(`(() => { const b = document.querySelector(".death-screen__respawn"); if (!b) return false; b.click(); return true; })()`);
    await d.frames(30);
    const pa = await player();
    L.emergency = {
      zeroFuelSpeedMps: r4(drift?.speedMps), opened, asked, dialog, shot, confirmed, dead: pd.isDead, wreck: w ? { items: w.items, fuelKg: w.fuelKg } : null, cargoBefore,
      recovered: { clicked, health: pa.health, propellant: pa.propellant },
      pass: drift.speedMps < 0.01 && opened && asked && /Abandon ship\?/.test(dialog ?? "") && confirmed && pd.isDead && !!w && eq(w.items, cargoBefore) && w.fuelKg === 0 &&
        clicked && !pa.isDead && pa.health === 100 && pa.propellant.ordinaryKg === 0 && pa.propellant.protectedKg === 60,
    };
  });
  return { ...L, pass: Object.values(L).every((x) => x.pass) };
}

/** STARTER REACH: from the starting position with only the protected allowance, reach a hydrate rock, mine, process. */
export async function reachGates(d, ctx) {
  const { ev, wait, player, boot, fixture, me } = ctx;
  const st = () => ev(`${R}.state()`);
  const id = await fixture("reach", m32World(ctx, { [me]: m32Player(ctx, { base: { cargo: { capacityUnits: 2000, items: {} } } }) }));
  await boot(id);
  await d.scene("belt");
  await d.frames(30);
  // Recovery state through the real death/recovery operations (empty ordinary tank first, so no
  // fuel wreck sits at the start for the collector to hand back).
  await ev(`${R}.set({ ordinaryKg: 0 })`);
  await ev(`${G}.kill()`);
  await d.frames(5);
  await ev(`(() => document.querySelector(".death-screen__respawn")?.click())()`);
  await d.frames(60);
  const s0 = await st();
  let reach = null;
  for (let i = 0; i < 40; i++) {
    reach = await ev(`${R}.starterReach(5)`);
    if (reach.rocksLoaded > 100) break;
    await wait(500);
  }
  const target = reach.richestWithin25Km[0];
  const out = {
    start: { ordinaryKg: s0.ordinaryKg, protectedKg: s0.protectedKg },
    measurement: {
      rocksLoaded: reach.rocksLoaded, hydrateRocks: reach.hydrateRocks,
      nearestHydrate: reach.nearest[0] && { distKm: r4(reach.nearest[0].distKm), hydrates: reach.nearest[0].hydrates, mineS: r4(reach.nearest[0].mineS) },
      nearestColdMineable: reach.nearestColdMineable[0] && { distKm: r4(reach.nearestColdMineable[0].distKm), hydrates: reach.nearestColdMineable[0].hydrates },
      target: target && { instanceId: target.instanceId, distKm: r4(target.distKm), radiusM: r4(target.radiusM), hydrates: target.hydrates, mineS: r4(target.mineS) },
    },
  };
  if (!target) return { ...out, pass: false };
  // By identity: the field rides Earth, so a stored absolute position goes stale within seconds.
  const tgt = JSON.stringify({ fieldId: target.fieldId, chunkKey: target.chunkKey, instanceId: target.instanceId });
  const standoffKm = Math.max(1.2, (target.radiusM / 1000) * 4);
  // Fly: face the rock (dev aim shortcut; rotation is < 1 % of a hop), full throttle, then throttle down + brake.
  await ev(`${R}.face(${tgt})`);
  await keyDown(d, "w");
  let n = await ev(`${R}.nav(${tgt})`);
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    await wait(100);
    await ev(`${R}.face(${tgt})`);
    n = await ev(`${R}.nav(${tgt})`);
    const v = n.speedMps;
    const stopKm = (v * v) / (2 * 90) / 1000 + (v * 1.2) / 1000;
    if (n.distKm - standoffKm <= stopKm) break;
  }
  await keyUp(d, "w");
  await keyDown(d, "s");
  await keyDown(d, "x");
  for (let i = 0; i < 100; i++) {
    await wait(100);
    n = await ev(`${R}.nav(${tgt})`);
    if (n.speedMps < 0.5) break;
  }
  await wait(2200);
  await keyUp(d, "x");
  await keyUp(d, "s");
  await wait(500);
  n = await ev(`${R}.nav(${tgt})`);
  const s1 = await st();
  out.flight = { arrivedKm: r4(n.distKm), speedMps: r4(n.speedMps), seconds: r4((Date.now() - t0) / 1000), spentKg: r4(s0.protectedKg - s1.protectedKg + s0.ordinaryKg - s1.ordinaryKg), protectedLeftKg: r4(s1.protectedKg) };
  // Mine through MiningSystem: aim, wait for focus, start, wait for the accepted reward.
  await ev(`${R}.face(${tgt})`);
  let m = null;
  for (let i = 0; i < 60; i++) {
    await wait(200);
    m = await ev(`${R}.mining()`);
    if (m.focused && m.targetId === target.instanceId) break;
  }
  await ev(`${R}.startMining()`);
  const tm = Date.now();
  for (let i = 0; i < 150; i++) {
    await wait(200);
    m = await ev(`${R}.mining()`);
    if (!m.mining) break;
  }
  const mineS = (Date.now() - tm) / 1000;
  const cargo = (await player()).cargo.items;
  const hyd = cargo.hydrates ?? 0;
  out.mining = { targetSeen: m?.targetId === target.instanceId || hyd > 0, seconds: r4(mineS), cargo, heatAfter: r4((await st()).heat01) };
  // Process every hydrate unit through the crafting panel's action.
  const p = await ev(`${R}.startProcessing(${Math.max(1, Math.min(hyd, 50))})`);
  // Up to a full tank at 10 kg/s (slower while hot): allow 90 s.
  for (let i = 0; i < 180; i++) {
    await wait(500);
    if (!(await st()).processing.active) break;
  }
  const s2 = await st();
  out.processing = { start: p.status, units: hyd, ordinaryKg: r4(s2.ordinaryKg), protectedKg: r4(s2.protectedKg) };
  const T = await ev(`${R}.tuning()`);
  out.pass = hyd > 0 && p.status === "accepted" && s2.ordinaryKg > s0.ordinaryKg && s2.ordinaryKg >= Math.min(hyd * T.processingKgPerUnit, T.tankKg) - 1e-6 && s1.protectedKg > 0 && out.flight.arrivedKm < 3;
  return out;
}

/** HUD / panel captures. Narrow: run with --size 390x844. */
export async function shotGates(d, ctx, narrow) {
  const { ev, wait, boot, fixture, me } = ctx;
  const id = await fixture("shots", m32World(ctx, { [me]: m32Player(ctx, { base: { cargo: { capacityUnits: 2000, items: { hydrates: 60, fe_ni_metal: 20, silicates: 40 } } } }) }));
  await boot(id);
  await d.scene("belt");
  await d.frames(60);
  await wait(1500);
  const shots = {};
  if (narrow) {
    shots.normalNarrow = await d.shot("m3-hud-normal-narrow");
    return { shots, pass: true };
  }
  shots.normal = await d.shot("m3-hud-normal");
  await ev(`${R}.set({ ordinaryKg: 0, protectedKg: 37 })`);
  await wait(400);
  shots.lowfuel = await d.shot("m3-hud-lowfuel");
  await ev(`${R}.set({ ordinaryKg: 410, protectedKg: 60, heat01: 0.94 })`);
  await ev(`${R}.startProcessing(25)`);
  await wait(400);
  shots.hot = await d.shot("m3-hud-hot");
  await ev(`${R}.set({ heat01: 0.2 })`);
  await d.press("f");
  await wait(800);
  shots.panel = await d.shot("m3-processing-panel");
  await d.press("Escape");
  return { shots, pass: true };
}
