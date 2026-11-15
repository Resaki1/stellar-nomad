/**
 * M1 flight-model gate script (docs/FLIGHT_MODEL_PLAN.md §7, gates 1–8) plus one live leg.
 *
 *   pnpm drive -- --keep run:scripts/drive-examples/flight-trace.mjs
 *   FLIGHT_PARTS=sim  (or live) to run one half.
 *   FLIGHT_PARTS=mouse,camera,reticle,lock  M1b gates (a)-(e); `shots` writes the M1b HUD captures.
 *
 * Gates 1–8 run through `__test.flight.simulate` (real stepShip, fixed dt, live tuning, no
 * rendering), so they do not depend on frame rate or key timing. The live leg holds real keys.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

const parts = (process.env.FLIGHT_PARTS ?? "sim,live").split(",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r3 = (x) => (x === null || x === undefined ? x : +x.toFixed(3));

export default async function flightGates(d) {
  const ev = (js) => d.evaluate(js);
  const sim = (script) => ev(`__test.flight.simulate(${JSON.stringify(script)})`);
  const out = { gates: {}, live: null };

  if (parts.includes("sim")) {
    const T = await ev("__test.flight.tuning()");
    const vLim = await ev("__test.flight.speedLimitMps()");
    const dt = 1 / 120;
    const firstT = (trace, pred) => trace.find(pred)?.t ?? null;
    const g = out.gates;

    // 1. Full throttle from rest → 99% of v_limit within v_limit/a_main + 1 s.
    {
      const r = await sim({ sampleEvery: 1, segments: [{ throttle: 1, seconds: 8 }] });
      const t99 = firstT(r.segments[0].trace, (s) => s.speedMps >= 0.99 * vLim);
      const limit = vLim / T.mainThrustMps2 + 1;
      g.g1_accel = { vLimitMps: r3(vLim), t99s: r3(t99), thresholdS: r3(limit), pass: t99 !== null && t99 <= limit };
    }

    // 2. Brake from v_limit stops within v²/(2·a_retro) + 10%.
    {
      const r = await sim({ sampleEvery: 1, startVelocityBodyMps: [0, 0, vLim], segments: [{ brake: true, seconds: 10 }] });
      const stop = r.segments[0].trace.find((s) => s.speedMps === 0);
      const ideal = (vLim * vLim) / (2 * T.retroThrustMps2);
      g.g2_brake = {
        stopDistM: r3(stop?.distM), stopTimeS: r3(stop?.t), idealM: r3(ideal), thresholdM: r3(ideal * 1.1),
        pass: !!stop && stop.distM <= ideal * 1.1,
      };
    }

    // 3. Full yaw reaches max rate within 0.4 s; released, rotation ends within 0.5 s.
    {
      const r = await sim({ sampleEvery: 1, segments: [{ yaw: 1, seconds: 1 }, { seconds: 1 }] });
      const tMax = firstT(r.segments[0].trace, (s) => s.ratesDegS[1] >= T.maxYawRateDegS * 0.999);
      const t1 = r.segments[1].trace;
      const tStop = firstT(t1, (s) => s.ratesDegS.every((w) => w === 0));
      const tRel = tStop === null ? null : tStop - t1[0].t;
      g.g3_rotation = {
        maxRateDegS: T.maxYawRateDegS, reachedS: r3(tMax), thresholdS: 0.4, stopAfterReleaseS: r3(tRel), stopThresholdS: 0.5,
        pass: tMax !== null && tMax <= 0.4 && tRel !== null && tRel <= 0.5,
      };
    }

    /** 90° yaw turn: hold yaw for N steps (searched so the turn ends at 90°), then release. */
    async function turn90(base, holdThrottle, decoupled, afterS) {
      const run = (n) => sim({
        sampleEvery: 1, startVelocityBodyMps: base,
        segments: [
          { throttle: holdThrottle, decoupled, yaw: 1, steps: n },
          { throttle: holdThrottle, decoupled, seconds: afterS },
        ],
      });
      let lo = 1, hi = 600;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        const r = await run(mid);
        if (r.segments[1].end.headingDeg < 90) lo = mid; else hi = mid;
      }
      const a = await run(lo), b = await run(hi);
      return Math.abs(a.segments[1].end.headingDeg - 90) < Math.abs(b.segments[1].end.headingDeg - 90) ? a : b;
    }

    // 4. Coupled 90° turn at half speed: sideslip < 2° within 1.5 s of the turn ending.
    //    At full speed: peak sideslip > 10°, still recovers (< 2° within 5 s, our threshold).
    {
      const half = await turn90([0, 0, vLim / 2], 0.5, false, 8);
      const full = await turn90([0, 0, vLim], 1, false, 8);
      const recover = (r) => {
        const tr = r.segments[1].trace;
        const tEnd = tr.find((s) => s.ratesDegS.every((w) => w === 0))?.t ?? null;
        if (tEnd === null) return { turnEndS: null, recoverS: null };
        let last = tEnd;
        for (const s of tr) if (s.t >= tEnd && s.sideslipDeg >= 2) last = s.t + dt;
        return { turnEndS: tEnd, recoverS: last - tEnd };
      };
      const peak = (r) => Math.max(r.segments[0].peakSideslipDeg, r.segments[1].peakSideslipDeg);
      const h = recover(half), f = recover(full);
      g.g4_coupledTurn = {
        half: { headingDeg: r3(half.segments[1].end.headingDeg), peakSideslipDeg: r3(peak(half)), recoverS: r3(h.recoverS), thresholdS: 1.5 },
        full: { headingDeg: r3(full.segments[1].end.headingDeg), peakSideslipDeg: r3(peak(full)), peakThresholdDeg: 10, recoverS: r3(f.recoverS), recoverThresholdS: 5 },
        pass: h.recoverS !== null && h.recoverS <= 1.5 && peak(full) > 10 && f.recoverS !== null && f.recoverS <= 5,
      };
    }

    // 5. Decoupled coasting 90° yaw: velocity direction and magnitude unchanged to 1e-9.
    {
      const v0 = 200;
      const turned = await turn90([0, 0, v0], 0, true, 1);
      const steps = turned.segments[0].steps + turned.segments[1].steps;
      const ref = await sim({ startVelocityBodyMps: [0, 0, v0], segments: [{ decoupled: true, steps }] });
      const a = turned.final.velKmps, b = ref.final.velKmps;
      const maxDiff = Math.max(...a.map((x, i) => Math.abs(x - b[i])));
      const magA = Math.hypot(...a), magB = Math.hypot(...b);
      g.g5_decoupled = {
        headingDeg: r3(turned.segments[1].end.headingDeg),
        maxComponentDiffKmps: maxDiff, magnitudeDiffKmps: Math.abs(magA - magB),
        sideslipAfterDeg: r3(turned.segments[1].end.sideslipDeg), threshold: 1e-9,
        pass: maxDiff <= 1e-9 && Math.abs(magA - magB) <= 1e-9,
      };
    }

    // 6. Strafe reaches its limit; released (coupled) lateral speed returns to zero.
    {
      const r = await sim({ sampleEvery: 1, segments: [{ strafeX: 1, seconds: 4 }, { seconds: 4 }] });
      const lim = T.strafeSpeedLimitMps;
      const tReach = firstT(r.segments[0].trace, (s) => s.vBodyMps[0] >= 0.99 * lim);
      const t1 = r.segments[1].trace;
      const tZero = firstT(t1, (s) => s.vBodyMps[0] === 0);
      // Diagonal strafe at full throttle must not push total speed past the limit.
      const diag = await sim({ sampleEvery: 1, segments: [{ throttle: 1, strafeX: 1, strafeY: 1, seconds: 12 }] });
      const diagPeak = Math.max(...diag.segments[0].trace.map((s) => s.speedMps));
      g.g6_strafe = {
        limitMps: lim, peakLateralMps: r3(Math.max(...r.segments[0].trace.map((s) => s.vBodyMps[0]))),
        reach99S: r3(tReach), zeroAfterReleaseS: tZero === null ? null : r3(tZero - t1[0].t),
        diagonalPeakSpeedMps: r3(diagPeak), speedLimitMps: r3(vLim),
        pass: tReach !== null && tZero !== null && diagPeak <= vLim + 1e-6,
      };
    }

    // 7. Boost: higher acceleration and limit while charge lasts; drains and refills on schedule.
    {
      const plain = await sim({ sampleEvery: 1, segments: [{ throttle: 1, seconds: 1 }] });
      const boosted = await sim({
        sampleEvery: 1,
        segments: [{ throttle: 1, boost: true, seconds: 7 }, { throttle: 1, seconds: 12 }],
      });
      const b0 = boosted.segments[0].trace, b1 = boosted.segments[1].trace;
      const at1 = (tr) => tr.find((s) => Math.abs(s.t - 1) < dt / 2).speedMps;
      const accelPlain = at1(plain.segments[0].trace), accelBoost = at1(b0);
      const tEmpty = firstT(b0, (s) => s.boostCharge === 0);
      const rel = b1[0].t;
      const tRefillStart = firstT(b1, (s) => s.boostCharge > 0);
      const tFull = firstT(b1, (s) => s.boostCharge === 1);
      const boostLimit = Math.max(...b0.filter((s) => s.boostCharge > 0).map((s) => s.limitMps));
      const expRefillStart = T.boostRefillDelayS, expFull = T.boostRefillDelayS + T.boostRefillS;
      const near = (x, e) => x !== null && Math.abs(x - e) <= 2 * dt;
      // Boost is a sprint: from rest at throttle 0 it passes the plain limit, then returns to rest.
      const sprint = await sim({ segments: [{ throttle: 0, boost: true, seconds: 4.5 }, { throttle: 0, seconds: 12 }] });
      const sprintPeak = Math.max(...sprint.segments[0].trace.map((x) => x.speedMps));
      const sprintEnd = sprint.segments[1].trace.at(-1).speedMps;
      // Dev speed override (1 km/s): reached at full throttle, and boost still goes past it.
      const over = await sim({ env: { speedLimitOverrideKmps: 1 }, segments: [{ throttle: 1, seconds: 20 }, { throttle: 1, boost: true, seconds: 4 }] });
      const overPlain = Math.max(...over.segments[0].trace.map((x) => x.speedMps));
      const overBoost = Math.max(...over.segments[1].trace.map((x) => x.speedMps));
      g.g7_boost = {
        sprintFromRest: { peakMps: r3(sprintPeak), endMps: r3(sprintEnd) },
        underOverride: { plainMps: r3(overPlain), boostMps: r3(overBoost) },
        speedAt1sMps: { plain: r3(accelPlain), boost: r3(accelBoost) },
        limitMps: { plain: r3(vLim), boost: r3(boostLimit) },
        peakSpeedWhileBoostMps: r3(Math.max(...b0.map((s) => s.speedMps))),
        emptyAtS: r3(tEmpty), expectedEmptyS: T.boostChargeS,
        refillStartAfterReleaseS: tRefillStart === null ? null : r3(tRefillStart - rel), expectedRefillStartS: expRefillStart,
        fullAfterReleaseS: tFull === null ? null : r3(tFull - rel), expectedFullS: expFull,
        pass: near(overPlain, 1000) && overBoost > 1400 && sprintPeak > vLim * 1.05 && sprintEnd === 0 && accelBoost > accelPlain * 1.5 && boostLimit > vLim * 1.4 && Math.max(...b0.map((s) => s.speedMps)) > vLim * 1.05 &&
          near(tEmpty, T.boostChargeS) && near(tRefillStart - rel, expRefillStart) && near(tFull - rel, expFull),
      };
    }

    // 8. Determinism: the same script twice → bit-identical final state.
    {
      const script = {
        sampleEvery: 600,
        segments: [
          { throttle: 1, boost: true, yaw: 0.7, pitch: -0.3, seconds: 3 },
          { throttle: 0.6, roll: 1, strafeX: -1, strafeY: 0.5, seconds: 2 },
          { decoupled: true, throttle: 1, yaw: -1, seconds: 2 },
          { brake: true, seconds: 3 },
        ],
      };
      const a = await sim(script), b = await sim(script);
      g.g8_determinism = { identical: JSON.stringify(a.final) === JSON.stringify(b.final), final: a.final, pass: JSON.stringify(a.final) === JSON.stringify(b.final) };
    }
    out.simPass = Object.values(g).every((x) => x.pass);
  }

  if (parts.includes("live")) {
    // Body-axis velocity from the probe's world velocity + quaternion (right = −X).
    const body = (s) => {
      const [x, y, z, w] = s.ship.quat;
      const rot = (vx, vy, vz) => {
        const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz, iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
        return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
      };
      const f = rot(0, 0, 1), r = rot(-1, 0, 0);
      const v = s.ship.velKmps.map((c) => c * 1000);
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      return { fwdMps: dot(v, f), rightMps: dot(v, r) };
    };
    const angDeg = (a, b) => {
      const dd = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
      return (2 * Math.acos(dd) * 180) / Math.PI;
    };
    await d.scene("earth_650");
    await d.settle();
    const s0 = await d.state();
    await d.hold("w", 1000);
    await sleep(2500);
    const s1 = await d.state();
    const movedM = Math.hypot(...s1.ship.relPosKm.map((v, i) => v - s0.ship.relPosKm[i])) * 1000;
    await d.hold("ArrowRight", 800);
    await sleep(400);
    const s2 = await d.state();
    const turnedDeg = angDeg(s1.ship.quat, s2.ship.quat);
    const strafeHold = d.hold("d", 1500);
    await sleep(1200);
    const s3 = await d.state();
    await strafeHold;
    await d.hold("s", 1200);
    await sleep(6000);
    const s4 = await d.state();
    const s5 = await d.state();
    const b3 = body(s3);
    out.live = {
      throttleAfterW: r3(s1.ship.throttleSetPoint), speedAfterWMps: r3(s1.ship.speedMps), movedM: r3(movedM),
      turnedDeg: r3(turnedDeg),
      strafeRightMps: r3(b3.rightMps),
      restSpeedMps: s4.ship.speedMps, restAngVel: s4.ship.angVelRadS, throttleAfterS: r3(s4.ship.throttleSetPoint),
      relPosStillAtRest: JSON.stringify(s4.ship.relPosKm) === JSON.stringify(s5.ship.relPosKm) || s4.ship.frameId !== s5.ship.frameId,
    };
    out.live.pass = s1.ship.speedMps > 100 && movedM > 100 && turnedDeg > 10 && b3.rightMps > 20 &&
      s4.ship.speedMps === 0 && s4.ship.angVelRadS.every((w) => w === 0);

    if (process.env.FLIGHT_SHOTS) {
      // Captures for a human look: boost at speed, then strafing. HUD numbers need isolate off.
      await ev("__test.isolate(false)");
      await d.hold("w", 2200);
      const boostHold = d.hold("Shift", 3000);
      await sleep(2500);
      await d.canvas("m1-boost");
      await d.shot("m1-boost-hud");
      const sb = await d.state();
      await boostHold;
      const strafe = d.hold("a", 1500);
      await sleep(1000);
      await d.canvas("m1-strafe");
      await d.shot("m1-strafe-hud");
      await strafe;
      await d.press("x");
      await sleep(6000);
      await ev("__test.isolate(true)");
      out.shots = { boostSpeedMps: r3(sb.ship.speedMps), boostCharge: r3(sb.ship.boostCharge) };
    }
  }
  await m1b(d, out);
  return out;
}

