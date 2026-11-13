/**
 * Example `run:` script for scripts/drive.mjs — the shape of a quality-goal loop.
 *
 *   pnpm drive -- run:scripts/drive-examples/quality-gate.mjs
 *
 * Each check = scene → settle → capture → metric → threshold. The script returns a
 * JSON verdict; an agent iterating on a goal edits code, re-runs this, and stops when
 * every check passes. Thresholds here are illustrative, not calibrated: measure the
 * current build first, then set them from that baseline.
 */
export default async function qualityGate(d) {
  const checks = [
    // Sky band above the cloud deck: gradient banding shows up as long flat runs.
    { scene: "earth_horizon_8", name: "horizon8_sky", region: "0,0,0.45,1", max: { "banding.edgesPer1kPx": 15 } },
    // Lit disc from orbit: nothing clipped to white, nothing crushed to black.
    { scene: "earth_650", name: "earth650", region: "0.1,0.1,0.9,0.6", max: { clippedFrac: 0.001, blackFrac: 0.001 } },
  ];
  const get = (o, k) => k.split(".").reduce((v, p) => v?.[p], o);
  const results = [];
  for (const c of checks) {
    await d.scene(c.scene);
    const settle = await d.settle();
    const png = await d.canvas(c.name);
    const stats = await d.stats(c.region);
    const failures = Object.entries(c.max)
      .filter(([k, lim]) => !(get(stats, k) <= lim))
      .map(([k, lim]) => `${k}=${get(stats, k)} > ${lim}`);
    results.push({ check: c.name, pass: settle.settled && failures.length === 0, settled: settle.settled, failures, png });
  }
  return { pass: results.every((r) => r.pass), results };
}
