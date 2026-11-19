/**
 * Co-op mining (one page, normally the guest): warp near a cold-mineable rock, then mine it through
 * MiningSystem (aim, focus, start) so the claim goes through the session authority. Reports the
 * local mirror before/after and the settled stream entry. Check the host side with
 * `__test.coop.hostRecord(<playerId>)` on the host page.
 */
export default async function coopMine(d) {
  const ev = (e) => d.evaluate(e);
  const R = "__test.gameplay.res";
  const wait = (ms) => d.sleep(ms);
  let reach = null;
  for (let i = 0; i < 40; i++) {
    reach = await ev(`${R}.starterReach(5)`);
    if (reach.rocksLoaded > 100 && reach.nearestColdMineable.length > 0) break;
    await wait(500);
  }
  const target = reach?.nearestColdMineable?.[0];
  if (!target) return { pass: false, error: "no mineable rock", rocksLoaded: reach?.rocksLoaded };
  const tgt = JSON.stringify({ fieldId: target.fieldId, chunkKey: target.chunkKey, instanceId: target.instanceId });
  const before = await ev("__test.coop.mirror()");
  const standoffKm = Math.max(0.8, (target.radiusM / 1000) * 4);
  await ev(`${R}.warpNear(${tgt}, ${standoffKm})`);
  await d.frames(30);
  await wait(1500);
  await ev(`${R}.face(${tgt})`);
  let m = null;
  for (let i = 0; i < 60; i++) {
    await wait(200);
    await ev(`${R}.face(${tgt})`);
    m = await ev(`${R}.mining()`);
    if (m.focused && m.targetId === target.instanceId) break;
  }
  const focused = m?.focused && m?.targetId === target.instanceId;
  // COOP_FAULT=dropReply: lose the host's settled reply, then force a reconnect (rejoin + retry same intent).
  const fault = process.env.COOP_FAULT === "dropReply";
  if (fault) await ev("__test.coop.cutAfterCommit()");
  await ev(`${R}.startMining()`);
  const t0 = Date.now();
  for (let i = 0; i < 150; i++) {
    await wait(200);
    m = await ev(`${R}.mining()`);
    if (!m.mining) break;
  }
  const mineS = (Date.now() - t0) / 1000;
  let faultInfo = null;
  if (fault) {
    await wait(2000);
    const stuck = await ev("__test.coop.pending()");
    const mid = await ev("__test.coop.mirror()");
    await ev("__test.coop.forceReconnect()");
    faultInfo = { pendingAfterDrop: stuck, cargoBeforeRetry: mid.cargo.items };
  }
  // The claim is pending until the host's settled reply arrives.
  let pending = null;
  for (let i = 0; i < (fault ? 150 : 50); i++) {
    pending = await ev("__test.coop.pending()");
    if (!pending) break;
    await wait(200);
  }
  const after = await ev("__test.coop.mirror()");
  const status = await ev("__test.coop.status()");
  const gained = {};
  for (const [k, v] of Object.entries(after.cargo.items)) {
    const dv = v - (before.cargo.items[k] ?? 0);
    if (dv) gained[k] = dv;
  }
  return {
    pass: focused && !pending && Object.keys(gained).length > 0 && after.stream.outcome?.status === "accepted",
    playerId: status.playerId,
    target: { ...JSON.parse(tgt), radiusM: target.radiusM, mineS: target.mineS },
    focused,
    mineS,
    pendingLeft: pending,
    gained,
    stream: after.stream,
    revision: status.session?.revision,
    fault: faultInfo,
  };
}