// ── M1b: mouse steering, free look, camera rig, reticle ─────────────────────
const DEG = Math.PI / 180;
function rotate(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const fwdOf = (q) => rotate(q, [0, 0, 1]);
const rightOf = (q) => rotate(q, [-1, 0, 0]);
const upOf = (q) => rotate(q, [0, 1, 0]);
/** Turn from q0 to q1 as [yawRight, pitchUp] in q0's axes, degrees. */
function turnDeg(q0, q1) {
  const f = fwdOf(q1);
  const fb = dot3(f, fwdOf(q0)), rb = dot3(f, rightOf(q0)), ub = dot3(f, upOf(q0));
  return [Math.atan2(rb, fb) / DEG, Math.atan2(ub, Math.hypot(fb, rb)) / DEG];
}

async function m1b(d, out) {
  const want = (p) => parts.includes(p);
  if (!["mouse", "camera", "reticle", "lock", "shots"].some(want)) return;
  const ev = (js) => d.evaluate(js);
  const st = () => d.state();
  const frames = (n) => ev(`__test.frames(${n})`);
  const wait = (ms) => ev(`new Promise((r) => setTimeout(r, ${ms}))`);
  /** Inject dx,dy every frame for ms; returns frames injected. */
  const inject = (dx, dy, ms) => ev(`(async () => { const t0 = performance.now(); let n = 0; while (performance.now() - t0 < ${ms}) { __test.input.mouse(${dx}, ${dy}); n++; await __test.frames(1); } return n; })()`);
  const T = await ev("__test.flight.tuning()");
  const C = { lagS: 0.1, flDegPerPx: 0.12, aimDegPerPx: 0.05, travel: 400, curve: 1.5 };
  const resp = (r, dz) => (r <= dz ? 0 : Math.pow(Math.min(1, (r - dz) / (1 - dz)), C.curve));
  const g = (out.m1b = {});
  const fresh = async () => {
    await ev("__test.input.freeLook(null); __test.input.mode('stick'); __test.input.centre(); __test.input.invertPitch(false); __test.input.config({ sensitivity: 1, deadzone: 0.04, autoCentre: false })");
    await d.scene("earth_650");
    await d.settle();
  };
  const restAfter = async (maxMs = 3000) => {
    const t0 = Date.now();
    for (;;) {
      const s = await st();
      if (s.ship.angVelRadS.every((w) => w === 0)) return s;
      if (Date.now() - t0 > maxMs) return s;
      await frames(2);
    }
  };

  // (a) Free look: camera orbits, ship quaternion bit-identical, back < 0.5° within 0.5 s.
  if (want("mouse")) {
    await fresh();
    const s0 = await st();
    await ev("__test.input.freeLook(true)");
    await frames(2);
    const n = await inject(3, -1, 1000);
    const s1 = await st();
    const expYaw = Math.min(170, n * 3 * C.flDegPerPx), expPitch = Math.min(80, n * 1 * C.flDegPerPx);
    const rel = await ev("(async () => { const t0 = performance.now(); __test.input.freeLook(false); const rows = await __test.input.sampleCamera(120); return rows.map((r) => [r.t - t0, r.offsetDeg]); })()");
    const back = rel.find(([, o]) => o < 0.5);
    const s2 = await st();
    g.a_freeLook = {
      framesInjected: n, orbitDeg: s1.camera.orbitDeg.map(r3), expectedDeg: [r3(expYaw), r3(expPitch)], offsetDeg: r3(s1.camera.offsetDeg),
      shipQuatIdentical: JSON.stringify(s0.ship.quat) === JSON.stringify(s1.ship.quat) && JSON.stringify(s1.ship.quat) === JSON.stringify(s2.ship.quat),
      backUnder05DegAfterMs: back ? r3(back[0]) : null, offsetAt500ms: r3(rel.filter(([t]) => t <= 500).at(-1)?.[1]),
    };
    g.a_freeLook.pass = Math.abs(s1.camera.orbitDeg[0] - expYaw) < 0.01 && Math.abs(s1.camera.orbitDeg[1] - expPitch) < 0.01 &&
      g.a_freeLook.shipQuatIdentical && back !== undefined && back[0] <= 500;
    await ev("__test.input.freeLook(null)");

    // (b) Stick: deflection fraction, matching turn, continues off-centre, stops when centred.
    await fresh();
    const q0 = (await st()).ship.quat;
    await ev("__test.input.mouse(200, 0)");
    await frames(2);
    const sa = await st();
    const expStick = 200 / C.travel, expCmd = resp(expStick, 0.04);
    await wait(1000);
    const sb = await st();
    await wait(1500);
    const sc = await st();
    await ev("__test.input.mouse(-200, 0)");
    const sd = await restAfter();
    const expRate = expCmd * T.maxYawRateDegS;
    const rateB = -sb.ship.angVelRadS[1] / DEG, rateC = -sc.ship.angVelRadS[1] / DEG;
    const yawBC = turnDeg(sb.ship.quat, sc.ship.quat)[0];
    // Pitch, then inverted pitch (only pitch flips).
    await fresh();
    await ev("__test.input.mouse(150, -200)");
    await wait(800);
    const sp = await st();
    await ev("__test.input.centre()");
    await restAfter();
    await ev("__test.input.invertPitch(true)");
    await ev("__test.input.mouse(150, -200)");
    await wait(800);
    const spi = await st();
    await ev("__test.input.centre(); __test.input.invertPitch(false)");
    await restAfter();
    const cmdP = resp(Math.hypot(150, 200) / C.travel, 0.04) / (Math.hypot(150, 200) / C.travel);
    const expPitchRate = (200 / C.travel) * cmdP * T.maxPitchRateDegS, expYawRate2 = (150 / C.travel) * cmdP * T.maxYawRateDegS;
    const rates = (s) => [-s.ship.angVelRadS[1] / DEG, -s.ship.angVelRadS[0] / DEG];
    g.b_stick = {
      stick: r3(sa.input.stick[0]), expectedStick: expStick, cmd: r3(sa.input.mouseCmd[0]), expectedCmd: r3(expCmd),
      yawRateDegS: [r3(rateB), r3(rateC)], expectedRateDegS: r3(expRate), turnedRightDeg1p5s: r3(yawBC), expectedTurnDeg: r3(expRate * 1.5),
      stoppedWhenCentred: sd.ship.angVelRadS.every((w) => w === 0),
      yawPitchRates: rates(sp).map(r3), invertedYawPitchRates: rates(spi).map(r3), expectedYawPitch: [r3(expYawRate2), r3(expPitchRate)],
    };
    g.b_stick.pass = Math.abs(sa.input.stick[0] - expStick) < 1e-9 && Math.abs(sa.input.mouseCmd[0] - expCmd) < 1e-9 &&
      Math.abs(rateB - expRate) < 1e-6 && Math.abs(rateC - expRate) < 1e-6 && Math.abs(yawBC - expRate * 1.5) < expRate * 0.1 &&
      q0 && g.b_stick.stoppedWhenCentred &&
      Math.abs(rates(sp)[0] - expYawRate2) < 1e-6 && Math.abs(rates(sp)[1] - expPitchRate) < 1e-6 &&
      Math.abs(rates(spi)[0] - expYawRate2) < 1e-6 && Math.abs(rates(spi)[1] + expPitchRate) < 1e-6;

    // Aim: commanded angle then a self-stop; inverted pitch; cone edge.
    await fresh();
    await ev("__test.input.mode('aim')");
    await frames(3);
    const qa0 = (await st()).ship.quat;
    await ev("__test.input.mouse(200, -100)");
    await wait(2500);
    const sAim = await restAfter();
    const turnA = turnDeg(qa0, sAim.ship.quat);
    await fresh();
    await ev("__test.input.mode('aim'); __test.input.invertPitch(true)");
    await frames(3);
    const qi0 = (await st()).ship.quat;
    await ev("__test.input.mouse(0, -100)");
    await wait(2000);
    const sAimI = await restAfter();
    const turnI = turnDeg(qi0, sAimI.ship.quat);
    await ev("__test.input.invertPitch(false)");
    // Cone: 20 px/frame (≈1°/frame) outruns the 55°/s yaw rate, so the marker rides the 25° edge.
    await fresh();
    await ev("__test.input.mode('aim')");
    await frames(3);
    const qc0 = (await st()).ship.quat;
    const nC = await inject(20, 0, 1500);
    const sStop = await st();
    const sEnd = await restAfter(4000);
    const atStop = turnDeg(qc0, sStop.ship.quat)[0], atEnd = turnDeg(qc0, sEnd.ship.quat)[0];
    const expA = [200 * C.aimDegPerPx, 100 * C.aimDegPerPx];
    g.b_aim = {
      turnDeg: turnA.map(r3), expectedDeg: expA, stopped: sAim.ship.angVelRadS.every((w) => w === 0),
      invertedTurnDeg: turnI.map(r3), expectedInvertedDeg: [0, -100 * C.aimDegPerPx],
      cone: { framesInjected: nC, requestedDeg: r3(nC * 20 * C.aimDegPerPx), turnedWhileMovingDeg: r3(atStop), turnedAfterStopDeg: r3(atEnd - atStop), totalDeg: r3(atEnd), coneDeg: 25, stopped: sEnd.ship.angVelRadS.every((w) => w === 0) },
    };
    g.b_aim.pass = Math.abs(turnA[0] - expA[0]) < 0.15 && Math.abs(turnA[1] - expA[1]) < 0.15 && g.b_aim.stopped &&
      Math.abs(turnI[0]) < 0.15 && Math.abs(turnI[1] + 100 * C.aimDegPerPx) < 0.15 &&
      atStop > 25 && atEnd - atStop <= 25.2 && atEnd < nC * 20 * C.aimDegPerPx && g.b_aim.cone.stopped;
    await ev("__test.input.mode('stick')");
  }

  // (c) Camera lag: steady value = 2·τ·rate, no overshoot, same under CPU throttling; scene snaps.
  if (want("camera")) {
    const lagRun = async (label) => {
      await fresh();
      await ev("__test.input.mouse(400, 0)");
      await wait(1500);
      const steady = await ev("__test.input.sampleCamera(40)");
      const rel = await ev("(async () => { __test.input.mouse(-400, 0); return __test.input.sampleCamera(150); })()");
      const lagY = steady.map((r) => r.lagVecDeg[1]);
      const mean = lagY.reduce((a, b) => a + b, 0) / lagY.length;
      const fps = (steady.length - 1) / ((steady.at(-1).t - steady[0].t) / 1000);
      const after = rel.map((r) => r.lagVecDeg[1]);
      let rises = 0;
      for (let i = 1; i < after.length; i++) if (after[i] > after[i - 1] + 1e-9) rises++;
      await restAfter();
      return { label, fps: r3(fps), steadyLagDeg: r3(mean), spreadDeg: r3(Math.max(...lagY) - Math.min(...lagY)), minAfterDeg: after.length ? +Math.min(...after).toExponential(2) : null, risesAfter: rises, finalDeg: r3(after.at(-1)) };
    };
    const expected = 2 * C.lagS * T.maxYawRateDegS;
    const a = await lagRun("uncapped");
    await d.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    let b;
    try {
      b = await lagRun("cpu-throttle-6x");
    } finally {
      await d.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    }
    // Snap: a capture, then turn + free look, then the same scene again.
    // Two unperturbed captures first: right after the throttled run the first one can still differ.
    const capture = async (reset = true) => {
      if (reset) await fresh();
      else {
        await d.scene("earth_650");
        await d.settle();
      }
      await ev("__test.hud(false)");
      const h = (await ev("__test.image.stats()")).hash;
      await ev("__test.hud(true)");
      const s = await st();
      return { h, quat: s.camera.quat, ev: s.exposure.adaptedEV, offsetDeg: s.camera.offsetDeg, fovDeg: s.camera.fovDeg };
    };
    const c0 = await capture();
    const c1 = await capture();
    await ev("__test.input.mouse(400, 0)");
    await wait(700);
    await ev("__test.input.centre(); __test.input.freeLook(true); __test.input.mouse(200, 50)");
    await frames(5);
    await ev("__test.input.freeLook(null)");
    // settle() accepts eye adaptation within 0.07 EV, and the turn changed its history: the first
    // capture can differ by that alone, so the camera pose is compared exactly and the image after a second settle.
    const c2 = await capture(false);
    const c3 = await capture(false);
    const quatDiff = Math.max(...c1.quat.map((v, i) => Math.abs(v - c2.quat[i])));
    g.c_camera = {
      expectedLagDeg: r3(expected), runs: [a, b], fpsRatio: r3(a.fps / b.fps),
      lagDiffPct: r3((Math.abs(a.steadyLagDeg - b.steadyLagDeg) / a.steadyLagDeg) * 100),
      snap: { captures: [c0, c1, c2, c3].map((c) => ({ hash: c.h, adaptedEV: c.ev, offsetDeg: c.offsetDeg, fovDeg: c.fovDeg })), cameraQuatMaxDiff: quatDiff, imageIdenticalAfterResettle: c3.h === c1.h },
    };
    g.c_camera.pass = [a, b].every((r) => Math.abs(r.steadyLagDeg - expected) / expected < 0.03 && r.minAfterDeg > -0.01 && r.risesAfter === 0) &&
      g.c_camera.lagDiffPct < 3 && quatDiff < 1e-12 && c2.offsetDeg === 0 && c2.fovDeg === c1.fovDeg && c3.h === c1.h;
  }

  // (d) Reticle = projection of the ship's forward through the camera, for several lags and aspects.
  if (want("reticle")) {
    const sizes = [[1280, 720], [390, 844], [1000, 1000]];
    const rows = [];
    const check = (s, label, size) => {
      const r = s.reticle, c = s.camera;
      const f = fwdOf(c.shipRenderQuat);
      const qc = c.quat, qi = [-qc[0], -qc[1], -qc[2], qc[3]];
      const v = rotate(qi, f);
      const t = Math.tan((r.fovDeg * DEG) / 2), aspect = size[0] / size[1];
      const x = (v[0] / -v[2] / (t * aspect) * 0.5 + 0.5) * size[0];
      const y = (0.5 - (v[1] / -v[2] / t) * 0.5) * size[1];
      const err = Math.hypot(x - r.x, y - r.y), domErr = r.dom ? Math.hypot(x - r.dom.x, y - r.dom.y) : null;
      rows.push({ label, size: size.join("x"), lagDeg: r3(c.offsetDeg), expected: [r3(x), r3(y)], reported: [r3(r.x), r3(r.y)], errPx: r3(err), domErrPx: r3(domErr) });
    };
    try {
      for (const size of sizes) {
        await d.send("Emulation.setDeviceMetricsOverride", { width: size[0], height: size[1], deviceScaleFactor: 1, mobile: false });
        await fresh();
        check(await st(), "rest", size);
        await ev("__test.input.freeLook(true); __test.input.mouse(160, -80)");
        await frames(3);
        check(await st(), "freelook 19°/10°", size);
        await ev("__test.input.mouse(-300, 120)");
        await frames(3);
        check(await st(), "freelook -17°/-4°", size);
        await ev("__test.input.freeLook(null)");
        await wait(400);
        await ev("__test.input.mouse(250, -300)");
        await wait(600);
        check(await st(), "turning (spring lag)", size);
        await ev("__test.input.centre()");
        await wait(100);
        check(await st(), "settling", size);
        await restAfter();
      }
    } finally {
      await d.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    }
    // Gaze targeting follows the nose, not screen centre: earth_650 points the nose at Earth.
    await fresh();
    const gaze0 = (await st()).reticle.focusedPoi;
    await ev("__test.input.freeLook(true); __test.input.mouse(170, 0)");
    await frames(5);
    const sG = await st();
    await ev("__test.input.freeLook(null)");
    const gaze = { atRest: gaze0, withCameraOff20Deg: sG.reticle.focusedPoi, cameraOffsetDeg: r3(sG.camera.offsetDeg), reticleX: r3(sG.reticle.x) };
    g.d_reticle = { gaze, rows, maxErrPx: r3(Math.max(...rows.map((r) => r.errPx))), maxDomErrPx: r3(Math.max(...rows.map((r) => r.domErrPx ?? Infinity))) };
    g.d_reticle.pass = rows.every((r) => r.errPx <= 1 && r.domErrPx !== null && r.domErrPx <= 1) && rows.some((r) => r.lagDeg > 5) &&
      gaze.atRest !== null && gaze.withCameraOff20Deg === gaze.atRest;
  }

  // (e) Pointer lock, best effort: headless Chrome may refuse it.
  if (want("lock")) {
    await fresh();
    const before = await ev("__test.input.pointerLock.state()");
    await d.send("Page.bringToFront").catch(() => {});
    await d.click(640, 300);
    await wait(300);
    const afterClick = await ev("__test.input.pointerLock.state()");
    let settingsOpened = null, afterPanel = null;
    let realMove = null;
    if (afterClick.locked) {
      // Trusted CDP mouse motion while locked: does movementX reach the stick?
      for (let i = 1; i <= 10; i++) await d.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640 + i * 10, y: 300 });
      await frames(3);
      realMove = (await st()).input.stick;
      await ev("__test.input.centre()");
      // Unlock the way Esc does (not through our release): the pause menu must open.
      await ev("document.exitPointerLock()");
      await wait(300);
      settingsOpened = await ev("!!document.querySelector('.settings-menu')");
      await d.press("Escape");
      await wait(200);
      await d.click(640, 300);
      await wait(300);
      await d.press("Tab");
      await wait(300);
      afterPanel = await ev("__test.input.pointerLock.state()");
      await d.press("Tab");
      await wait(200);
    }
    g.e_pointerLock = { before, afterClick, stickAfterRealMouseMove: realMove, settingsOpenedOnUserUnlock: settingsOpened, afterPanelOpen: afterPanel };
    g.e_pointerLock.pass = afterClick.locked ? settingsOpened === true && afterPanel && !afterPanel.locked && Math.abs(realMove[0] - 0.25) < 1e-9 : null;
    await wait(300);
    if (await ev("!!document.querySelector('.settings-menu')")) await d.press("Escape");
    await wait(200);
    g.e_pointerLock.settingsOpenAtEnd = await ev("!!document.querySelector('.settings-menu')");
    g.e_pointerLock.panelOpenAtEnd = await ev("__test.input.pointerLock.state().cursorNeeded");
  }

  if (want("shots")) g.shots = await m1bShots(d, ev, st, fresh, wait, frames, restAfter);
}

