/**
 * VFX plan §4 S1 gates: analytic sun shadows from nearby rocks.
 *
 *   SHADOW_PARTS=umbra,lit,penumbra,shots pnpm drive -- --keep --no-isolate run:scripts/drive-examples/vfx-shadows.mjs
 *
 * Luma is summed over the HDR target round the ship (`__lum.region`) with exposure held,
 * shadows on vs off at the same pose, so sky, rock and noise cancel.
 * - umbra:    ship 3 R behind a rock on the sun line → CPU visibility 0 and the hull at the floor
 *             (key light forced off: sky light, planetshine, own lamps): sun fraction ≤ 2 %.
 * - lit:      ship on the rock's sun side → on/off 1 ± 1 % for the hull AND the rock (no self-shadow).
 * - penumbra: lateral sweep across the edge 8 km behind the rock → 10–90 % width within 20 % of
 *             0.626 · 2 L tan(a_sun) (half-plane over the 0.53° disc); GPU luma tracks the CPU twin.
 * - glare:    umbra, sun just off-screen: the eye's rock-shadow visibility is 0 and the frame's
 *             luma drops with shadows on (the analytic sun glare is not depth-tested).
 * - map:      (S2) hull luma, shadow-map term on vs bypassed, sun at 0/70/110/180° off the nose.
 * - swim:     (S2) 12 sideways steps of 3 cm vs 12 re-measures of one pose: the hull's shadow
 *             ratio may not spread more than 2× the noise floor (or 2 %).
 * - shots:    chase view in the umbra and at the edge.
 * - perf:     (--perf) local-scene GPU ms, occluders uploaded vs none (the loop's real work); gather CPU ms.
 */
const G = "__test.gameplay";
const PARTS = (process.env.SHADOW_PARTS ?? "umbra,lit,penumbra,shots").split(",");
const j = JSON.stringify;

