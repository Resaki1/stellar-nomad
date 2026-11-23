/**
 * VFX plan §2 gates: the straight mining beam (B1) and its look (B2–B4).
 *
 *   pnpm drive -- --keep --no-isolate run:scripts/drive-examples/vfx-beam.mjs
 *
 * - orbit: 12 approach directions round one irregular rock; at each the beam must follow the
 *          nose axis (< 0.01°) and end on the mesh: |end − centre| / radius varies (a bounding
 *          sphere would read 1.000 every time), and the end lies on the ray.
 * - miss:  turn the nose off the rock while mining → progress frozen within one tick, beam
 *          still drawn to full range; turn back → progress resumes.
 * - shots: chase view on target, and a free-look side view.
 * Parts: BEAM_PARTS=orbit,miss,shots (default all).
 */
const G = "__test.gameplay";
const PARTS = (process.env.BEAM_PARTS ?? "orbit,miss,shots").split(",");
const j = JSON.stringify;

export default async function vfxBeam(d) {
  const ev = (x) => d.evaluate(x);
  const wait = (ms) => d.sleep(ms);
  const until = async (label, fn, ms = 10_000) => {
    const end = Date.now() + ms;
    do { const v = await fn(); if (v) return v; await wait(80); } while (Date.now() < end);
    throw Error(label);
  };
  await ev(`__test.simRate(0); ${G}.m37.comms.dismiss?.(); __phys.tuning.set({ noDamageSpeedMps: 1e5, lethalSpeedMps: 2e5 })`);
  if (await ev("__phys.game.isDead()")) await ev("__phys.game.respawn()");
  let rocks = [];
  for (let i = 0; i < 60 && rocks.length < 20; i++) { rocks = await ev(`${G}.m33.rocks(3000)`); if (rocks.length < 20) await wait(250); }
  const rock = rocks.find((r) => r.radiusM > 40 && r.radiusM < 120 && r.distKm < 20) ?? rocks[0];
  const out = { rock: { id: rock.instanceId, radiusM: rock.radiusM } };
  const mining = () => ev(`${G}.res.mining()`);
  const beam = () => ev("__beam()");
  const startMining = async () => {
    await until("never focused", async () => (await mining()).focused, 8000);
    if (!(await mining()).mining) await d.press("m");
    await until("never mining", async () => (await mining()).mining && (await beam()).on, 5000);
  };
  const stopMining = async () => { if ((await mining()).mining) await d.press("m"); await d.frames(3); };
  const park = async (yawDeg, pitchDeg, standoffM) => {
    await stopMining();
    await ev(`${G}.res.parkAround(${j(rock)}, ${yawDeg}, ${pitchDeg}, ${(rock.radiusM + standoffM) / 1000})`);
    await d.frames(6);
    await ev(`${G}.res.face(${j(rock)})`);
    await d.frames(4);
  };

  try {
    if (PARTS.includes("orbit")) {
      const rows = [];
      for (let k = 0; k < 12; k++) {
        await park(k * 30, k % 3 === 0 ? 0 : k % 3 === 1 ? 35 : -35, 90);
        await startMining();
        await d.frames(4);
        const b = await beam();
        const dir = [b.end[0] - b.start[0], b.end[1] - b.start[1], b.end[2] - b.start[2]];
        const len = Math.hypot(...dir);
        const cos = dir.reduce((a, v, i) => a + (v / len) * b.forward[i], 0);
        // Hit point's distance from the rock centre over its radius (field-local and scene metres
        // differ by a constant, so use the beam end and the centre the same cast returned).
        rows.push({ k, hit: b.hit, onTarget: b.onTarget, axisErrDeg: +(Math.acos(Math.min(1, cos)) * 180 / Math.PI).toFixed(5), lenM: +len.toFixed(2), surfOverR: +b.surfOverR.toFixed(3) });
      }
      const r = rows.map((x) => x.surfOverR);
      out.orbit = { rows, allOnTarget: rows.every((x) => x.onTarget), maxAxisErrDeg: Math.max(...rows.map((x) => x.axisErrDeg)),
        surfOverR: { min: Math.min(...r), max: Math.max(...r) } };
      console.log("orbit", j(out.orbit));
    }
    if (PARTS.includes("shots")) {
      await park(20, 10, 120);
      await startMining();
      await d.frames(20);
      await d.canvas("beam-chase");
      await ev("__test.input.freeLook(true)");
      await ev("__test.input.mouse(-900, -120)");
      await d.frames(30);
      await d.canvas("beam-side");
      await ev("__test.input.mouse(900, 120); __test.input.freeLook(false)");
      await d.frames(10);
    }
    if (PARTS.includes("perf")) {
      // Run with --perf: local-scene GPU ms with the beam (and its impact) on vs off at 45 m,
      // and the cast's CPU time.
      await park(20, 10, 45);
      const local = async () => {
        await ev("__bench.reset()");
        await d.frames(150);
        const snap = await ev("JSON.parse(JSON.stringify(__bench.report()))");
        const pass = (snap.passes ?? []).find((p) => /local/i.test(p.label));
        return pass ? +pass.gpu.p50.toFixed(3) : null;
      };
      const rows = { on: [], off: [], castMs: [] };
      for (let k = 0; k < 2; k++) {
        await startMining();
        await d.frames(20);
        rows.on.push(await local());
        for (let i = 0; i < 20; i++) { rows.castMs.push((await beam()).castMs); await d.frames(1); }
        await stopMining();
        await d.frames(20);
        rows.off.push(await local());
      }
      await startMining();
      rows.castMs = { targetFirst: await ev("__beamBench(400, true)"), fullScan: await ev("__beamBench(400, false)") };
      out.perf = rows;
      console.log("perf", j(rows));
    }
    if (PARTS.includes("impact")) {
      // §3: close range, a slow sweep (trail), then the cooling after the beam stops.
      await park(Number(process.env.IMPACT_YAW ?? 20), 10, 45);
      await startMining();
      await d.frames(60);
      console.log("impact: mining"); await d.canvas("impact-on");
      for (let a = 0; a <= 8; a += 1) {
        await ev(`${G}.res.faceOffset(${j(rock)}, ${a})`);
        await d.frames(6);
      }
      console.log("impact: sweep"); await d.canvas("impact-sweep");
      await stopMining();
      await wait(1000);
      await d.canvas("impact-cool-1s");
      await wait(1500);
      await d.canvas("impact-cool-2_5s"); console.log("impact: cooled");
      await ev("__test.input.freeLook(true)");
      await ev(`${G}.res.face(${j(rock)})`);
      await startMining();
      await ev("__test.input.mouse(-700, -60)");
      await d.frames(40);
      await d.canvas("impact-side"); console.log("impact: side");
      await ev("__test.input.mouse(700, 60); __test.input.freeLook(false)");
      await stopMining();
    }
    if (PARTS.includes("miss")) {
      await park(20, 10, 90);
      await startMining();
      await d.frames(30);
      if (PARTS.includes("shots")) await d.shot("beam-hud-hit");
      const p0 = (await mining()).progress;
      // Nose 70° off the rock (yaw), held: the beam must run past it.
      await ev(`${G}.res.faceOffset(${j(rock)}, 70)`);
      await d.frames(10);
      const a = (await mining()).progress;
      await wait(600);
      const bm = await beam();
      const b2 = (await mining()).progress;
      if (PARTS.includes("shots")) await d.shot("beam-hud-miss");
      out.miss = { p0, atTurn: a, after600ms: b2, onTarget: bm.onTarget, beamOn: bm.on, hit: bm.hit, mining: (await mining()).mining };
      await ev(`${G}.res.face(${j(rock)})`);
      await wait(600);
      out.miss.resumed = (await mining()).progress;
      console.log("miss", j(out.miss));
      // Interlock: held off target past the grace, the AI cuts the laser (mining stops).
      await ev(`${G}.res.faceOffset(${j(rock)}, 70)`);
      await wait(2200);
      const hint = await ev(`[...document.querySelectorAll(".notif-stack__item, [class*=hint]")].map(e => e.innerText).find(t => /cut the laser/i.test(t)) ?? null`);
      out.interlock = { mining: (await mining()).mining, beamOn: (await beam()).on, hint };
      console.log("interlock", j(out.interlock));
    }
    if (PARTS.includes("hold")) {
      // Safety hold: a station fixture placed ON the line between ship and rock.
      const bearing = [20, 10], standoff = 300;
      const yr = bearing[0] * Math.PI / 180, pr = bearing[1] * Math.PI / 180;
      const dir = [Math.cos(pr) * Math.cos(yr), Math.sin(pr), Math.cos(pr) * Math.sin(yr)];
      const k = (rock.radiusM + 150) / 1000;
      const rockKm = await ev(`${G}.res.rockKm(${j(rock)})`);
      const at = rockKm.map((v, i) => v + dir[i] * k);
      const previous = await ev("__test.save.info().id");
      const fixture = await ev(`(async () => {
        const game = ${G};
        const data = JSON.parse(await game.fixtures.export(${j(previous)})).data;
        data.world.replication.points.push({ id: "beam-hold", name: "Hold trial", frameId: "system", positionKm: ${j(at)},
          quaternion: [0, 0, 0, 1], by: game.localId(), starter: false, createdAt: Date.now() });
        return game.fixtures.create("beam-hold", data);
      })()`);
      try {
        await ev(`${G}.fixtures.activate(${j(fixture)})`);
        await d.reload();
        await ev(`__test.simRate(0); ${G}.m37.comms.dismiss?.()`);
        // Start on a clear line (opposite bearing), then move, still mining, onto the blocked one.
        await park(bearing[0] + 180, -bearing[1], standoff);
        await startMining();
        await d.frames(10);
        const clear = await beam();
        await ev(`${G}.res.parkAround(${j(rock)}, ${bearing[0]}, ${bearing[1]}, ${(rock.radiusM + standoff) / 1000})`);
        await d.frames(4);
        await ev(`${G}.res.face(${j(rock)})`);
        await d.frames(6);
        const b = await beam();
        out.hold = { clearHold: clear.hold, clearOnTarget: clear.onTarget, hold: b.hold, mining: (await mining()).mining, progress0: (await mining()).progress };
        await wait(500);
        out.hold.progressAfter500ms = (await mining()).progress;
        await wait(2000);
        out.hold.afterGrace = { mining: (await mining()).mining };
        console.log("hold", j(out.hold));
      } finally {
        await stopMining().catch(() => {});
        await ev(`${G}.fixtures.activate(${j(previous)})`);
        await d.reload();
        await ev(`${G}.fixtures.remove(${j(fixture)})`);
      }
    }
  } finally {
    await stopMining().catch(() => {});
  }
  return out;
}
