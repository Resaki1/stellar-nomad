/**
 * VFX plan §4 S3 gates: emissive spill.
 *
 *   SPILL_PARTS=shadow,sun,pool,shots pnpm drive -- --keep --no-isolate run:scripts/drive-examples/vfx-spill.mjs
 *
 * A fixture replication point (98 steady lamps baked into its lightmaps). Station luma summed
 * over the HDR target with exposure held, baked spill on vs off at the same pose:
 * - shadow: key light forced off on ship-class receivers (`__shadow.force`) = the station in
 *           shadow → the baked lamps light the hull (luma up).
 * - sun:    same pose in sunlight → spill adds < 2 % and the same absolute luma (additive).
 * - pool:   two injected sources near the camera: the light takes the brighter; a 1.2× swap
 *           keeps it (hysteresis); a 3× swap hands over with a dip (fade out, then in) < 0.6 s.
 * - shots:  canvas pair in shadow, baked spill on/off.
 * - perf:   (--perf; again with --query spill=0) local-scene GPU ms.
 */
const G = "__test.gameplay";
const R = G + ".rep";
const FRAME = "earth";
const ID = "vfx-spill-review";
const CENTER = [0, 10_000, 0];
const YAW = 31 * Math.PI / 180;
const Q = [0, Math.sin(YAW / 2), 0, Math.cos(YAW / 2)];
const j = JSON.stringify;
const PARTS = (process.env.SPILL_PARTS ?? "shadow,sun,shots").split(",");

function move([x, y, z], angle = YAW) {
  return [x * Math.cos(angle) + z * Math.sin(angle), y, z * Math.cos(angle) - x * Math.sin(angle)];
}