async function m1bShots(d, ev, st, fresh, wait, frames, restAfter) {
  // d.shot waits for rendered frames, and the settings menu stops the render loop.
  const rawShot = async (name) => {
    const r = await d.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(d.out, `${name}.png`), Buffer.from(r.data, "base64"));
  };
  const clickText = async (selector, text) => {
    const pt = await ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().toLowerCase().startsWith(${JSON.stringify(text)})); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    if (!pt) throw new Error(`no ${selector} "${text}"`);
    await d.click(pt[0], pt[1]);
    await wait(250);
  };
  await ev("__test.isolate(false)");
  try {
    // Stick, mid-turn: marker off-centre, nose leading the lagging camera.
    await fresh();
    await d.hold("w", 1500);
    await ev("__test.input.mouse(150, -60)");
    await wait(900);
    await d.shot("m1-hud-stick");
    await ev("__test.input.centre()");
    await restAfter();
    // Aim: marker placed ahead, ship swinging onto it.
    await ev("__test.input.mode('aim')");
    await frames(3);
    await ev("__test.input.mouse(380, -120)");
    await wait(250);
    await d.shot("m1-hud-aim");
    await restAfter();
    await ev("__test.input.mode('stick')");
    // Free look 60° right.
    await ev("__test.input.freeLook(true); __test.input.mouse(500, -60)");
    await frames(3);
    await d.shot("m1-hud-freelook");
    await ev("__test.input.freeLook(null)");
    await wait(400);
    // Decoupled drift: coast, then turn so velocity is off the nose.
    await d.press("v");
    await d.hold("w", 1200);
    await ev("__test.input.mouse(250, 0)");
    await wait(900);
    await ev("__test.input.centre()");
    await wait(600);
    await d.shot("m1-hud-drift");
    const drift = (await st()).reticle;
    await d.press("v");
    await d.press("x");
    await wait(3000);
    // Narrow: stick deflected at 390x844.
    await d.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    try {
      await fresh();
      await ev("__test.input.mouse(140, -80)");
      await wait(700);
      await d.shot("m1-hud-stick-narrow");
      await ev("__test.input.centre()");
      await restAfter();
    } finally {
      await d.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    }
    await frames(5);
    // Settings → Controls, and Settings → Dev (flight tuning at the top).
    await d.press("Escape");
    await wait(300);
    await clickText(".settings-menu__button", "controls");
    await rawShot("m1-settings-controls");
    await clickText("button", "back");
    await clickText(".settings-menu__button", "dev");
    await rawShot("m1-dev-tuning");
    await d.press("Escape");
    await wait(300);
    return { driftMps: drift.driftMps, velocityMarker: drift.velocity };
  } finally {
    await ev("__test.isolate(true)");
  }
}
