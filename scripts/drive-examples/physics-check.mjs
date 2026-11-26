/**
 * M2a near-field physics gates (docs/PHYSICS_PLAN.md §7.4) for scripts/drive.mjs.
 *
 *   PHYS_PARTS=sim  pnpm drive -- --keep run:scripts/drive-examples/physics-check.mjs
 *   PHYS_PARTS=live,park,switch,transit   (live game, synthetic colliders)
 *   PHYS_PARTS=cost pnpm drive -- --keep --perf run:…   (gate 11, needs --perf)
 *   M2b: PHYS_PARTS=damage,hull (sim + gate 8), asteroids (gate 12 live), stream (--perf), look (captures)
 *   PHYS_PARTS=liveOwner [PHYS_DIFFS=explorer,standard,hard] --no-isolate   B2: fresh world, flag, real W into a rock
 *   PHYS_PARTS=devFlag --no-isolate   B2: stored dev tuning shows "Dev tuning active"; Settings → Dev reset clears it
 *   PHYS_PARTS=starterProxy          shipped proxy hit and clearance checks
 *
 * sim parts run `__test.physics.simulate` (private world + real stepShip, fixed dt): gates
 * 1–4, 6, 7, 9, 10. Analytic ground truth for gate 2 is computed here from the ship hull.
 */
const parts = (process.env.PHYS_PARTS ?? "sim").split(",");
const r4 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? x : +x.toFixed(4));
const len = (v) => Math.hypot(v[0], v[1], v[2]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ── 2D convex geometry for gate 2's ground truth ─────────────────────────────
function hull2d(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1)); // CCW
}
/** Signed distance from point to a CCW convex polygon (< 0 inside). */
function signedDist(poly, x, y) {
  let inside = true, best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    if (ex * (y - a[1]) - ey * (x - a[0]) < 0) inside = false;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / (ex * ex + ey * ey)));
    best = Math.min(best, Math.hypot(a[0] + t * ex - x, a[1] + t * ey - y));
  }
  return inside ? -best : best;
}
/** Same deterministic lumpy hull as src/sim/physics/physicsSim.ts lumpyHullPoints. */
function lumpy(radiusM, lumps = 0.25, seed = 1, n = 42) {
  const hash = (k) => { const s = Math.sin(k * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
  const out = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), th = golden * i;
    const k = radiusM * (1 + lumps * (2 * hash(seed * 1000 + i) - 1));
    out.push(Math.fround(Math.cos(th) * r * k), Math.fround(y * k), Math.fround(Math.sin(th) * r * k));
  }
  return out;
}

