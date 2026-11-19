/**
 * Co-op presence helper (one page): fly to COOP_STANDOFF_KM (default 0.15) of the other pilot with
 * real keys, brake, face them and capture COOP_SHOT (e.g. coop/presence-guest). Run on either side:
 *   DRIVE_PROFILE=guest DRIVE_CDP_PORT=9342 pnpm drive -- --keep --no-isolate --query join=CODE run:scripts/drive-examples/coop-approach.mjs
 * COOP_APPROACH=meet (default) dev-warps behind them; fly = real keys; 0 = only face and capture.
 */
const KEY = {
  w: { key: "w", code: "KeyW", windowsVirtualKeyCode: 87 },
  s: { key: "s", code: "KeyS", windowsVirtualKeyCode: 83 },
  x: { key: "x", code: "KeyX", windowsVirtualKeyCode: 88 },
};
const down = (d, k) => d.send("Input.dispatchKeyEvent", { type: "keyDown", ...KEY[k] });
const up = (d, k) => d.send("Input.dispatchKeyEvent", { type: "keyUp", ...KEY[k] });

export default async function coopApproach(d) {
  const ev = (e) => d.evaluate(e);
  const standoff = Number(process.env.COOP_STANDOFF_KM ?? 0.15);
  const shot = process.env.COOP_SHOT ?? "coop/presence";
  const nav = () => ev("__test.coop.remoteNav()");
  let n = await nav();
  if (!n) return { pass: false, error: "no remote pilot" };
  const start = n;
  const mode = process.env.COOP_APPROACH ?? "meet";
  if (mode === "meet") {
    await ev(`__test.coop.meetRemote(${standoff})`);
    await d.frames(30);
    await d.sleep(1500);
  } else if (mode === "fly") {
    // Stop first, then a face-thrust-brake hop toward the other ship.
    await down(d, "s");
    await down(d, "x");
    for (let i = 0; i < 80 && (await nav()).speedMps > 1; i++) await d.sleep(100);
    await up(d, "x");
    await up(d, "s");
    await ev("__test.coop.faceRemote()");
    await down(d, "w");
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      await d.sleep(50);
      await ev("__test.coop.faceRemote()");
      n = await nav();
      const v = Math.max(0, n.closingMps);
      const stopKm = (v * v) / (2 * 90) / 1000 + (v * 0.6) / 1000;
      if (n.distKm - standoff <= stopKm) break;
    }
    await up(d, "w");
    await down(d, "s");
    await down(d, "x");
    for (let i = 0; i < 100 && (await nav()).speedMps > 0.5; i++) await d.sleep(100);
    await up(d, "x");
    await up(d, "s");
  }
  await d.sleep(500);
  await ev("__test.coop.faceRemote()");
  await d.frames(10);
  await ev("__test.coop.faceRemote()");
  await d.frames(5);
  const file = await d.shot(shot);
  n = await nav();
  return { pass: n.distKm < Math.max(1, standoff * 4), startKm: start.distKm, endKm: n.distKm, speedMps: n.speedMps, shot: file };
}