export default async function vfxSpill(d) {
  const ev = (x) => d.evaluate(x);
  // Region reads can lag a switch by several frames (longer at vsync pacing): wait, then
  // require two equal reads 4 frames apart.
  const reg = async (box) => {
    await d.frames(6);
    let prev = (await ev(`__lum.region(${box})`)).sum;
    for (let k = 0; k < 12; k++) {
      await d.frames(4);
      const v = (await ev(`__lum.region(${box})`)).sum;
      if (Math.abs(v - prev) <= 1e-3 * Math.max(Math.abs(v), 1e-9)) return v;
      prev = v;
    }
    return prev;
  };
  const teleport = async (position) => {
    const destination = move(position).map((n, i) => CENTER[i] + n / 1000);
    await ev(`${R}.teleportRel(${j(FRAME)}, ${j(destination)}, ${j(Q)})`);
    await d.frames(6);
  };
  const previous = await ev("__test.save.info().id");
  const fixture = await ev(`(async () => {
    const game = ${G};
    const data = JSON.parse(await game.fixtures.export(${j(previous)})).data;
    const by = game.localId();
    data.world.replication.points = data.world.replication.points.filter(p => p.starter);
    data.world.replication.points.push({
      id: ${j(ID)}, name: "Spill trial", frameId: ${j(FRAME)}, positionKm: ${j(CENTER)},
      quaternion: ${j(Q)}, by, starter: false, createdAt: Date.now(),
    });
    data.players[by].isDead = false;
    return game.fixtures.create("vfx-spill", data);
  })()`);
  const out = {};
  // The station sits at screen centre, the ship's hull lower in frame.
  const BOX = "0.25,0.15,0.75,0.6";
  const ab = async () => {
    await ev("__lum.holdExposure(true)");
    await ev("__spill.baked(1)"); await d.frames(4);
    const on = await reg(BOX);
    await ev("__spill.baked(0)"); await d.frames(4);
    const off = await reg(BOX);
    await ev("__spill.baked(1)");
    await ev("__lum.holdExposure(false)");
    return { on: +on.toFixed(2), off: +off.toFixed(2), gain: +(on / off - 1).toFixed(4) };
  };
  try {
    await ev(`${G}.fixtures.activate(${j(fixture)})`);
    await d.reload();
    await ev(`__test.simRate(0); ${G}.m37.comms.dismiss(); __test.hud(false)`);
    await teleport([0, 0, -80]);
    await d.settle(900);
    if (PARTS.includes("shadow")) {
      await ev("__shadow.force(true)");
      await d.frames(60);
      const st = await ev("__spill.status()");
      const q = await ab();
      out.shadow = { ...q, bakedMaterials: st.baked.materials, pass: q.on > q.off && st.baked.materials > 0 };
      console.log("shadow", j(out.shadow));
    }
    if (PARTS.includes("sun")) {
      await ev("__shadow.force(false)");
      await d.frames(60);
      const q = await ab();
      // Spill is additive: the same luma in sun as in shadow, so its share in sunlight is tiny.
      const dS = out.shadow ? out.shadow.on - out.shadow.off : null;
      const dL = q.on - q.off;
      out.sun = { ...q, deltaSun: +dL.toFixed(2), deltaShadow: dS === null ? null : +dS.toFixed(2),
        pass: Math.abs(q.gain) < 0.02 && (dS === null || Math.abs(dL / dS - 1) < 0.1) };
      console.log("sun", j(out.sun));
    }
    if (PARTS.includes("pool")) {
      // Sources 5 m ahead of the camera, 4 m apart; impact-like intensity (8.5e4 cd).
      const I = 8.5e4 / 6037.7;
      const at = (dx, k) => `[${dx}, 0, -5, ${I * k}, ${I * k * 0.6}, ${I * k * 0.2}]`;
      const pick = async () => (await ev("__spill.status()")).lights[0];
      // Positions are camera-relative via a helper that offsets from the live camera.
      const inject = (a, b) => ev(`(() => { const m = __spill.cam(); const P = (s) => { const v = [s[0], s[1], s[2]]; return [m[12] + m[0]*v[0] + m[4]*v[1] + m[8]*v[2], m[13] + m[1]*v[0] + m[5]*v[1] + m[9]*v[2], m[14] + m[2]*v[0] + m[6]*v[1] + m[10]*v[2], s[3], s[4], s[5]]; }; __spill.inject([P(${a}), P(${b})]); })()`);
      await inject(at(-2, 1), at(2, 0.5));
      await d.frames(40);
      const first = await pick();
      await inject(at(-2, 1), at(2, 1.2));
      await d.frames(40);
      const kept = await pick();
      await inject(at(-2, 1), at(2, 3));
      const ws = [];
      for (let k = 0; k < 40; k++) { await d.frames(1); const l = await pick(); ws.push([+(await ev("performance.now()")).toFixed(0), +l.w.toFixed(2), +l.x.toFixed(1)]); }
      await ev("__spill.inject([])");
      const t0 = ws[0][0];
      const minW = Math.min(...ws.map((r) => r[1]));
      const back = ws.find((r, i) => i > 0 && r[1] >= 0.99 && ws.slice(0, i).some((q) => q[1] < 0.5));
      out.pool = { first: { x: +first.x.toFixed(1), w: first.w }, kept: { x: +kept.x.toFixed(1) }, minW, handoverMs: back ? back[0] - t0 : null,
        pass: first.live && first.w > 0.99 && Math.abs(kept.x - first.x) < 0.5 && minW < 0.1 && back !== undefined && back[0] - t0 < 600 && Math.abs(back[2] - first.x) > 2 };
      console.log("pool", j(out.pool));
    }
    if (PARTS.includes("shots")) {
      await ev("__shadow.force(true)");
      // Let the eye adapt to the shadow first (a held exposure from the sunlit part is ~black).
      await d.frames(300);
      await ev("__lum.holdExposure(true)");
      for (const g of [1, 0]) {
        await ev(`__spill.baked(${g})`); await d.frames(6);
        await d.canvas(`spill-shadow-${g ? "on" : "off"}`);
      }
      await ev("__spill.baked(1)");
      await ev("__lum.holdExposure(false)");
    }
    if (PARTS.includes("perf")) {
      await ev("__shadow.force(true)");
      await d.frames(60);
      await ev("__bench.reset()");
      await d.frames(Number(process.env.SPILL_BENCH_FRAMES ?? 400));
      const snap = await ev("JSON.parse(JSON.stringify(__bench.report()))");
      const pass = (snap.passes ?? []).find((p) => /local/i.test(p.label));
      out.perf = { url: await ev("location.search"), localMs: pass ? +pass.gpu.p50.toFixed(3) : null };
      console.log("perf", j(out.perf));
    }
  } finally {
    await ev("__shadow.force(false); __spill.gain(1); __spill.baked(1); __spill.inject([]); __test.simRate(1)").catch(() => {});
    await ev(`${G}.fixtures.activate(${j(previous)})`).catch(() => {});
  }
  out.pass = ["shadow", "sun", "pool"].every((p) => !out[p] || out[p].pass);
  console.log(j(out));
  return out;
}