export default async function physicsCheck(d) {
  const ev = (js) => d.evaluate(js);
  const sim = async (script) => JSON.parse(await ev(`__test.physics.simulate(${JSON.stringify(script)}).then((r) => JSON.stringify(r))`));
  // Rapier can solve a speculative contact with a real normal velocity change
  // while reporting zero impulse. The backend counts this as a touch as well.
  const touches = (seg) => seg.contacts.filter((c) => c.impulseNs > 0 || c.dvNormalMps > 0.05);
  const out = { gates: {} };
  const g = out.gates;
  const vLim = await ev("__test.flight.speedLimitMps()");
  const phys = await ev("__phys.stats()");
  out.ship = phys.ship;
  out.restitution = 0.2;
  out.friction = 0.5;
  const maxSpeed = phys.maxSpeedMps;

  if (parts.includes("starterProxy")) {
    const checks = [
      { name: "nose", posM: [0, -0.08, 12], velocity: [0, 0, 40], hit: true },
      { name: "port tip", posM: [4.54, -0.08, 12], velocity: [0, 0, 40], hit: true },
      { name: "starboard tip", posM: [-4.54, -0.08, 12], velocity: [0, 0, 40], hit: true },
      { name: "underwing", posM: [3.5, 6, 0], velocity: [0, 25, 0], hit: true },
      { name: "aft nozzle", posM: [1.32, 0.37, -12], velocity: [0, 0, -40], hit: true },
      // Leave room for the engine's 0.2 m speculative-contact distance.
      { name: "outside span", posM: [4.99, -0.08, 12], velocity: [0, 0, 40], hit: false },
      { name: "above wing", posM: [3.35, 0.37, 12], velocity: [0, 0, 40], hit: false },
    ];
    const results = [];
    for (const check of checks) {
      const r = await sim({
        startVelocityBodyMps: check.velocity,
        rocks: [{ kind: "box", posM: check.posM, half: [0.08, 0.08, 0.08] }],
        segments: [{ decoupled: true, seconds: 0.7 }],
      });
      const contact = touches(r.segments[0])[0];
      results.push({ name: check.name, contact: !!contact, expected: check.hit });
    }
    const hitTestsPass = results.every((r) => r.contact === r.expected);
    const pass = phys.ship.source === "mesh" && phys.ship.pieces === 7 && hitTestsPass;
    out.starterProxy = { pass, results };
    if (!pass) throw new Error(`Starter collision coverage failed: ${JSON.stringify(out.starterProxy)}`);
  }

  if (parts.includes("sim")) {
    // 1. Free flight: rock 500 m off the path, 10 s with throttle, turns and a rebase.
    {
      const script = {
        sampleEvery: 1,
        rocks: [{ kind: "ball", radiusM: 30, posM: [500, 0, 300] }],
        segments: [
          { throttle: 1, seconds: 3 }, { throttle: 1, yaw: 0.4, pitch: 0.2, seconds: 2 },
          { throttle: 1, roll: 1, seconds: 2 }, { throttle: 0.5, strafeX: 1, seconds: 3 },
        ],
      };
      const a = await sim(script), b = await sim({ ...script, physics: false });
      let dp = 0, dv = 0, minD = Infinity;
      a.segments.forEach((s, i) => s.trace.forEach((t, k) => {
        const u = b.segments[i].trace[k];
        dp = Math.max(dp, len(sub(t.posM, u.posM)));
        dv = Math.max(dv, len(sub(t.velMps, u.velMps)));
        minD = Math.min(minD, len(sub(t.posM, [500, 0, 300])));
      }));
      g.g1_freeFlight = {
        maxPosDiffM: dp, maxVelDiffMps: dv, closestApproachM: r4(minD), distanceFlownM: r4(len(a.final.posM)),
        physicsSteps: a.counters.stepsPhysics, touchedSteps: a.counters.touchedSteps, rebases: a.counters.rebases,
        pass: dp <= 1e-3 && dv <= 1e-6 && a.counters.stepsPhysics > 0 && a.counters.touchedSteps === 0,
      };
    }

    // 2. Tunnelling: straight at the smallest rock (r 8 m) for 50 lateral offsets.
    {
      const parts = await ev("__phys.shipHullParts()");
      const shipPolys = parts.map((pts) => {
        const xy = [];
        for (let i = 0; i < pts.length; i += 3) xy.push([pts[i], pts[i + 1]]);
        return hull2d(xy);
      });
      const rockPts = lumpy(8);
      const rock2 = [];
      for (let i = 0; i < rockPts.length; i += 3) rock2.push([rockPts[i], rockPts[i + 1]]);
      const rockPoly = hull2d(rock2);
      const mink = shipPolys.map((poly) => hull2d(poly.flatMap((s) => rockPoly.map((r) => [s[0] - r[0], s[1] - r[1]]))));
      const xMax = Math.max(...shipPolys.flat().map((p) => Math.abs(p[0]))) + 10;
      const run = async (speed, kind) => {
        const rows = [];
        for (let i = 0; i < 50; i++) {
          const ox = -xMax * 1.15 + (2 * xMax * 1.15 * i) / 49;
          const D = 200;
          const rock = kind === "ball" ? { kind: "ball", radiusM: 8, posM: [ox, 0, D] } : { kind: "hull", radiusM: 8, posM: [ox, 0, D] };
          const r = await sim({
            sampleEvery: 120, startVelocityBodyMps: [0, 0, speed], rocks: [rock],
            segments: [{ decoupled: true, seconds: (D + 60) / speed + 0.2 }],
          });
          const seg = r.segments[0];
          const truth = kind === "ball"
            ? Math.min(...shipPolys.map((poly) => signedDist(poly, ox, 0))) - 8
            : Math.min(...mink.map((poly) => signedDist(poly, ox, 0)));
          const hit = touches(seg).length > 0;
          const ent = touches(seg)[0];
          rows.push({
            ox, truth, hit, hasNaN: r.hasNaN,
            energyGain: hit ? Math.max(...seg.contacts.map((c) => c.speedAfterMps - c.speedBeforeMps)) : 0,
            finalVz: r.final.velMps[2], finalZ: r.final.posM[2], penetrationM: seg.maxPenetrationM,
            suspended: seg.trace.some((t) => t.suspended !== null), firstDv: ent?.dvNormalMps ?? null,
            clampMps: r.counters.maxEnergyClampMps,
          });
        }
        const AMBIG = 0.02;
        const clear = rows.filter((r) => Math.abs(r.truth) > AMBIG);
        const misses = clear.filter((r) => r.truth < 0 && !r.hit);
        const falseHits = clear.filter((r) => r.truth > 0 && r.hit);
        // Rock centre inside the ship's silhouette (a core hit): the ship must not end up beyond it.
        const throughs = rows.filter((r) => r.truth < -8 && r.finalZ > 200);
        return {
          speedMps: speed, kind, offsets: rows.length, predictedHits: rows.filter((r) => r.truth < 0).length,
          hits: rows.filter((r) => r.hit).length, misses: misses.length, falseHits: falseHits.length,
          ambiguous: rows.length - clear.length, passedThrough: throughs.length,
          maxPenetrationM: r4(Math.max(...rows.map((r) => r.penetrationM))),
          maxEnergyGainMps: r4(Math.max(...rows.map((r) => r.energyGain))),
          maxClampMps: r4(Math.max(...rows.map((r) => r.clampMps))),
          suspendedRuns: rows.filter((r) => r.suspended).length, nan: rows.some((r) => r.hasNaN),
          failures: [...misses, ...falseHits, ...throughs].map((r) => ({ ox: r4(r.ox), truth: r4(r.truth), hit: r.hit })),
        };
      };
      const boosted = vLim * 1.5;
      const under = maxSpeed * 0.99;
      const res = [await run(boosted, "ball"), await run(boosted, "hull"), await run(under, "ball"), await run(under, "hull")];
      g.g2_tunnelling = {
        shipHull2dVertices: shipPolys.reduce((count, poly) => count + poly.length, 0),
        runs: res,
        pass: res.every((r) => r.misses === 0 && r.falseHits === 0 && r.passedThrough === 0 && r.suspendedRuns === 0 && !r.nan),
      };
      out._g2energy = Math.max(...res.map((r) => r.maxEnergyGainMps));
      out._g2clamp = Math.max(...res.map((r) => r.maxClampMps));
    }

    // 3. Head-on at 30 m/s into a big rock (decoupled coast): bounce, e ≈ restitution.
    {
      const r = await sim({
        sampleEvery: 6, startVelocityBodyMps: [0, 0, 30], rocks: [{ kind: "ball", radiusM: 20, posM: [0, 0, 80] }],
        segments: [{ decoupled: true, seconds: 4 }],
      });
      const seg = r.segments[0];
      const c = touches(seg)[0];
      const n = c?.normal ?? [0, 0, -1];
      const vin = dot([0, 0, 30], n), vout = dot(r.final.velMps, n);
      const e = c ? -vout / vin : null;
      g.g3_headOn = {
        contactSteps: touches(seg).length, firstDvNormalMps: r4(c?.dvNormalMps), exitSpeedMps: r4(len(r.final.velMps)),
        restitutionMeasured: r4(e), restitution: 0.2, maxPenetrationM: r4(seg.maxPenetrationM), finalVz: r4(r.final.velMps[2]),
        pass: !!c && r.final.velMps[2] < 0 && Math.abs(e - 0.2) < 0.05 && len(r.final.velMps) <= 30,
      };
    }

    // 4. Glancing at 100 m/s, 10° incidence, flight assist coupled at 100 m/s.
    {
      const R = 300, w = 3.9;
      const reff = R + w, b = reff * Math.sin((80 * Math.PI) / 180);
      const zc = 100 + Math.sqrt(reff * reff - b * b);
      const r = await sim({
        sampleEvery: 1, startVelocityBodyMps: [0, 0, 100], rocks: [{ kind: "ball", radiusM: R, posM: [b, 0, zc] }],
        segments: [{ throttle: 100 / vLim, seconds: 6 }],
      });
      const seg = r.segments[0];
      const t = touches(seg);
      const c0 = t[0];
      const tr = seg.trace;
      const iC = c0 ? tr.findIndex((s) => s.step >= c0.step) : -1;
      const after = iC >= 0 ? tr.slice(iC) : [];
      const pre = iC > 0 ? tr[iC - 1] : tr[0];
      const vAt = (s) => s.velMps;
      const ang = (a, bb) => Math.acos(Math.max(-1, Math.min(1, dot(a, bb) / (len(a) * len(bb))))) * 180 / Math.PI;
      const deflDeg = after.length > 24 ? ang(vAt(pre), vAt(after[24])) : null;
      const peakSpin = Math.max(0, ...after.map((s) => len(s.angVelDegS)));
      // Settled = sideslip under 2° from here on.
      let settle = null;
      for (let k = after.length - 1; k >= 0; k--) {
        if (after[k].sideslipDeg >= 2) { settle = k + 1 < after.length ? after[k + 1].t - after[0].t : null; break; }
        if (k === 0) settle = 0;
      }
      const lastContact = t.length ? t[t.length - 1].t - c0.t : null;
      g.g4_glancing = {
        contactSteps: t.length, lastContactAfterS: r4(lastContact), maxDvNormalMps: r4(Math.max(0, ...t.map((c) => c.dvNormalMps))),
        velocityDeflectionDeg: r4(deflDeg), peakSpinDegS: r4(peakSpin), peakSideslipDeg: r4(Math.max(...after.map((s) => s.sideslipDeg))),
        sideslipUnder2degAfterS: r4(settle), maxPenetrationM: r4(seg.maxPenetrationM),
        pass: !!c0 && deflDeg > 1 && peakSpin > 0.5 && settle !== null && settle <= 3,
      };
    }

    // 6. Resting: full throttle against a rock for 10 s (flat wall and lumpy hull), from three start gaps.
    //    Vibration is kicks that keep reversing. A flat nose settling 0.3° tilted can roll onto another
    //    corner once (MEASURED 2026-11-25: one 0.05 m/s kick, never reversing), which is physics, not chatter;
    //    a moving-mean metric scored that single event as 0.0585 "jitter" and passed or failed by start gap.
    {
      const rest = async (rock, offM) => {
        const probe = await sim({ sampleEvery: 1, startVelocityBodyMps: [0, 0, 1], rocks: [rock], segments: [{ decoupled: true, seconds: 120 }] });
        const pc = touches(probe.segments[0])[0];
        const zTouch = probe.segments[0].trace.find((s) => s.step >= pc.step - 1).posM[2];
        const r = await sim({ sampleEvery: 1, startPosM: [0, 0, zTouch - offM], rocks: [rock], segments: [{ throttle: 1, seconds: 10 }] });
        const tr = r.segments[0].trace;
        const firstTouch = touches(r.segments[0])[0];
        const settled = firstTouch ? tr.filter((s) => s.t >= firstTouch.t + 2) : [];
        const dv = settled.slice(1).map((s, i) => sub(s.velMps, settled[i].velMps));
        let reversals = 0, maxKick = 0;
        for (let k = 1; k < dv.length; k++) {
          maxKick = Math.max(maxKick, len(dv[k]));
          if (len(dv[k - 1]) > 0.01 && len(dv[k]) > 0.01 && dv[k - 1][0] * dv[k][0] + dv[k - 1][1] * dv[k][1] + dv[k - 1][2] * dv[k][2] < 0) reversals++;
        }
        return {
          startGapM: offM, reversals, maxKickMps: r4(maxKick),
          maxSlideMps: r4(Math.max(0, ...settled.map((s) => s.speedMps))),
          maxSpinDegS: r4(Math.max(0, ...settled.map((s) => len(s.angVelDegS)))),
          firstContactS: r4(firstTouch?.t), maxPenetrationM: r4(Math.max(0, ...settled.map((s) => s.penetrationM))),
          nan: r.hasNaN,
        };
      };
      const wallRock = { kind: "box", half: [60, 60, 20], posM: [0, 0, 80] };
      const hullRock = { kind: "hull", radiusM: 60, lumps: 0.2, seed: 5, posM: [0, 0, 80] };
      const wall = [], hull = [];
      for (const off of [0.1, 0.3, 0.7]) {
        wall.push(await rest(wallRock, off));
        hull.push(await rest(hullRock, off));
      }
      const ok = (x) => x.firstContactS !== undefined && x.reversals <= 2 && x.maxKickMps < 0.1 && x.maxSlideMps < 0.5 &&
        x.maxSpinDegS < 3 && x.maxPenetrationM < 0.2 && !x.nan;
      g.g6_resting = { wall, lumpyHull60m: hull, pass: [...wall, ...hull].every(ok) };
    }

    // 6b. Autopilot heading pull (spool phase: desiredForward without transit) survives contact
    //     steps: pressed on a wall, the heading still turns like it does in free space.
    {
      const wallRock = { kind: "ball", radiusM: 200, posM: [0, 0, 220] };
      const probe = await sim({ sampleEvery: 1, startVelocityBodyMps: [0, 0, 1], rocks: [wallRock], segments: [{ decoupled: true, seconds: 60 }] });
      const pc = touches(probe.segments[0])[0];
      const zTouch = probe.segments[0].trace.find((s) => s.step >= pc.step - 1).posM[2];
      const yawDeg = Math.sin(15 * Math.PI / 180), fz = Math.cos(15 * Math.PI / 180);
      const env = { hasDesiredForward: true, desiredForwardX: yawDeg, desiredForwardY: 0, desiredForwardZ: fz, desiredForwardRateRadPerS: 10 * Math.PI / 180 };
      const run = (rocks) => sim({ sampleEvery: 12, startPosM: [0, 0, zTouch - 0.05], rocks, env, segments: [{ throttle: 0.3, seconds: 1 }] });
      const heading = (q) => {
        const [x, y, z, w] = q; // forward = q·(0,0,1)
        const fx = 2 * (x * z + w * y), fzz = 1 - 2 * (x * x + y * y);
        return Math.atan2(fx, fzz) * 180 / Math.PI;
      };
      const a = await run([wallRock]), b = await run([]);
      const ha = heading(a.final.quat), hb = heading(b.final.quat);
      g.g6b_autopilotContact = {
        touchedSteps: a.counters.touchedSteps, headingWithWallDeg: r4(ha), headingFreeDeg: r4(hb),
        pass: a.counters.touchedSteps > 20 && Math.abs(hb) > 5 && Math.abs(ha) >= 0.8 * Math.abs(hb),
      };
    }

    // 7. Energy: no decoupled contact step leaves faster than it entered (gates 2, 3, 9 runs).
    {
      const r = await sim({
        sampleEvery: 12, startVelocityBodyMps: [0, 0, 120],
        rocks: [{ kind: "hull", radiusM: 12, posM: [6, 2, 150], seed: 3 }, { kind: "ball", radiusM: 10, posM: [-30, 0, 400] }],
        segments: [{ decoupled: true, seconds: 6 }],
      });
      const gains = r.segments[0].contacts.map((c) => c.speedAfterMps - c.speedBeforeMps);
      const maxGain = Math.max(out._g2energy ?? 0, ...gains, 0);
      g.g7_energy = {
        contactSteps: gains.length, maxSpeedGainMps: r4(maxGain), clampsThisRun: r.counters.energyClamps,
        maxSolverGainClampedMps: r4(Math.max(r.counters.maxEnergyClampMps, out._g2clamp ?? 0)), pass: maxGain <= 1e-3,
      };
    }

    // 9. Rebase: 10 km past rocks with the threshold at 2 km and at 100 km, far from the frame origin.
    {
      const rocks = [];
      // Wing-tip clips (≈0.5 m overlap) so the ship keeps flying; all beyond the first rebase.
      for (let k = 0; k < 8; k++) rocks.push({ kind: "ball", radiusM: 8, posM: [(k % 2 ? -1 : 1) * 10.4, 0, 2600 + k * 900] });
      const base = { baseKm: [12345.678, -2345.6, 98765.4321], sampleEvery: 12, startVelocityBodyMps: [0, 0, 400], rocks,
        segments: [{ decoupled: true, seconds: 25 }] };
      const a = await sim({ ...base, rebaseKm: 2 }), b = await sim({ ...base, rebaseKm: 100 });
      let dp = 0;
      a.segments[0].trace.forEach((t, k) => (dp = Math.max(dp, len(sub(t.posM, b.segments[0].trace[k].posM)))));
      const ca = touches(a.segments[0]), cb = touches(b.segments[0]);
      const sameContacts = ca.length === cb.length && ca.every((c, i) => c.rock === cb[i].rock && Math.abs(c.step - cb[i].step) <= 1);
      g.g9_rebase = {
        distanceM: r4(len(a.final.posM)), rebases2km: a.counters.rebases, rebases100km: b.counters.rebases,
        contacts2km: ca.length, contacts100km: cb.length, rocksHit: [...new Set(ca.map((c) => c.rock))],
        maxTrajectoryDiffM: r4(dp), finalDiffM: r4(len(sub(a.final.posM, b.final.posM))),
        pass: sameContacts && ca.length > 0 && dp < 0.5 && a.counters.rebases >= 3,
      };
    }

    // 10. Speed gate: over the gate → suspended (a rock in the way is NOT solid, by design);
    //     back under → re-seeded, a rock ahead is solid again; one owner per step.
    {
      const gate = 200;
      const r = await sim({
        sampleEvery: 12, maxSpeedMps: gate,
        rocks: [{ kind: "ball", radiusM: 10, posM: [0, 0, 600] }, { kind: "ball", radiusM: 20, posM: [0, 0, 2050] }],
        segments: [
          { label: "accelerate", throttle: 1, seconds: 4 },
          { label: "brake", brake: true, seconds: 6 },
          { label: "approach", throttle: 30 / vLim, seconds: 10 },
        ],
      });
      const [s0, , s2] = r.segments;
      const over = r.suspensionLog.filter((x) => x.reason === "over-speed").length;
      g.g10_speedGate = {
        gateMps: gate, suspensionLog: r.suspensionLog, reseeds: r.counters.reseeds,
        passedRockWhileSuspended: touches(s0).length === 0 && s0.trace.at(-1).posM[2] > 600,
        hitRockAfterReseed: touches(s2).length > 0, engineColliders: r.engineColliders,
        ownerViolations: r.counters.ownerViolations, stepsPhysics: r.counters.stepsPhysics, stepsAnalytic: r.counters.stepsAnalytic,
        pass: over >= 1 && r.counters.reseeds >= 2 && touches(s2).length > 0 && r.counters.ownerViolations === 0 &&
          r.engineColliders.start === r.engineColliders.end,
      };
    }
  }

  // ── Live game, synthetic colliders ──────────────────────────────────────────
  const state = () => d.state();
  // M2a's synthetic parts test contact physics; M2b damage would kill the ship mid-gate (200 m/s).
  if (await ev("__phys.game.isDead()")) { await ev("__phys.game.respawn()"); await d.frames(30); }
  await ev("__phys.tuning.set({ noDamageSpeedMps: 1e5, lethalSpeedMps: 2e5 })");
  const clearDev = () => ev("__phys.dev.clear()");

  if (parts.includes("live")) {
    // Fly into a synthetic rock at ~20 m/s; it must stop/bounce the ship.
    await ev("__test.simRate(0)");
    await d.scene("earth:4000:horizon");
    await d.settle(1500);
    await clearDev();
    await ev("__phys.dev.add({ kind: 'ball', radiusM: 12, aheadM: 90 })");
    await d.frames(5);
    await ev("__phys.drainContacts()");
    const c0 = (await ev("__phys.stats()")).counters;
    await d.canvas("phys_live_before");
    await d.hold("w", 100); // throttle 0.05 ≈ 20 m/s set-point
    const rows = [];
    let shotTaken = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 9000) {
      await ev("new Promise((r) => setTimeout(r, 100))");
      const s = (await state()).ship;
      const dev = await ev("__phys.dev.list()");
      rows.push({ t: (Date.now() - t0) / 1000, speedMps: s.speedMps, distM: dev[0]?.distanceM ?? null, touched: (await ev("__phys.stats()")).counters.touchedSteps });
      if (!shotTaken && dev[0]?.distanceM < 20) { await d.canvas("phys_live_contact"); shotTaken = true; }
    }
    await d.canvas("phys_live_after");
    const c1 = (await ev("__phys.stats()")).counters;
    const contacts = await ev("__phys.drainContacts()");
    await d.press("x");
    const minDist = Math.min(...rows.map((r) => r.distM));
    out.live = {
      peakSpeedMps: r4(Math.max(...rows.map((r) => r.speedMps))),
      minCentreDistM: r4(minDist), rockRadiusM: 12,
      touchedSteps: c1.touchedSteps - c0.touchedSteps,
      firstContact: contacts.find((c) => c.impulseNs > 0) ?? null,
      track: rows.filter((_, i) => i % 5 === 0).map((r) => ({ t: r4(r.t), speed: r4(r.speedMps), dist: r4(r.distM), touched: r.touched })),
      captures: ["phys_live_before", "phys_live_contact", "phys_live_after"],
      pass: c1.touchedSteps > c0.touchedSteps && minDist > 12,
    };
    await clearDev();
  }

  if (parts.includes("park")) {
    // Gate 9b: parked beside a rock at sim rate 1e4: no contact, no drift.
    await ev("__test.simRate(0)");
    await d.scene("earth:4000:horizon");
    await d.frames(20);
    await clearDev();
    await ev("__phys.dev.add({ kind: 'hull', radiusM: 10, aheadM: 0, rightM: 17 })");
    await d.frames(5);
    const s0 = (await state()).ship;
    const c0 = (await ev("__phys.stats()")).counters;
    await ev("__test.simRate(1e4)");
    await ev("new Promise((r) => setTimeout(r, 3000))");
    const s1 = (await state()).ship;
    const st = await ev("__phys.stats()");
    await ev("__test.simRate(0)");
    out.park = {
      frameId: s1.frameId, absMovedKm: r4(len(sub(s1.posKm, s0.posKm))),
      relBitIdentical: s0.relPosKm.every((v, i) => v === s1.relPosKm[i]),
      physicsSteps: st.counters.stepsPhysics - c0.stepsPhysics, touched: st.counters.touchedSteps - c0.touchedSteps,
      pass: s0.relPosKm.every((v, i) => v === s1.relPosKm[i]) && st.counters.touchedSteps === c0.touchedSteps &&
        st.counters.stepsPhysics > c0.stepsPhysics,
    };
    await clearDev();
  }

  if (parts.includes("switch")) {
    // Gate 9c: a rock placed in Earth's frame, hit after the ship crosses into Luna's frame.
    await ev("__test.simRate(0)");
    const soi = (await ev("__test.frameList()")).find((f) => f.id === "luna").soiKm;
    const lunaR = 1737;
    await d.scene(`luna:${soi + 0.4 - lunaR}:body`);
    await d.frames(20);
    await clearDev();
    const start = (await state()).ship;
    await ev("__phys.dev.add({ kind: 'ball', radiusM: 15, aheadM: 1400 })");
    await ev("__phys.drainContacts()");
    const c0 = (await ev("__phys.stats()")).counters;
    await d.hold("w", 1000); // throttle 0.5 ≈ 200 m/s
    const rows = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 16000) {
      await ev("new Promise((r) => setTimeout(r, 100))");
      const s = (await state()).ship;
      const dev = (await ev("__phys.dev.list()"))[0];
      rows.push({ frameId: s.frameId, distM: dev.distanceM, driftM: dev.engineDriftM, speed: s.speedMps });
      if (s.frameId !== start.frameId && s.speedMps < 5 && dev.distanceM < 40) break;
    }
    const c1 = (await ev("__phys.stats()")).counters;
    const contacts = (await ev("__phys.drainContacts()")).filter((c) => c.impulseNs > 0);
    await d.press("x");
    const iSw = rows.findIndex((r) => r.frameId !== start.frameId);
    const minDist = Math.min(...rows.map((r) => r.distM));
    const driftAfter = Math.max(...rows.slice(Math.max(0, iSw)).map((r) => r.driftM ?? 0));
    out.switch = {
      startFrame: start.frameId, endFrame: rows.at(-1).frameId, switchedAtSample: iSw, samples: rows.length,
      distAtSwitchM: iSw > 0 ? r4(rows[iSw].distM) : null,
      reseeds: c1.reseeds - c0.reseeds, touchedSteps: c1.touchedSteps - c0.touchedSteps,
      firstContactSpeedMps: r4(contacts[0]?.speedBeforeMps), minCentreDistM: r4(minDist), expectedMinM: r4(15 + 3.44),
      maxEngineDriftAfterSwitchM: r4(driftAfter),
      pass: iSw > 0 && rows[iSw].distM > 50 && contacts.length > 0 && minDist > 15 && c1.reseeds > c0.reseeds && driftAfter < 0.01,
    };
    await clearDev();
  }

  if (parts.includes("transit")) {
    // Gate 10 live: transit and the dev speed override suspend; colliders return to baseline.
    await ev("__test.simRate(0)");
    await d.scene("luna:100000");
    await d.frames(30);
    await clearDev();
    for (let i = 0; i < 5; i++) await ev(`__phys.dev.add({ kind: 'hull', radiusM: 10, aheadM: ${-300 - i * 50}, rightM: 200 })`);
    await d.frames(5);
    const base = await ev("__phys.stats()");
    await ev("__bench.maxSpeed(50000)");
    await d.frames(10);
    const devSpeed = (await ev("__phys.stats()")).suspended;
    await ev("__bench.maxSpeed(null)");
    await d.frames(10);
    const afterDev = await ev("__phys.stats()");
    const eng = await ev('__test.transitTo("luna")');
    await d.frames(5);
    const during = await ev("__phys.stats()");
    const t0 = Date.now();
    let phase = "accelerating";
    while (Date.now() - t0 < 100_000) {
      phase = (await state()).transit.phase;
      if (phase === "idle") break;
      await ev("new Promise((r) => setTimeout(r, 250))");
    }
    await d.frames(10);
    const after = await ev("__phys.stats()");
    out.transit = {
      baseline: { colliders: base.colliders, dev: base.collidersByTag.dev ?? 0, engine: base.engineColliders, suspended: base.suspended },
      devSpeedSuspended: devSpeed, afterDevSpeed: afterDev.suspended, engaged: eng.engaged,
      duringTransit: during.suspended, endPhase: phase,
      after: { colliders: after.colliders, dev: after.collidersByTag.dev ?? 0, engine: after.engineColliders, suspended: after.suspended },
      reseeds: after.counters.reseeds - base.counters.reseeds, suspensions: after.counters.suspensions - base.counters.suspensions,
      ownerViolations: after.counters.ownerViolations,
      pass: devSpeed === "dev-speed" && afterDev.suspended === null && during.suspended === "transit" && after.suspended === null &&
        // Real asteroid colliders (M2b) come and go with the ship's position; compare the dev ones.
        (after.collidersByTag.dev ?? 0) === (base.collidersByTag.dev ?? 0) && after.engineColliders === after.colliders &&
        after.counters.reseeds >= base.counters.reseeds + 2 && after.counters.ownerViolations === 0,
    };
    await clearDev();
  }

  if (parts.includes("foreign")) {
    // A collider registered in the system frame while the ship is in a body frame must track
    // the frame's motion every step, not only at re-anchor. Drift is bounded by one frame of the
    // frames' relative motion (~30 km/s × frame dt); unrefreshed it grows ~30 km per second.
    await d.scene("earth:4000:horizon");
    await d.settle(1500);
    await clearDev();
    await ev("__test.simRate(1)"); // frames must move relative to each other
    await d.frames(10);
    await ev("__phys.dev.add({ aheadM: 1500, radiusM: 10 })");
    const id = await ev("__phys.dev.add({ aheadM: 1500, rightM: 100, radiusM: 10, systemFrame: true })");
    const samples = [];
    for (let k = 0; k < 6; k++) {
      await d.frames(30);
      const l = await ev("__phys.dev.list()");
      const st = await ev("__phys.stats()");
      samples.push({ distM: r4(l.find((x) => x.id === id)?.distanceM), engineDriftM: r4(l.find((x) => x.id === id)?.engineDriftM), frame: st.origin.frameId, owner: st.lastOwner });
    }
    const maxDrift = Math.max(...samples.map((x) => x.engineDriftM ?? Infinity));
    await ev("__test.simRate(0)");
    out.foreign = { shipFrame: samples[0].frame, samples, maxEngineDriftM: maxDrift, pass: samples[0].frame !== "system" && maxDrift < 2000 };
    await clearDev();
  }

  if (parts.includes("cost")) {
    // Gate 11: physics.step per rendered frame (CPU), parked; needs --perf for the profiler.
    await ev("__test.simRate(0)");
    await d.scene("earth:4000:horizon");
    await d.settle(1500);
    await clearDev();
    const measure = async (label) => {
      await d.frames(30);
      await ev("__phys.perf.reset()");
      await d.frames(240);
      const p = await ev("__phys.perf.step()");
      const st = await ev("__phys.stats()");
      return { label, colliders: st.colliders, owner: st.lastOwner, frames: p?.n, meanMs: r4(p?.mean), p50Ms: r4(p?.p50), p95Ms: r4(p?.p95), maxMs: r4(p?.max) };
    };
    const rows = [await measure("0 colliders (no step)")];
    await ev("__phys.dev.scatter(1, { minM: 1800, maxM: 1900 })");
    rows.push(await measure("1 far collider (ship body only)"));
    await clearDev();
    const c200 = await ev("__phys.dev.scatter(200)");
    rows.push(await measure("200 hulls"));
    await clearDev();
    const c2000 = await ev("__phys.dev.scatter(2000)");
    rows.push(await measure("2000 hulls"));
    // Re-seed / rebase repositions every collider inside one step: worst of 5 forced re-seeds.
    await ev("__phys.dev.reseed(true)");
    for (let k = 0; k < 4; k++) { await d.frames(10); await ev("__phys.dev.reseed()"); }
    await d.frames(10);
    const reanchorMs2000 = (await ev("__phys.stats()")).counters.maxReanchorMs;
    await clearDev();
    const balls = await ev("__phys.dev.scatter(2000, { kind: 'ball' })");
    rows.push(await measure("2000 balls"));
    await clearDev();
    out.cost = {
      perfEnabled: await ev("__phys.perf.enabled()"), rows,
      createMs: { hulls200: r4(c200.ms), hulls2000: r4(c2000.ms), balls2000: r4(balls.ms) },
      reanchorMaxMs2000: r4(reanchorMs2000),
      pass: rows[1].meanMs !== null && rows[1].meanMs < 0.1,
    };
  }

  await ev("__phys.tuning.set({ noDamageSpeedMps: 8, lethalSpeedMps: 120 })");
  await m2b(d, parts, out, { ev, sim, state, vLim });

  out.pass = Object.values(g).every((x) => x.pass) &&
    ["live", "park", "switch", "transit", "foreign", "cost", "damage", "hull", "asteroids", "stream", "look", "liveOwner", "devFlag"].every((k) => !out[k] || out[k].pass);
  delete out._g2energy;
  delete out._g2clamp;
  return out;
}

