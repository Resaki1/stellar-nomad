/**
 * FIRST_EXPEDITION_PLAN WP3: the first-rock lead.
 *   pnpm drive -- --no-isolate run:scripts/drive-examples/expedition-wp3.mjs
 * On a fresh world: a lead appears within seconds, on a loaded, hydrate-bearing rock close by that the
 * starter laser finishes cold; a rock depleted by someone else is replaced; mining any other rock ends
 * the lead; a dismissed lead never returns. Prints one JSON line per check; fails on the first gate.
 */
import assert from "node:assert/strict";

const G = "__test.gameplay";
const j = JSON.stringify;

export default async function expeditionWp3(d) {
  const ev = (e) => d.evaluate(e);
  const until = async (label, expr, timeout = 20_000) => {
    const end = Date.now() + timeout;
    do {
      const r = await ev(expr);
      if (r) return r;
      await d.sleep(200);
    } while (Date.now() < end);
    throw Error(`timeout: ${label}`);
  };
  const previous = await ev("__test.save.info().id");
  const fresh = async (name) => {
    const id = await ev(`${G}.fixtures.create(${j(name)}, "new")`);
    await ev(`${G}.fixtures.activate(${j(id)})`);
    await d.reload();
    return id;
  };
  const lead = () => ev(`${G}.lead.state()`);
  const distKm = (l) => ev(`(() => { const a = ${G}.rep.abs(${j(l.frameId)}, ${j(l.positionKm)}), s = ${G}.rep.ship().absKm; return Math.hypot(a[0]-s[0], a[1]-s[1], a[2]-s[2]); })()`);
  const out = {};
  try {
    // 1. A fresh world offers a lead quickly.
    await fresh("wp3-lead");
    const t0 = Date.now();
    const first = await until("lead appears", `${G}.lead.state()`);
    out.first = { afterS: (Date.now() - t0) / 1000, className: first.className, radiusM: +first.radiusM.toFixed(1), hydrates: first.hydrates, mineS: +first.mineS.toFixed(1), distKm: +(await distKm(first)).toFixed(2) };
    console.log(j({ first: out.first }));
    assert.ok(out.first.afterS < 10, "a lead within seconds of control");
    assert.ok(first.hydrates > 0 && first.mineS <= 14 && out.first.distKm <= 30, "hydrate-bearing, cold, close");

    // 2. A crewmate (any other cause) depletes it: a different valid rock replaces it.
    const k = `${G}.settled({ type: "asteroid.destroy", fieldId: ${j(first.fieldId)}, chunkKey: ${j(first.chunkKey)}, instanceId: ${first.instanceId}, cause: "collision" })`;
    assert.equal((await ev(k)).status, "accepted");
    const second = await until("replacement lead", `(() => { const l = ${G}.lead.state(); return l && l.instanceId !== ${first.instanceId} ? l : null; })()`, 5000);
    out.replaced = { instanceId: second.instanceId, hydrates: second.hydrates, mineS: +second.mineS.toFixed(1) };
    console.log(j({ replaced: out.replaced }));

    // 3. Mining something else ends the lead (the pilot found their own way).
    const other = (await ev(`${G}.rep.rocks(40)`)).find((r) => r.instanceId !== second.instanceId);
    const mined = await ev(`${G}.settled({ type: "asteroid.mine", fieldId: ${j(other.fieldId)}, chunkKey: ${j(other.chunkKey)}, instanceId: ${other.instanceId}, beamS: 999 })`);
    assert.equal(mined.status, "accepted", j(mined));
    await until("lead ends after the first haul", `${G}.lead.state() === null`, 5000);
    await d.sleep(2500);
    out.endedByMining = (await lead()) === null;
    assert.ok(out.endedByMining, "stays ended");

    // 4. Dismissal is permanent (a fresh world, survives a reload).
    await fresh("wp3-dismiss");
    await until("lead appears", `${G}.lead.state()`);
    await ev(`${G}.lead.dismiss()`);
    await d.sleep(2500);
    const afterDismiss = await lead();
    await d.reload();
    await d.sleep(4000);
    out.dismissed = { now: afterDismiss === null, afterReload: (await lead()) === null };
    console.log(j({ dismissed: out.dismissed }));
    assert.ok(out.dismissed.now && out.dismissed.afterReload, "a dismissed lead never returns");
  } finally {
    await ev(`${G}.fixtures.activate(${j(previous)})`);
  }
  return out;
}
