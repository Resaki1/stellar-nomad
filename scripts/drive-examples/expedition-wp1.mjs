/**
 * FIRST_EXPEDITION_PLAN WP1: trust the ship where control changes hands.
 *   EXP_PARTS=arrive,place pnpm drive -- --keep --no-isolate run:scripts/drive-examples/expedition-wp1.mjs
 * arrive — targeted transit to a replication point from two directions, at zero and full pre-transit
 *          throttle, coupled and decoupled. Records the last braking seconds and 5 s after arrival.
 * place  — the depot/point preview at rest, closing fast, drifting sideways and receding.
 * Each part prints one JSON line with its gates; the run fails on the first failed gate.
 * Recovery of two pilots into one berth is covered under Node by `pnpm coop:transcript recover`.
 */
import assert from "node:assert/strict";

const G = "__test.gameplay";
const j = JSON.stringify;
const frameId = "earth";
const pointPos = [0, 10_000, 0];
const pointId = "wp1-point";

export default async function expeditionWp1(d) {
  const parts = (process.env.EXP_PARTS ?? "arrive,place").split(",");
  const ev = (e) => d.evaluate(e);
  const until = async (label, expr, timeout = 20_000) => {
    const end = Date.now() + timeout;
    do {
      const r = await ev(expr);
      if (r) return r;
      await d.sleep(100);
    } while (Date.now() < end);
    throw Error(`timeout: ${label}`);
  };

  const previous = await ev("__test.save.info().id");
  const fixture = await ev(`(async () => {
    const g = ${G}, who = g.localId(), data = JSON.parse(await g.fixtures.export(${j(previous)})).data;
    data.world.replication.points = [...data.world.replication.points.filter(p => p.starter),
      { frameId: ${j(frameId)}, positionKm: ${j(pointPos)}, quaternion: [0,0,0,1], id: ${j(pointId)}, name: "Arrival Test", by: who, starter: false, createdAt: Date.now() }];
    data.world.industry.depots = [];
    const me = data.players[who];
    me.isDead = false;
    me.propellant = { ordinaryKg: 600, protectedKg: 25 };
    me.modules.consumables = { ...me.modules.consumables, consumable_depot_kit: 6, consumable_replication_kit: 6 };
    if (!me.modules.ownedModules.includes("special_transit_drive")) me.modules.ownedModules.push("special_transit_drive");
    return g.fixtures.create("wp1", data);
  })()`);
  await ev(`${G}.fixtures.activate(${j(fixture)})`);
  await d.reload();
  await ev(`${G}.m37.comms.nameAi("Vega"); ${G}.m37.comms.dismiss()`);
  const results = {};

  // Teleport, settle at rest, wait for the warp to land.
  const placeShip = async (posKm, quat) => {
    await ev(`${G}.rep.teleportRel(${j(frameId)}, ${j(posKm)}, ${j(quat)})`);
    await until("teleport", `(() => { const s = ${G}.rep.ship(); return s && s.frameId === ${j(frameId)} && Math.hypot(...s.posKm.map((v,i)=>v-${j(posKm)}[i])) < 0.05; })()`);
    await d.frames(30);
  };

  try {
    if (parts.includes("arrive")) {
      const runs = [];
      // From +Z facing -Z, and from +X facing -X (quaternions turning the +Z nose).
      const dirs = [
        { name: "pz", off: [0, 0, 400], q: [0, 1, 0, 0] },
        { name: "px", off: [400, 0, 0], q: [0, -Math.SQRT1_2, 0, Math.SQRT1_2] },
      ];
      for (const dir of dirs) for (const throttle of [0, 1]) for (const decoupled of [false, true]) {
        if (decoupled && throttle === 0) continue;
        const start = pointPos.map((v, i) => v + dir.off[i]);
        await placeShip(start, dir.q);
        const assist = await ev("__test.state().ship.assist");
        if ((assist === "decoupled") !== decoupled) await d.press("v");
        if (throttle) await d.hold("w", 2300);
        // The real gaze lock: the nose already faces the point marker.
        await until("gaze lock on the point", `${G}.transit.state().targeted === "point:${pointId}"`, 15_000);
        // Sampler: every frame, until 5 s after the drive goes idle.
        await ev(`(() => {
          const P = ${j(pointPos)};
          const rec = window.__wp1 = { s: [], arrivedAt: -1, done: false };
          const tick = () => {
            const st = __test.state(), sh = st.ship, tr = ${G}.transit.state();
            if (sh.frameId === ${j(frameId)}) {
              const rel = sh.relPosKm.map((v,i)=>v-P[i]);
              const q = sh.quat, fwd = [2*(q[0]*q[2]+q[3]*q[1]), 2*(q[1]*q[2]-q[3]*q[0]), 1-2*(q[0]*q[0]+q[1]*q[1])];
                            rec.s.push({ t: performance.now(), d: Math.hypot(...rel), v: sh.speedMps, w: Math.hypot(...sh.angVelRadS), fwd, lag: st.camera?.lagDeg ?? 0, ph: tr.phase, sp: tr.speedKmps, thr: sh.throttleSetPoint });
              if (rec.s.length > 4000) rec.s.splice(0, 1000);
            }
            if (rec.arrivedAt < 0 && rec.base !== undefined && tr.ev.arrived > rec.base && tr.phase === "idle") rec.arrivedAt = performance.now();
            if (rec.arrivedAt > 0 && performance.now() - rec.arrivedAt > 5000) { rec.done = true; return; }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        })()`);
        const arrived0 = await ev(`${G}.transit.state().ev.arrived`);
        await ev(`window.__wp1.base = ${arrived0}`);
        await d.hold("t", 3400);
        await until(`arrival ${dir.name}`, `(() => { const r = window.__wp1; if (r.arrivedAt < 0) { if (${G}.transit.state().ev.arrived > r.base && ${G}.transit.state().phase === "idle") r.arrivedAt = performance.now(); } return r.done; })()`, 120_000);
        const r = await ev(`(() => {
          const r = window.__wp1, a = r.arrivedAt;
          const brake = r.s.filter(x => x.t >= a - 3000 && x.t < a), after = r.s.filter(x => x.t >= a);
          const ang = (u, v) => Math.acos(Math.max(-1, Math.min(1, u[0]*v[0]+u[1]*v[1]+u[2]*v[2]))) * 180 / Math.PI;
          const turn = (xs, k) => xs.length ? ang(xs[0][k] ?? [0,0,1], xs.at(-1)[k] ?? [0,0,1]) : 0;
          const maxStep = (xs, k) => { let m = 0; for (let i = 1; i < xs.length; i++) if (xs[i][k] && xs[i-1][k]) m = Math.max(m, ang(xs[i-1][k], xs[i][k])); return m; };
          const end = after.at(-1) ?? r.s.at(-1);
          return {
            brakeMaxW: Math.max(0, ...brake.map(x => x.w)), brakeTurnDeg: turn(brake, "fwd"),
            afterMaxV: Math.max(0, ...after.map(x => x.v)), afterMaxW: Math.max(0, ...after.map(x => x.w)),
            afterTurnDeg: turn(after, "fwd"), afterMaxStepDeg: maxStep(after, "fwd"), afterMaxCamLagDeg: Math.max(0, ...after.map(x => x.lag)),
            minDistM: Math.min(...after.map(x => x.d)) * 1000, endDistM: end.d * 1000, endSpeedMps: end.v,
            throttleAfter: after[0]?.thr ?? null,
          };
        })()`);
        // Fresh input works: a short throttle hold moves the ship off station.
        await d.hold("w", 400);
        await d.frames(20);
        r.freshInputMps = await ev("__test.state().ship.speedMps");
        await d.press("x"); // brake (latched)
        if (decoupled) await d.press("v");
        const run = { dir: dir.name, throttle, decoupled, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(2) : v])) };
        runs.push(run);
        console.log(j({ arrive: run }));
      }
      results.arrive = runs;
      for (const r of runs) {
        assert.ok(r.afterMaxV < 5, `${r.dir}/${r.throttle}/${r.decoupled}: holds station after arrival (max ${r.afterMaxV} m/s)`);
        assert.ok(r.afterTurnDeg < 5 && r.afterMaxCamLagDeg < 10, `${r.dir}/${r.throttle}: no hull or camera reversal (${r.afterTurnDeg}°, cam lag ${r.afterMaxCamLagDeg}°)`);
        assert.ok(r.brakeTurnDeg < 30, `${r.dir}/${r.throttle}: no spin while braking (${r.brakeTurnDeg}°)`);
        assert.ok(r.minDistM > 120 && r.endDistM < 2000, `${r.dir}/${r.throttle}: clear of the hull and in range (${r.minDistM}–${r.endDistM} m)`);
        assert.ok(r.freshInputMps > 5, `${r.dir}/${r.throttle}: fresh input moves the ship (${r.freshInputMps} m/s)`);
      }
    }

    if (parts.includes("place")) {
      // Open space; the previews sit 0.8 km along the +Z nose. Each case gets fresh space per commit.
      const cases = [
        { name: "rest", vel: [0, 0, 0], ok: true },
        { name: "slow", vel: [0, 0, 0.05], ok: true },
        { name: "closing", vel: [0, 0, 0.4], ok: false },
        { name: "closingDrift", vel: [0.03, 0, 0.39], ok: false },
        { name: "sideways", vel: [0.3, 0, 0], ok: true },
        { name: "receding", vel: [0, 0, -0.3], ok: true },
      ];
      const out = [];
      let slot = 0;
      for (const c of cases) for (const commit of ["point", "depot"]) {
        await placeShip([5 * ++slot, 10_000, -40], [0, 0, 0, 1]);
        const r = await ev(`${G}.rep.motionCheck(${j(c.vel)}, ${j(commit)})`);
        out.push({ case: c.name, commit, ...r });
        console.log(j({ place: c.name, commit, point: r.point, depot: r.depot, authority: r.authority, retry: r.retry, before: r.before, after: r.afterRetry }));
        assert.equal(r.point === null, c.ok, `${c.name}: point preview ${c.ok ? "accepts" : "refuses"} (${r.point})`);
        assert.equal(r.depot === null, c.ok, `${c.name}: depot preview ${c.ok ? "accepts" : "refuses"} (${r.depot})`);
        assert.equal(r.authority, commit === "point" ? r.point : r.depot, `${c.name}/${commit}: authority agrees with the preview`);
        if (!c.ok) assert.equal(r[commit], "moving", `${c.name}: refused as "Brake to deploy"`);
        const built = c.ok ? 1 : 0;
        assert.equal(r.afterRetry[commit === "point" ? "points" : "depots"], r.before[commit === "point" ? "points" : "depots"] + built, `${c.name}/${commit}: one structure per accepted op, none on refusal or retry`);
        assert.equal(r.afterRetry.kits, r.before.kits - built, `${c.name}/${commit}: one kit per accepted op`);
      }
      results.place = out.length;
    }
  } finally {
    await ev(`(async () => { const p = ${j(previous)}; ${G}.fixtures.activate(p); })()`);
  }
  return results;
}