export default async function vfxShadows(d) {
  const ev = (x) => d.evaluate(x);
  const wait = (ms) => d.sleep(ms);
  // A read can lag a switch by several frames: re-read until two consecutive reads agree.
  const reg = async (box) => {
    let prev = (await ev(`__lum.region(${box})`)).sum;
    for (let k = 0; k < 12; k++) {
      await d.frames(2);
      const v = (await ev(`__lum.region(${box})`)).sum;
      if (Math.abs(v - prev) <= 1e-3 * Math.max(Math.abs(v), 1e-9)) return v;
      prev = v;
    }
    return prev;
  };
  await ev(`__test.simRate(0); ${G}.m37.comms.dismiss?.(); __phys.tuning.set({ noDamageSpeedMps: 1e5, lethalSpeedMps: 2e5 })`);
  if (await ev("__phys.game.isDead()")) await ev("__phys.game.respawn()");
  let rocks = [];
  for (let i = 0; i < 60 && rocks.length < 20; i++) { rocks = await ev(`${G}.m33.rocks(3000)`); if (rocks.length < 20) await wait(250); }
  const rock = rocks.find((r) => r.radiusM > 60 && r.radiusM < 160 && r.distKm < 20) ?? rocks[0];
  const out = { rock: { id: rock.instanceId, radiusM: rock.radiusM } };
  const C = await ev(`${G}.res.rockKm(${j(rock)})`);
  const st0 = await ev("__shadow.status()");
  const s = st0.sunDir;
  // A unit vector ⟂ the sun line.
  const e0 = Math.abs(s[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const k0 = dot(e0, s);
  let e = [e0[0] - k0 * s[0], e0[1] - k0 * s[1], e0[2] - k0 * s[2]];
  const el = Math.hypot(...e); e = e.map((v) => v / el);

  // Park at C + v (metres), facing the rock (the camera trails the ship).
  const parkAt = async (v) => {
    const len = Math.hypot(...v);
    const u = v.map((x) => x / len);
    await ev(`${G}.res.parkAround(${j(rock)}, ${(Math.atan2(u[2], u[0]) * 180) / Math.PI}, ${(Math.asin(u[1]) * 180) / Math.PI}, ${len / 1000})`);
    await d.frames(8);
  };
  // The occluder this rock became (scene metres) → its sphere in system km.
  const sphere = async () => {
    const st = await ev("__shadow.status()");
    const near = st.occluders.reduce((b, o) => (Math.abs(o.score) < Math.abs(b?.score ?? Infinity) ? o : b), null);
    // Pick the sphere closest to the rock centre.
    let best = null, bd = Infinity;
    for (const o of st.occluders) {
      const km = [st.originKm[0] + o.x / 1000, st.originKm[1] + o.y / 1000, st.originKm[2] + o.z / 1000];
      const dd = Math.hypot(km[0] - C[0], km[1] - C[1], km[2] - C[2]);
      if (dd < bd) { bd = dd; best = { km, r: o.r, offM: dd * 1000 }; }
    }
    return { st, best, near };
  };
  const ratio = async (box, pairs = 2, withFloor = false) => {
    let on = 0, off = 0;
    await ev("__lum.holdExposure(true)");
    for (let k = 0; k < pairs; k++) {
      await ev("__shadow.enable(true)"); await d.frames(6);
      on += await reg(box);
      await ev("__shadow.enable(false)"); await d.frames(6);
      off += await reg(box);
    }
    await ev("__shadow.enable(true)");
    let floor = null;
    if (withFloor) {
      await ev("__shadow.force(true)"); await d.frames(6);
      floor = await reg(box) * pairs;
      await ev("__shadow.force(false)");
    }
    await ev("__lum.holdExposure(false)");
    // Sun fraction left: (on − floor) / (off − floor); floor = key light fully shadowed.
    return { on, off, floor, r: off > 0 ? on / off : null, sun: floor === null ? null : (on - floor) / (off - floor) };
  };
  const HULL = "0.38,0.5,0.62,0.85";
  const ROCK = "0.3,0.15,0.7,0.5";

  try {
    if (PARTS.includes("umbra")) {
      await parkAt(s.map((v) => -v * rock.radiusM * 3));
      const { st, best } = await sphere();
      const q = await ratio(HULL, 2, true);
      out.umbra = { shipVis: st.shipVisibility, hull: q, sphere: best && { r: +best.r.toFixed(1), eqOverR: +(best.r / rock.radiusM).toFixed(3), offM: +best.offM.toFixed(1) },
        calib: await ev("__shadow.calib()"), builds: st.builds, gatherMs: st.gatherMs, offered: st.offered,
        pass: st.shipVisibility < 0.01 && Math.abs(q.sun) <= 0.02 };
      console.log("umbra", j(out.umbra));
      await d.canvas("shadow-umbra");
    }
    if (PARTS.includes("lit")) {
      await parkAt(s.map((v) => v * rock.radiusM * 3));
      const { st } = await sphere();
      const hull = await ratio(HULL);
      const rk = await ratio(ROCK);
      out.lit = { shipVis: st.shipVisibility, hull: hull.r, rock: rk.r,
        pass: st.shipVisibility > 0.999 && Math.abs(hull.r - 1) < 0.01 && Math.abs(rk.r - 1) < 0.01 };
      console.log("lit", j(out.lit));
      await d.canvas("shadow-lit");
    }
    if (PARTS.includes("penumbra")) {
      // Penumbra ≫ the ~10 m hull, so the hull-averaged luma samples one point of the edge.
      const L = 8000;
      await parkAt(s.map((v) => -v * L));
      const { best, st } = await sphere();
      const tanA = Math.tan((st.sunAngDeg * Math.PI) / 180);
      const W = L * tanA;
      // Sphere centre relative to the rock centre (m), so the edge sits at perp = R from it.
      const off = best.km.map((v, i) => (v - C[i]) * 1000);
      const rows = [];
      for (let x = -1.6 * W; x <= 1.6 * W + 1e-6; x += W / 5) {
        const p = [0, 1, 2].map((i) => off[i] - s[i] * L + e[i] * (best.r + x));
        await parkAt(p);
        const vis = (await ev("__shadow.status()")).shipVisibility;
        // A read occasionally lands on a frame from before the switch: median of three.
        const reads = [];
        for (let t = 0; t < 3; t++) reads.push(await ratio(HULL, 1, true));
        reads.sort((a, b) => a.sun - b.sun);
        const q = reads[1];
        rows.push({ x: +x.toFixed(2), cpu: +vis.toFixed(3), gpu: +q.sun.toFixed(3) });
        console.log("row", j(rows.at(-1)));
      }
      // GPU sun fraction ((on − floor) / (off − floor)): 10 % / 90 % crossings.
      const n = rows.map((r) => ({ x: r.x, f: r.gpu, cpu: r.cpu }));
      // Walk outward from the geometric edge (x = 0): other rocks' shadows can sit in the tails.
      const mid = n.findIndex((r) => Math.abs(r.x) < 1e-6);
      const at = (k0, k1, lvl) => n[k0].x + ((lvl - n[k0].f) / (n[k1].f - n[k0].f)) * (n[k1].x - n[k0].x);
      let x10 = null, x90 = null;
      for (let k = mid; k > 0 && x10 === null; k--) if ((n[k - 1].f - 0.1) * (n[k].f - 0.1) <= 0 && n[k].f !== n[k - 1].f) x10 = at(k - 1, k, 0.1);
      for (let k = mid; k < n.length - 1 && x90 === null; k++) if ((n[k].f - 0.9) * (n[k + 1].f - 0.9) <= 0 && n[k].f !== n[k + 1].f) x90 = at(k, k + 1, 0.9);
      const w = x10 === null || x90 === null ? NaN : x90 - x10;
      const expect = 0.626 * 2 * W;
      const maxDiff = Math.max(...n.map((r) => Math.abs(r.f - r.cpu)));
      out.penumbra = { L, W: +W.toFixed(2), width: +w.toFixed(2), expect: +expect.toFixed(2), err: +(w / expect - 1).toFixed(3), gpuVsCpu: +maxDiff.toFixed(3), rows,
        pass: Math.abs(w / expect - 1) <= 0.2 && maxDiff < 0.1 };
      console.log("penumbra", j(out.penumbra));
    }
    if (PARTS.includes("glare")) {
      // Owner report: in the umbra with the sun just off-screen its glare shone through the rock.
      // The analytic glare is not depth-tested, so it must follow the rock shadow at the eye.
      await parkAt(s.map((v) => -v * rock.radiusM * 3));
      const rows = [];
      for (const deg of [30, 38, 46, 54]) {
        await ev(`${G}.res.faceOffset(${j(rock)}, ${deg})`);
        await d.frames(20);
        const st = await ev("__shadow.status()");
        await ev("__lum.holdExposure(true)");
        await ev("__shadow.enable(true)"); await d.frames(6);
        const on = await reg("0,0,1,1");
        await ev("__shadow.enable(false)"); await d.frames(6);
        const off = await reg("0,0,1,1");
        await ev("__shadow.enable(true)");
        await ev("__lum.holdExposure(false)");
        rows.push({ deg, camVis: +st.cameraVisibility.toFixed(3), on: +on.toFixed(1), off: +off.toFixed(1), r: +(on / off).toFixed(3) });
        if (deg === 46) await d.canvas("shadow-glare-edge");
      }
      out.glare = { rows, pass: rows.every((r) => r.camVis < 0.01) };
      console.log("glare", j(out.glare));
    }
    if (PARTS.includes("map")) {
      // S2: ship on the rock's sun side, nose 90° off the sun → hull self-shadowing in profile.
      // Hull luma with the map term on vs bypassed (exposure held): < 1 where the hull shades itself.
      await parkAt(s.map((v) => v * rock.radiusM * 3));
      const rows = [];
      for (const deg of [0, 70, 110, 180]) {
        await ev(`${G}.res.faceOffset(${j(rock)}, ${180 + deg})`);
        await d.frames(30);
        await ev("__lum.holdExposure(true)");
        await ev("__shadow.map(false)"); await d.frames(6);
        const off = await reg(HULL);
        await d.canvas(`shadow-map-${deg}-off`);
        await ev("__shadow.map(true)"); await d.frames(6);
        const on = await reg(HULL);
        await d.canvas(`shadow-map-${deg}`);
        await ev("__lum.holdExposure(false)");
        rows.push({ deg, r: +(on / off).toFixed(3) });
      }
      out.map = { requested: await ev("__shadow.mapRequested()"), rows };
      console.log("map", j(out.map));
    }
    if (PARTS.includes("swim")) {
      // Texel-snapped map: step the ship sideways in 1/5-texel steps (0.15 m texels), sun from the
      // side, and compare the spread of the hull's shadow ratio with the same pose re-measured
      // (noise floor). Swimming shows as a spread well above the floor.
      const base = s.map((v) => v * rock.radiusM * 3);
      const measure = async (k) => {
        if (k === 0) {
          await parkAt(base);
          await ev(`${G}.res.faceOffset(${j(rock)}, 250)`);
          await d.frames(30);
        } else if (k === "step") {
          await ev(`${G}.res.nudge(${e[0] * 0.03}, ${e[1] * 0.03}, ${e[2] * 0.03})`);
          await d.frames(30);
        } else await d.frames(10);
        // Median of three A/B reads: one read now and then lands on a frame from before the switch.
        const rs = [];
        await ev("__lum.holdExposure(true)");
        for (let t = 0; t < 3; t++) {
          await ev("__shadow.map(false)"); await d.frames(6);
          const off = await reg(HULL);
          await ev("__shadow.map(true)"); await d.frames(6);
          rs.push(await reg(HULL) / off);
        }
        await ev("__lum.holdExposure(false)");
        return rs.sort((a, b) => a - b)[1];
      };
      const spread = (rows) => {
        const mean = rows.reduce((a, b) => a + b, 0) / rows.length;
        return { mean: +mean.toFixed(3), maxDev: +Math.max(...rows.map((r) => Math.abs(r / mean - 1))).toFixed(4), rows: rows.map((r) => +r.toFixed(3)) };
      };
      const still = [], step = [];
      await measure(0);
      for (let k = 0; k < 12; k++) still.push(await measure(null));
      // A point 1 km along e: its distance shrinks by the lateral move (proves the nudges land).
      const probe = C.map((v, i) => v + e[i]);
      const d0 = (await ev(`${G}.res.nav(${j(probe)})`)).distKm;
      for (let k = 0; k < 12; k++) step.push(await measure("step"));
      const movedM = (d0 - (await ev(`${G}.res.nav(${j(probe)})`)).distKm) * 1000;
      out.swim = { movedM: +movedM.toFixed(3), still: spread(still), step: spread(step) };
      // A/B reads now and then land on a stale frame (seen in the still set too; per-frame luma with
      // nothing toggled is constant), so: ≥ 10 of 12 stepped reads within 2 % of the median.
      const med = [...step].sort((a, b) => a - b)[6];
      out.swim.within2pct = step.filter((r) => Math.abs(r / med - 1) < 0.02).length;
      out.swim.pass = movedM > 0.3 && out.swim.within2pct >= 10;
      console.log("swim", j(out.swim));
    }
    if (PARTS.includes("shots")) {
      await parkAt(s.map((v) => -v * rock.radiusM * 2.5));
      await ev(`${G}.res.faceOffset(${j(rock)}, 150)`);
      await d.frames(30);
      await d.canvas("shadow-umbra-away");
    }
    if (PARTS.includes("bench")) {
      // Run twice with --perf: default and --query shadows=0. Every pass's GPU p50 here.
      await parkAt(s.map((v) => v * rock.radiusM * 3));
      await ev(`${G}.res.faceOffset(${j(rock)}, 250)`);
      await d.frames(60);
      await ev("__bench.reset()");
      await d.frames(200);
      const snap = await ev("JSON.parse(JSON.stringify(__bench.report()))");
      out.bench = { map: await ev("__shadow.mapRequested()"), passes: (snap.passes ?? []).map((p) => [p.label, +p.gpu.p50.toFixed(3)]) };
      console.log("bench", j(out.bench));
    }
    if (PARTS.includes("perf")) {
      await parkAt(s.map((v) => -v * rock.radiusM * 3));
      const local = async () => {
        await ev("__bench.reset()");
        await d.frames(150);
        const snap = await ev("JSON.parse(JSON.stringify(__bench.report()))");
        const pass = (snap.passes ?? []).find((p) => /local/i.test(p.label));
        return pass ? +pass.gpu.p50.toFixed(3) : null;
      };
      const r = { on: [], off: [] };
      for (let k = 0; k < 2; k++) {
        await ev("__shadow.clear(false)"); r.on.push(await local());
        await ev("__shadow.clear(true)"); r.off.push(await local());
      }
      await ev("__shadow.clear(false)");
      r.slots = (await ev("__shadow.status()")).occluders.length;
      r.gatherMs = (await ev("__shadow.status()")).gatherMs;
      out.perf = r;
      console.log("perf", j(r));
    }
  } finally {
    await ev("__shadow.enable(true); __shadow.force(false); __shadow.clear(false); __shadow.map(true)");
  }
  out.pass = ["umbra", "lit", "penumbra", "glare", "swim"].every((p) => !out[p] || out[p].pass);
  console.log(j(out));
  return out;
}
