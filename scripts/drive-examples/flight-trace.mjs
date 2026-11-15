/**
 * Flight regression trace for scripts/drive.mjs.
 *
 *   pnpm drive -- run:scripts/drive-examples/flight-trace.mjs
 *
 * Warps to a fixed pose, runs a scripted key sequence and reports motion per fixed
 * sim step, so the numbers do not depend on frame rate or wall-clock jitter in the
 * key holds. Compare two builds by `perStep` values, not by absolute displacement.
 */
const sub = (a, b) => a.map((v, i) => v - b[i]);
const len = (a) => Math.hypot(...a);
/** Angle in degrees between two unit quaternions. */
const angDeg = (a, b) => {
  const d = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
  return (2 * Math.acos(d) * 180) / Math.PI;
};

export default async function flightTrace(d) {
  await d.scene("earth_650");
  await d.settle();
  const legs = [];
  let prev = (await d.state()).ship;
  const leg = async (name, key, ms) => {
    if (key) await d.hold(key, ms);
    else await d.evaluate(`new Promise(r => setTimeout(r, ${ms}))`);
    const s = (await d.state()).ship;
    const steps = s.steps - prev.steps;
    const movedM = len(sub(s.posKm, prev.posKm)) * 1000;
    const turnedDeg = angDeg(s.quat, prev.quat);
    legs.push({
      name, steps,
      movedM: +movedM.toFixed(2), turnedDeg: +turnedDeg.toFixed(3),
      mPerStep: +(movedM / steps).toFixed(5), degPerStep: +(turnedDeg / steps).toFixed(6),
    });
    prev = s;
  };
  await leg("throttle_up", "e", 2500);
  await leg("cruise", null, 3000);
  await leg("yaw_right", "d", 1500);
  await leg("coast_after_yaw", null, 1500);
  await leg("pitch_up", "w", 1500);
  await leg("throttle_down", "c", 2500);
  await leg("settle", null, 3000);
  const st = await d.state();
  return { speedMps: st.speedMps, throttle: st.throttle, legs };
}