// ── M2b: asteroid colliders, contact response and damage (docs/PHYSICS_PLAN.md §7.2–7.4) ──────

const sleep = (ev, ms) => ev(`new Promise((r) => setTimeout(r, ${ms}))`);

/** Warp into the first field and pick a loaded rock with radius in [minR, maxR]. */
async function pickRock(d, ev, minR = 20, maxR = 300, exclude = []) {
  await ev("__phys.asteroids.warpToField()");
  await d.frames(90);
  for (let k = 0; k < 20; k++) {
    const rs = (await ev("__phys.asteroids.nearest(200)")).filter((r) => r.radiusM >= minR && r.radiusM <= maxR && !exclude.includes(r.instanceId));
    if (rs.length) return rs[0];
    await d.frames(30);
  }
  throw new Error("no suitable rock loaded");
}

/** Stand off from a rock and wait for its hull collider. */
async function standoff(d, ev, id, distM) {
  await ev(`__phys.asteroids.standoff(${id}, ${distM})`);
  for (let k = 0; k < 60; k++) {
    await d.frames(5);
    const st = await ev(`__phys.asteroids.state(${id})`);
    if (st.collider?.kind === "hull" && st.collider.inEngine) return st;
  }
  return ev(`__phys.asteroids.state(${id})`);
}

