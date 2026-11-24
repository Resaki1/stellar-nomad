/**
 * Far plumes (VFX plan §1 L1 / §5 E1): a remote-style ship (dev `__plumeProbe`) side-on on the
 * view axis; plume flux = HDR luma with throttle 1 minus throttle 0 (the hull cancels),
 * exposure held.
 *
 *   PLUME_PARTS=calib,ladder,shots pnpm drive -- --keep --no-isolate --uncapped run:scripts/drive-examples/vfx-plume.mjs
 *
 * - calib:  volume only vs point only at resolved distances → K so the point carries the
 *           volume's flux (prints the K to put in EngineExhaust's PLUME_POINT_K).
 * - ladder: natural crossfade from 80 m to 15 km: E·d² (flux × d²) stays within ±30 % of its
 *           median, and the far end is still lit (the old plume vanished at a few km).
 * - shots:  1 km and 5 km captures.
 */
const PARTS = (process.env.PLUME_PARTS ?? "calib,ladder,shots").split(",");
const j = JSON.stringify;

export default async function vfxPlume(d) {
  const ev = (x) => d.evaluate(x);
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
  await ev("__test.simRate(0); __test.hud(false)");
  const out = {};
  const cam = await ev("__spill.cam()");
  const fwd = [-cam[8], -cam[9], -cam[10]];
  const right = [cam[0], cam[1], cam[2]];
  // Ship +Z (nose) along camera right: the plume (−Z) runs across the view, side-on.
  const q = (() => {
    const a = [0, 0, 1], b = right;
    const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const w = 1 + a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const n = Math.hypot(...c, w);
    return [c[0] / n, c[1] / n, c[2] / n, w / n];
  })();
  const tanPerPx = (await ev("__lights.stats()")).tanPerPx;
  const box = (D) => {
    const hw = Math.min(0.5, Math.max(40, 30 / (D * tanPerPx)) / 1280), hh = Math.min(0.5, Math.max(40, 30 / (D * tanPerPx)) / 720);
    return [0.5 - hw, 0.5 - hh, 0.5 + hw, 0.5 + hh].map((v) => Math.min(1, Math.max(0, v))).join(",");
  };
  // Hide the player's own ship from the box: park the probe a little off-axis is not needed,
  // the player ship sits low in frame; the box is centred on the view axis.
  const place = (D, th) => ev(`__plumeProbe.set({ pos: [${cam[12] + fwd[0] * D}, ${cam[13] + fwd[1] * D}, ${cam[14] + fwd[2] * D}], quat: ${j(q)}, throttle: ${th} })`);
  const flux = async (D, force) => {
    await ev(`__lights.force(${force === undefined ? "" : force})`);
    await place(D, 1); await d.frames(30);
    await ev("__lum.holdExposure(true)");
    const on = await reg(box(D));
    await place(D, 0); await d.frames(30);
    const off = await reg(box(D));
    await ev("__lum.holdExposure(false)");
    await ev("__lights.force()");
    return on - off;
  };
  try {
    if (PARTS.includes("calib")) {
      const rows = [];
      for (const D of [60, 120, 250]) {
        const vol = await flux(D, 0), pt = await flux(D, 1);
        rows.push({ D, volume: +vol.toFixed(2), point: +pt.toFixed(2), ratio: +(vol / pt).toFixed(3) });
      }
      const k = await ev("__plumeProbe.getK()");
      const mean = rows.reduce((a, r) => a + r.ratio, 0) / rows.length;
      out.calib = { rows, K: k, suggestK: +(k * mean).toFixed(4) };
      console.log("calib", j(out.calib));
    }
    if (PARTS.includes("ladder")) {
      const rows = [];
      for (const D of [80, 150, 250, 400, 700, 1000, 2500, 5000, 10000, 15000]) {
        const f = await flux(D);
        rows.push({ D, flux: +f.toExponential(3), ed2: +(f * D * D).toExponential(3) });
      }
      // Against the median: the bells heat while the probe thrusts, so their glow drifts into
      // the on/off difference over the run (a few %); the plume itself must not dip or vanish.
      const med = rows.map((r) => r.ed2).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
      const dev = Math.max(...rows.map((r) => Math.abs(r.ed2 / med - 1)));
      out.ladder = { rows, median: med, maxDev: +dev.toFixed(3), pass: dev < 0.3 && rows.at(-1).flux > 0 };
      console.log("ladder", j(out.ladder));
    }
    if (PARTS.includes("shots")) {
      for (const D of [1000, 5000]) {
        await place(D, 1); await d.frames(40);
        await d.canvas(`plume-far-${D}`);
      }
    }
  } finally {
    await ev("__plumeProbe.hide(); __lights.force(); __test.simRate(1)").catch(() => {});
  }
  out.pass = !out.ladder || out.ladder.pass;
  console.log(j(out));
  return out;
}