/** Fly at the rock until an impact is logged (or timeout); returns samples + impacts. */
async function approach(d, ev, state, id, holdMs, timeoutMs, stopAt = null) {
  await ev("__phys.impacts.clear()");
  await d.hold("w", holdMs);
  const t0 = Date.now();
  const rows = [];
  let impacts = [];
  while (Date.now() - t0 < timeoutMs) {
    await sleep(ev, 50);
    const s = (await state()).ship;
    rows.push({ t: (Date.now() - t0) / 1000, speed: s.speedMps, vel: s.velKmps.map((v) => v * 1000), posKm: s.posKm });
    if (stopAt && stopAt(s)) break;
    impacts = await ev("__phys.impacts.log()");
    if (impacts.length) {
      // Velocity right after the hit, then throttle to zero so the assist does not drive back in.
      const sa = (await state()).ship;
      rows.push({ t: (Date.now() - t0) / 1000, speed: sa.speedMps, vel: sa.velKmps.map((v) => v * 1000), afterImpact: true });
      if (!(await ev("__phys.game.isDead()"))) await d.hold("s", 400);
      await sleep(ev, 400);
      break;
    }
  }
  return { rows, impacts: await ev("__phys.impacts.log()"), counters: await ev("__phys.impacts.counters()") };
}

async function m2b(d, parts, out, { ev, sim, state, vLim }) {
  const r4 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? x : +x.toFixed(4));
  const curve = (dv) => (dv <= 8 ? 0 : Math.min(1, ((dv - 8) / 112) ** 2));

  if (parts.includes("damage")) {
    const models = await ev("__phys.asteroids.models()");
    const one = async (label, script) => {
      const r = await sim(script);
      const im = r.impacts;
      const contactSteps = r.segments.reduce((n, sg) => n + sg.contacts.filter((c) => c.impulseNs > 0).length, 0);
      return {
        label, impacts: im.map((x) => ({ t: r4(x.t), dvMps: r4(x.dvMps), damagePct: r4(x.damageFrac * 100), curvePct: r4(curve(x.dvMps) * 100), contacts: x.contacts })),
        contactSteps, contactEvents: r.damage.contactEvents, damageApplications: r.damage.damageApplications,
        totalDamagePct: r4(r.damage.totalFrac * 100), lethal: r.damage.lethal, exitSpeedMps: r4(Math.hypot(...r.final.velMps)), nan: r.hasNaN, rockShapes: r.rockShapes,
      };
    };
    const headOn = await one("30 m/s head-on", { sampleEvery: 12, startVelocityBodyMps: [0, 0, 30], rocks: [{ kind: "ball", radiusM: 20, posM: [0, 0, 80] }], segments: [{ decoupled: true, seconds: 4 }] });
    // Glancing as M2a gate 4: 10° incidence on a 300 m rock, assist coupled at 100 m/s.
    const R = 300, w = 3.9, reff = R + w, b = reff * Math.sin((80 * Math.PI) / 180), zc = 100 + Math.sqrt(reff * reff - b * b);
    const glancing = await one("100 m/s at 10°", { sampleEvery: 12, startVelocityBodyMps: [0, 0, 100], rocks: [{ kind: "ball", radiusM: R, posM: [b, 0, zc] }], segments: [{ throttle: 100 / vLim, seconds: 6 }] });
    const lethal = await one("200 m/s head-on", { sampleEvery: 12, startVelocityBodyMps: [0, 0, 200], rocks: [{ kind: "ball", radiusM: 50, posM: [0, 0, 300] }], segments: [{ decoupled: true, seconds: 3 }] });
    const bump = await one("5 m/s head-on", { sampleEvery: 12, startVelocityBodyMps: [0, 0, 5], rocks: [{ kind: "ball", radiusM: 20, posM: [0, 0, 40] }], segments: [{ decoupled: true, seconds: 8 }] });
    // 60 m/s was solved by a zero-impulse speculative manifold and went undamaged before the Δv fallback.
    const headOn60 = await one("60 m/s head-on", { sampleEvery: 12, startVelocityBodyMps: [0, 0, 60], rocks: [{ kind: "ball", radiusM: 20, posM: [0, 0, 80] }], segments: [{ decoupled: true, seconds: 3 }] });
    const wingtip60 = await one("60 m/s wing-tip", { sampleEvery: 12, startVelocityBodyMps: [0, 0, 60], rocks: [{ kind: "ball", radiusM: 20, posM: [21, 0, 80] }], segments: [{ decoupled: true, seconds: 3 }] });
    // Real model hull for the head-on too (the curve must not depend on the shape).
    const headOnHull = await one("30 m/s head-on, asteroid_01 hull", { sampleEvery: 12, startVelocityBodyMps: [0, 0, 30], rocks: [{ kind: "model", modelId: models[0].modelId, radiusM: 60, posM: [0, 0, 130] }], segments: [{ decoupled: true, seconds: 6 }] });
    // Gate 6 with damage: full throttle into a real-shaped hull for 10 s.
    const rest = await (async () => {
      const rock = { kind: "model", modelId: models[0].modelId, radiusM: 80, posM: [0, 0, 160] };
      const probe = await sim({ sampleEvery: 1, startVelocityBodyMps: [0, 0, 2], rocks: [rock], segments: [{ decoupled: true, seconds: 120 }] });
      const pc = probe.segments[0].contacts.find((c) => c.impulseNs > 0);
      const zTouch = probe.segments[0].trace.find((s) => s.step >= pc.step - 1).posM[2];
      // Start touching (the step before the probe's contact), so no approach bump precedes the push.
      const r = await sim({ sampleEvery: 6, startPosM: [0, 0, zTouch], rocks: [rock], segments: [{ throttle: 1, seconds: 10 }] });
      const seg = r.segments[0];
      return {
        contactSteps: seg.contacts.filter((c) => c.impulseNs > 0).length, contactEvents: r.damage.contactEvents, impacts: r.damage.impacts,
        maxDvPerStepMps: r4(Math.max(0, ...seg.contacts.map((c) => c.dvNormalMps))), damageApplications: r.damage.damageApplications,
        totalDamagePct: r4(r.damage.totalFrac * 100), maxPenetrationM: r4(seg.maxPenetrationM), finalSpeedMps: r4(Math.hypot(...r.final.velMps)), nan: r.hasNaN,
      };
    })();
    const once = (x) => x.damageApplications <= 1;
    out.damage = {
      curve: "100% · ((Δv − 8) / 112)², Δv = ship velocity change along the normal",
      headOn, headOnHull, headOn60, wingtip60, glancing, lethal, bump, resting: rest,
      pass: headOn.damageApplications === 1 && Math.abs(headOn.impacts[0].damagePct - headOn.impacts[0].curvePct) < 1e-6 && headOn.contactEvents >= 1 &&
        headOnHull.damageApplications === 1 &&
        // The winged hull can clip a wing, spin, then hit nose-first inside one episode (MEASURED 2026-11-25:
        // 20.2 then 35.0 m/s, 0.15 s apart): the episode may charge twice but its total is curve(peak), once.
        glancing.damageApplications >= 1 && Math.abs(glancing.totalDamagePct - Math.max(...glancing.impacts.map((i) => i.curvePct))) < 0.01 &&
        glancing.impacts.every((x, i) => i === 0 || x.dvMps > glancing.impacts[i - 1].dvMps) &&
        glancing.totalDamagePct > 0 && glancing.totalDamagePct < 10 && !glancing.lethal &&
        lethal.lethal && bump.damageApplications === 0 && rest.damageApplications === 0 && rest.totalDamagePct === 0 && !rest.nan &&
        headOn60.damageApplications === 1 && Math.abs(headOn60.impacts[0].damagePct - headOn60.impacts[0].curvePct) < 1e-6 && wingtip60.damageApplications === 1 &&
        [headOn, headOnHull, headOn60, wingtip60, lethal].every(once),
    };
  }

  if (parts.includes("hull")) {
    // Gate 8: (a) per model, 26 directions, engine hull vs LOD1 mesh; (b) live instances, engine
    // collider pose/scale/support vs the near tier's GPU slot + uniforms.
    await ev("__test.simRate(0)");
    const fid = await ev("__phys.asteroids.hullFidelity()");
    const rock = await pickRock(d, ev, 10, 2000);
    await standoff(d, ev, rock.instanceId, 200);
    await ev("__phys.tuning.set({ physicsRadiusKm: 20 })");
    await d.frames(200);
    const tf = await ev("__phys.asteroids.transforms(12)");
    await ev("__phys.tuning.set({ physicsRadiusKm: 3 })");
    await d.frames(10);
    const worst = (k) => Math.max(0, ...tf.map((x) => x[k]));
    out.hull = {
      perModel: fid.map((m) => ({ modelId: m.modelId, meshPoints: m.meshPoints, worstSupportRelErr: m.worstRelErr, lod0RadiusM: m.info.lod0RadiusM, lod1RadiusM: m.info.lod1RadiusM })),
      instances: tf.length, worstPosErrCm: worst("posErrCm"), worstAngleErrDeg: worst("angleErrDeg"), worstScaleRelErr: worst("scaleRelErr"), worstSupportRelErr: worst("supportWorstRelErr"),
      sample: tf.slice(0, 5),
      pass: fid.every((m) => m.worstRelErr < 0.05) && tf.length >= 5 && worst("posErrCm") < 1 && worst("angleErrDeg") < 0.1 && worst("supportWorstRelErr") < 0.05,
    };
  }

  if (parts.includes("asteroids")) {
    // Gate 12 live: real rocks. 20 m/s bounce + damage, rock stays; 300 m/s death + wreck; destroy → passable.
    await ev("__test.simRate(0)");
    const gameState = async () => ({ health: await ev("__phys.game.health()"), dead: await ev("__phys.game.isDead()") });
    const rock = await pickRock(d, ev, 25, 300);
    const id = rock.instanceId;
    const st0 = await standoff(d, ev, id, 120);
    await ev("__phys.game.setHealth(__phys.game.health().max)");
    await ev("__phys.drainContacts()");
    const slow = await approach(d, ev, state, id, 100, 15000);
    // A speculative/CCD-resolved hit carries Δv with zero solver impulse (MEASURED 2026-11-25: impulse 0,
    // Δv_n 20.4 m/s at 23 m/s), so count a contact the way `touches` does.
    const firstContact = (await ev("__phys.drainContacts()")).find((c) => c.impulseNs > 0 || c.dvNormalMps > 0.05);
    await d.press("x");
    await d.frames(30);
    const stAfter = await ev(`__phys.asteroids.state(${id})`);
    const h1 = await gameState();
    const imp = slow.impacts[0];
    const vIn = slow.rows.reduce((m, r) => Math.max(m, r.speed), 0);
    const bounced = slow.rows.find((r) => r.afterImpact)?.vel ?? null;
    // Normal velocity (away from the rock > 0) before and after the contact step. The assist re-thrusts
    // at the held set-point within ~50 ms, so the sampled velocity cannot show the bounce; the step can.
    const preVel = slow.rows.filter((r) => !r.afterImpact).reduce((m, r) => (!m || r.speed > m.speed ? r : m), null)?.vel;
    const nrm = firstContact ? [firstContact.nx, firstContact.ny, firstContact.nz] : null;
    const vnBefore = preVel && nrm ? preVel[0] * nrm[0] + preVel[1] * nrm[1] + preVel[2] * nrm[2] : null;
    const vnAfter = vnBefore !== null ? vnBefore + firstContact.dvNormalMps : null;
    const towardRock = bounced && preVel ? (preVel[0] * bounced[0] + preVel[1] * bounced[1] + preVel[2] * bounced[2]) / Math.hypot(...preVel) : null;
    out.asteroids = { rock: { id, modelId: rock.modelId, radiusM: rock.radiusM, colliderBefore: st0.collider } };
    out.asteroids.slow = {
      approachSpeedMps: r4(vIn), impacts: slow.impacts.length, dvMps: r4(imp?.dvMps), damagePct: r4(imp ? imp.damageFrac * 100 : null), expectedPct: r4(imp ? curve(imp.dvMps) * 100 : null),
      contactsFolded: imp?.contacts, healthAfter: r4(h1.health.health), normalSpeedBeforeMps: r4(vnBefore), normalSpeedAfterStepMps: r4(vnAfter),
      sampledVelAlongApproachAfterMps: r4(towardRock), laterImpacts: slow.impacts.slice(1).map((x) => r4(x.dvMps)),
      rockStillThere: stAfter.loaded && stAfter.rendered && stAfter.collider?.kind === "hull",
      pass: !!imp && imp.damageFrac > 0 && Math.abs(imp.damageFrac - curve(imp.dvMps)) < 1e-9 && !h1.dead &&
        stAfter.loaded && stAfter.rendered && stAfter.collider?.kind === "hull" && vnBefore < 0 && vnAfter > 0,
    };

    // 300 m/s: lethal; wreck with the cargo in the ship's frame; respawn leaves a clean near field.
    await ev('__dev.grantCargo("iron", 50)');
    const cargo = await ev("__phys.game.cargo()");
    await standoff(d, ev, id, 1500);
    const wrecks0 = (await ev("__phys.game.wrecks()")).length;
    const fast = await approach(d, ev, state, id, 1500, 20000);
    await d.frames(10);
    const deadState = await gameState();
    const shipAtDeath = (await state()).ship;
    const wrecks = await ev("__phys.game.wrecks()");
    const wreck = wrecks.at(-1);
    await ev("__phys.game.respawn()");
    await d.frames(120);
    const audit = await ev("__phys.asteroids.audit()");
    const st = await ev("__phys.stats()");
    out.asteroids.fast = {
      approachSpeedMps: r4(Math.max(...fast.rows.map((r) => r.speed))), impacts: fast.impacts.length, dvMps: r4(fast.impacts[0]?.dvMps), fatal: fast.impacts[0]?.fatal,
      dead: deadState.dead, healthAtDeath: deadState.health.health, cargoBefore: cargo,
      wreck: wreck ? { frameId: wreck.frameId, items: wreck.items, shipFrame: shipAtDeath.frameId } : null, wrecksAdded: wrecks.length - wrecks0,
      afterRespawn: { dead: await ev("__phys.game.isDead()"), audit, suspended: st.suspended, collidersByTag: st.collidersByTag },
      pass: deadState.dead && fast.impacts.some((x) => x.fatal) && wrecks.length === wrecks0 + 1 && wreck.frameId === shipAtDeath.frameId &&
        Object.keys(cargo).every((k) => wreck.items[k] === cargo[k]) && audit.missing.length === 0 && audit.extra.length === 0,
    };

    // Destroy through the authority: collider gone at once, and the ship flies through the spot.
    await ev("__test.simRate(0)");
    const rock2 = await pickRock(d, ev, 25, 300);
    await standoff(d, ev, rock2.instanceId, 120);
    const before = await ev(`__phys.asteroids.state(${rock2.instanceId})`);
    const destroyed = await ev(`(() => { const ok = __phys.asteroids.destroy(${rock2.instanceId}); return { ok, now: __phys.asteroids.state(${rock2.instanceId}), audit: __phys.asteroids.audit() }; })()`);
    // Fly until past the old centre (or 30 s).
    const c2 = rock2.absKm;
    const dist2 = (p) => Math.hypot(p[0] - c2[0], p[1] - c2[1], p[2] - c2[2]) * 1000;
    let minD = Infinity, wasClose = false;
    const pass2 = await approach(d, ev, state, rock2.instanceId, 100, 30000, (s) => {
      const dd = dist2(s.posKm);
      minD = Math.min(minD, dd);
      if (dd < 20) wasClose = true;
      return wasClose && dd > rock2.radiusM + 20;
    });
    await d.press("x");
    out.asteroids.destroy = {
      rock: rock2.instanceId, radiusM: rock2.radiusM, colliderBefore: before.collider, submitted: destroyed.ok, sameTickState: destroyed.now,
      auditSameTick: destroyed.audit, impactsFlyingThrough: pass2.impacts.length, maxSpeedMps: r4(Math.max(...pass2.rows.map((r) => r.speed))),
      minDistToOldCentreM: r4(minD),
      pass: destroyed.ok && destroyed.now.collider === null && !destroyed.now.loaded && pass2.impacts.length === 0 && minD < rock2.radiusM * 0.3,
    };
    out.asteroids.pass = out.asteroids.slow.pass && out.asteroids.fast.pass && out.asteroids.destroy.pass;
  }

  if (parts.includes("stream")) {
    // 30 km through the field at the speed limit: count within the cap, registry == instances in
    // range at 20 points, worst creation ms per frame, physics.step. The field is sparse at the 3 km
    // default (~0.5 rocks in range), so a second pass widens the radius and shrinks the cap.
    const pass = async (label, tuning, offsetKm) => {
      await ev(`__phys.tuning.set(${JSON.stringify(tuning)})`);
      await ev("__test.simRate(0)");
      await ev(`__phys.asteroids.warpToField(undefined, ${JSON.stringify(offsetKm)})`);
      await d.frames(5);
      const f0 = await ev("__phys.asteroids.fields()");
      await d.frames(120);
      const s0 = (await state()).ship;
      await ev("__phys.perf.reset()");
      await d.hold("w", 2500);
      const samples = [];
      let dist = 0;
      const t0 = Date.now();
      while (dist < 30 && Date.now() - t0 < 120_000) {
        await sleep(ev, 1000);
        const s = (await state()).ship;
        dist = Math.hypot(...s.posKm.map((v, i) => v - s0.posKm[i]));
        const a = await ev("__phys.asteroids.audit()");
        const st = await ev("__phys.stats()");
        samples.push({ km: r4(dist), speed: r4(s.speedMps), inRadius: a.inRadius, registered: a.registered, dropped: a.dropped, missing: a.missing.length, extra: a.extra.length, colliders: st.colliders, suspended: st.suspended });
      }
      await d.press("x");
      const step = await ev("__phys.perf.step()");
      const f1 = await ev("__phys.asteroids.fields()");
      const sum = (f, k) => f.reduce((n, x) => n + x.counters[k], 0);
      const pick = samples.filter((_, i) => i % Math.max(1, Math.floor(samples.length / 20)) === 0).slice(0, 20);
      const cap = (await ev("__phys.tuning.get()")).colliderCap;
      return {
        label, tuning, distanceKm: r4(dist), samples: pick, maxColliders: Math.max(...samples.map((x) => x.colliders)), maxInRadius: Math.max(...samples.map((x) => x.inRadius)), cap,
        created: sum(f1, "created") - sum(f0, "created"), removed: sum(f1, "removed") - sum(f0, "removed"),
        worstCreateMsFrame: r4(Math.max(...f1.map((f) => f.counters.maxCreateMsFrame))), maxCreatedInOneFrame: Math.max(...f1.map((f) => f.counters.maxCreatedFrame)),
        maxSingleCreateMs: r4(Math.max(...f1.map((f) => f.counters.maxSingleCreateMs))), meanCreateMs: r4(Math.max(...f1.map((f) => f.counters.meanCreateMs))),
        mustCreateOverBudget: sum(f1, "mustCreateOverBudget"),
        maxReanchorMsSoFar: r4((await ev("__phys.stats()")).counters.maxReanchorMs),
        physicsStep: step,
        pass: dist >= 30 && pick.length >= 20 && pick.every((x) => x.missing === 0 && x.extra === 0) && Math.max(...samples.map((x) => x.colliders)) <= cap &&
          Math.max(...f1.map((f) => f.counters.maxCreateMsFrame)) <= 2,
      };
    };
    const a = await pass("default 3 km", { physicsRadiusKm: 3 }, [0, 0, -15]);
    const b = await pass("wide 15 km, cap 40", { physicsRadiusKm: 15, colliderCap: 40 }, [0, 20, -15]);
    // Re-anchor cost with a full set (every collider re-posed each 2 km of travel).
    const c = process.env.STREAM_FULL ? await pass("wide 15 km, cap 1500", { physicsRadiusKm: 15, colliderCap: 1500 }, [0, 20, -15]) : null;
    await ev("__phys.tuning.set({ physicsRadiusKm: 3, colliderCap: 1500 })");
    out.stream = { perfEnabled: await ev("__phys.perf.enabled()"), passes: [a, b, c].filter(Boolean), pass: a.pass && b.pass && (!c || c.pass) };
  }

  if (parts.includes("look")) {
    await ev("__test.simRate(0)");
    await ev("__phys.debug.outlines(true)");
    const rock = await pickRock(d, ev, 30, 150);
    await standoff(d, ev, rock.instanceId, Math.max(25, rock.radiusM * 0.6));
    await d.frames(30);
    await d.canvas("phys-outline-near");
    await ev("__phys.tuning.set({ physicsRadiusKm: 20 })");
    const far = await pickRock(d, ev, 100, 2000, [rock.instanceId]);
    await standoff(d, ev, far.instanceId, 1500);
    await d.frames(120);
    await d.canvas("phys-outline-field");
    await ev("__phys.tuning.set({ physicsRadiusKm: 3 })");
    // Resting contact: creep into the rock and hold a little throttle.
    await standoff(d, ev, rock.instanceId, 15);
    await ev("__phys.impacts.clear()");
    await d.hold("w", 60);
    await sleep(ev, 6000);
    await d.canvas("phys-contact");
    const st = await ev("__phys.stats()");
    const impacts = await ev("__phys.impacts.log()");
    await d.press("x");
    await ev("__phys.debug.outlines(false)");
    out.look = {
      rock: { id: rock.instanceId, radiusM: rock.radiusM, modelId: rock.modelId }, far: { id: far.instanceId, radiusM: far.radiusM },
      contactCounters: st.counters.touchedSteps, impactsWhileResting: impacts.map((x) => ({ dvMps: r4(x.dvMps), damageHp: r4(x.damageHp) })),
      captures: ["phys-outline-near", "phys-outline-field", "phys-contact"], pass: true,
    };
  }

  if (parts.includes("liveOwner")) {
    // B2 owner path: a fresh world per difficulty (PHYS_DIFFS), engine load state, the "Collisions off"
    // flag (absent; shown under the dev speed override), then real held W from spawn into a rock.
    const G = "__test.gameplay";
    const MULT = { explorer: 0.5, standard: 1, hard: 1.5 };
    const flag = () => ev(`document.querySelector('[data-testid="collisions-off"]')?.textContent ?? null`);
    const W = { key: "w", code: "KeyW", windowsVirtualKeyCode: 87 };
    const original = (await ev("__test.save.info()")).id;
    const runs = {};
    for (const diff of (process.env.PHYS_DIFFS ?? "explorer,standard,hard").split(",")) {
      const id = await ev(`${G}.fixtures.create("phys-owner-${diff}", "new", { difficulty: ${JSON.stringify(diff)} })`);
      try {
        await ev(`${G}.fixtures.activate(${JSON.stringify(id)})`);
        await d.reload();
        await d.frames(20);
        try {
          await ev(`${G}.m37.comms.nameAi("Vega")`);
          await ev(`${G}.m37.comms.dismiss()`);
        } catch {
          /* no naming prompt */
        }
        const load = (await ev("__phys.stats()")).load;
        await sleep(ev, 400);
        const flagNormal = await flag();
        await ev("__bench.maxSpeed(50000)");
        await sleep(ev, 600);
        const flagDev = await flag();
        await ev("__bench.maxSpeed(null)");
        await sleep(ev, 600);
        const flagAfter = await flag();
        // Chunks stream in after the reload: poll for a 40-400 m rock 1.5-8 km out.
        let rocks = [], rock;
        for (let i = 0; i < 40 && !rock; i++) {
          rocks = await ev("__phys.asteroids.nearest(3000, 8000)");
          rock = rocks.filter((r) => r.radiusM >= 40 && r.radiusM <= 400 && r.surfaceDistM > 1500)[0];
          if (!rock) await sleep(ev, 500);
        }
        if (!rock) {
          runs[diff] = { error: "no rock 40-400 m beyond 1.5 km", n: rocks.length, pass: false };
          continue;
        }
        await ev(`${G}.res.face(${JSON.stringify({ fieldId: rock.fieldId, chunkKey: rock.chunkKey, instanceId: rock.instanceId })})`);
        await d.frames(60);
        await ev("__phys.impacts.clear()");
        const h0 = await ev("__phys.game.health()");
        await d.send("Input.dispatchKeyEvent", { type: "keyDown", ...W, text: "w" });
        const t0 = Date.now();
        let peak = 0, suspended = new Set(), minSurf = Infinity, colAtMin = null;
        while (Date.now() - t0 < 30000) {
          await sleep(ev, 60);
          const x = await ev(`(() => { const rt = ${G}.rep.runtime(); const a = __phys.asteroids.state(${rock.instanceId}); return { v: rt.speedMps, sus: rt.nearField.suspended, n: __phys.impacts.log().length, dead: __phys.game.isDead(), surf: a.surfaceDistM, col: a.collider ? a.collider.inEngine : null }; })()`);
          if (x.surf !== undefined && x.surf < minSurf) { minSurf = x.surf; colAtMin = x.col; }
          peak = Math.max(peak, x.v ?? 0);
          suspended.add(String(x.sus));
          if (x.n > 0 || x.dead) break;
        }
        await d.send("Input.dispatchKeyEvent", { type: "keyUp", ...W });
        await sleep(ev, 300);
        const h1 = await ev("__phys.game.health()");
        const impacts = (await ev("__phys.impacts.log()")).map((x) => ({ dvMps: Math.round(x.dvMps), damageHp: r4(x.damageHp), fatal: x.fatal }));
        const first = impacts[0];
        const expectHp = first ? curve(first.dvMps) * h0.max * MULT[diff] : null;
        runs[diff] = {
          load, flags: { normal: flagNormal, devSpeed: flagDev, after: flagAfter }, rock: { radiusM: Math.round(rock.radiusM), startSurfaceKm: r4(rock.surfaceDistM / 1000) },
          peakSpeedMps: Math.round(peak), nearField: [...suspended], minSurfaceM: Math.round(minSurf), colliderInEngineAtMin: colAtMin, flightS: r4((Date.now() - t0) / 1000), healthBefore: r4(h0.health), healthAfter: r4(h1.health), dead: await ev("__phys.game.isDead()"), impacts, expectHp: r4(expectHp),
        };
        runs[diff].pass = load.state === "ready" && flagNormal === null && /Collisions off/.test(flagDev ?? "") && flagAfter === null &&
          !!first && h1.health < h0.health && Math.abs(first.damageHp - expectHp) <= 0.02 * expectHp + 0.01;
      } finally {
        await ev(`${G}.fixtures.activate(${JSON.stringify(original)})`);
        await d.reload();
        await d.frames(10);
        await ev(`${G}.fixtures.remove(${JSON.stringify(id)})`);
      }
    }
    out.liveOwner = { runs, pass: Object.values(runs).every((x) => x.pass) };
  }

  if (parts.includes("devFlag")) {
    // B2 owner cause: a stored dev physics edit (lethal speed) carried silently across saves.
    const KEY = "dev-physics-tuning-v1";
    const flag = () => ev(`document.querySelector('[data-testid="dev-tuning"]')?.textContent ?? null`);
    const keys = () => ev(`["dev-flight-tuning-v1", "dev-physics-tuning-v1", "dev-resource-tuning-v1"].filter((k) => localStorage.getItem(k) !== null)`);
    const same = async () => JSON.stringify(await ev("__phys.tuning.get()")) === JSON.stringify(await ev("__phys.tuning.defaults()"));
    const reload = async () => {
      await d.reload();
      await d.frames(20);
      await sleep(ev, 800);
    };
    const resetViaMenu = async () => {
      if (!(await ev("!!document.querySelector('.settings-menu')"))) await d.press("Escape");
      await sleep(ev, 300);
      await ev(`[...document.querySelectorAll(".settings-menu__button")].find((e) => e.textContent.trim().toLowerCase().startsWith("dev"))?.click()`);
      await sleep(ev, 300);
      const clicked = await ev(`(() => { const b = document.querySelector('[data-action="reset-dev-tuning"]'); b?.click(); return !!b; })()`);
      await sleep(ev, 200);
      await d.press("Escape");
      await sleep(ev, 200);
      if (await ev("!!document.querySelector('.settings-menu')")) await d.press("Escape");
      await sleep(ev, 500);
      return clicked;
    };
    const G = "__test.gameplay";
    const original = (await ev("__test.save.info()")).id;
    const id = await ev(`${G}.fixtures.create("phys-devflag", "new", {})`);
    await ev(`${G}.fixtures.activate(${JSON.stringify(id)})`);
    try {
      await reload();
      const baseClicked = await resetViaMenu();
      const base = { clicked: baseClicked, flag: await flag(), defaults: await same(), keys: await keys() };
      const lethal = (await ev("__phys.tuning.defaults()")).lethalSpeedMps * 4;
      await ev(`__phys.tuning.set({ lethalSpeedMps: ${lethal} })`);
      await ev(`localStorage.setItem(${JSON.stringify(KEY)}, JSON.stringify({ tuning: { lethalSpeedMps: ${lethal} }, outlines: false }))`);
      await sleep(ev, 500);
      const live = { flag: await flag(), devActive: await ev("__phys.tuning.devActive()") };
      await reload();
      const stored = { flag: await flag(), lethal: (await ev("__phys.tuning.get()")).lethalSpeedMps };
      const clicked = await resetViaMenu();
      const reset = { clicked, flag: await flag(), defaults: await same(), keys: await keys() };
      await reload();
      const after = { flag: await flag(), defaults: await same() };
      const slot = await ev(`document.querySelector(".ship-dashboard__status")?.textContent ?? null`);
      // The other tables: a live edit flags, the menu reset clears it.
      const tables = {};
      for (const [name, set] of [
        ["flight", `__test.flight.tuning({ maxPitchRateDegS: __test.flight.tuning().maxPitchRateDegS * 2 })`],
        ["resources", `${G}.res.setTuning({ tankKg: ${G}.res.tuning().tankKg * 2 })`],
      ]) {
        await ev(set);
        await sleep(ev, 500);
        const on = { flag: await flag(), devActive: await ev("__phys.tuning.devActive()") };
        await resetViaMenu();
        tables[name] = { on, offFlag: await flag(), offActive: await ev("__phys.tuning.devActive()") };
      }
      const tablesPass = Object.values(tables).every((t) => t.on.flag === "Dev tuning active" && t.on.devActive && t.offFlag === null && !t.offActive);
      out.devFlag = {
        base, live, stored, reset, after, slotAfter: slot, tables,
        pass: base.flag === null && base.defaults && base.keys.length === 0 &&
          live.flag === "Dev tuning active" && live.devActive && tablesPass && stored.flag === "Dev tuning active" && stored.lethal === lethal &&
          reset.clicked && reset.flag === null && reset.defaults && reset.keys.length === 0 && after.flag === null && after.defaults,
      };
    } finally {
      await ev(`${G}.fixtures.activate(${JSON.stringify(original)})`);
      await reload();
      await ev(`${G}.fixtures.remove(${JSON.stringify(id)})`);
    }
  }
}
