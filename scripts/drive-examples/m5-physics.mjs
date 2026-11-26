/**
 * M5 P4 solo gate: pnpm drive -- --perf --no-isolate run:scripts/drive-examples/m5-physics.mjs
 * Pilot contact gate: COOP_PARTS=pilotContact pnpm drive:coop -- run:scripts/drive-examples/coop-check.mjs
 */
import assert from "node:assert/strict";

const J = JSON.stringify;
const G = "__test.gameplay";
const P = "__phys";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function warp(page, frame, position, quaternion = [0, 0, 0, 1]) {
  await page.evaluate(`${G}.rep.teleportRel(${J(frame)}, ${J(position)}, ${J(quaternion)})`);
  await page.frames(6);
}

async function waitFor(fn, ms = 12000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const hit = await fn();
    if (hit) return hit;
    await sleep(50);
  }
  return null;
}

const impacts = page => page.evaluate(`${P}.impacts.log()`);
const hull = page => page.evaluate(`${P}.game.health().health`);
const ship = page => page.evaluate(`${G}.rep.ship()`);
const stationary = page => page.evaluate(`${G}.rep.runtime().speedMps < 1`);

async function stationDebrisGate(page) {
  const ev = page.evaluate;
  const at = [0, 10000, 0];
  const shipAt = z => [at[0], at[1], z / 1000];
  const docking = [0, 1, 0, 0];
  await warp(page, "earth", shipAt(800), docking);
  assert.equal((await ship(page)).frameId, "earth");
  const perf = await ev(`${P}.perf.enabled()`);
  const bench = async () => {
    await page.frames(90);
    await ev(`${P}.perf.reset()`);
    await page.frames(180);
    return ev(`${P}.perf.local()`);
  };
  const before = perf ? await bench() : null;
  await ev('__dev.grantCargo("fe_ni_metal", 250); __dev.grantCargo("silicates", 200); true');
  for (const trialId of ["first_fabrication", "first_batch"]) {
    await ev(`${G}.settled({type:"trial.record",trialId:${J(trialId)}})`);
  }
  assert.equal((await ev(`${G}.settled({type:"research.unlock",nodeId:"lg1_bulk_handling"})`)).status, "accepted");
  const crafted = await ev(`${G}.settled({type:"item.craft",itemId:"consumable_depot_kit"})`);
  assert.equal(crafted.status, "accepted", J(crafted));
  const placed = await ev(`${G}.settled({type:"depot.place",name:"P4 Contact Gate",frameId:"earth",positionKm:[0,10000,0],quaternion:[0,0,0,1]})`);
  assert.equal(placed.status, "accepted", J(placed));
  // One compound collider per depot (its convex pieces travel together), not one per piece.
  assert.ok(await waitFor(() => ev(`${P}.stats().collidersByTag.depot === 1`)), "station geometry registered in Rapier");
  const after = perf ? await bench() : null;
  const scenario = "Earth frame [0,10000,0], stationary ship 800 m from station";
  if (perf) console.log(J({ stage: "physics.step", scenario, before, after }));

  const screenshots = [];
  for (const x of [-58, 58]) {
    const y = 38, z = 94;
    const length = Math.hypot(x, y, z);
    const q = [y / length, -x / length, 0, 1 - z / length];
    const qLength = Math.hypot(...q);
    await warp(page, "earth", [at[0] + x / 1000, at[1] + y / 1000, at[2] + z / 1000], q.map(v => v / qLength));
    await page.frames(30);
    screenshots.push(await page.canvas(x < 0 ? "m5-depot-port" : "m5-depot-starboard"));
  }
  await ev(`${P}.impacts.clear()`);
  const h0 = await hull(page);
  await warp(page, "earth", shipAt(23), docking);
  await ev(`${P}.m5.coast([0,0,-0.0023])`);
  await sleep(3000);
  const low = { hull: await hull(page), pos: (await ship(page)).posKm, resting: await stationary(page) };
  assert.ok(low.pos[2] > 0.018, "slow approach stops on station");
  assert.ok(low.resting, "slow approach settles");
  assert.equal(low.hull, h0, "a docking-speed rub costs no hull");

  await warp(page, "earth", shipAt(65), docking);
  await ev(`${P}.impacts.clear(); ${P}.m5.coast([0,0,-0.04])`);
  const stationHit = await waitFor(async () => (await impacts(page)).find(i => i.damageHp > 0));
  assert.ok(stationHit, "40 m/s hit applies repulsion and damage");
  await sleep(500);
  const damage = (await impacts(page)).filter(i => i.damageHp > 0);
  assert.equal(damage.length, 1, "station contact episode charges once");
  assert.ok((await ship(page)).posKm[2] > 0.018, "fast approach cannot tunnel through the station");

  await warp(page, "earth", shipAt(5000), docking);
  assert.ok(await waitFor(() => ev(`!${P}.stats().collidersByTag.depot`)), "distant station colliders unload");

  const debris = await ev(`${P}.m5.debris()`);
  assert.equal(debris.peakBodies, 48);
  assert.equal(debris.remaining, 0);
  assert.equal(debris.shipContacts, 0);
  assert.ok(Math.abs(debris.shipDeltaM) < 0.01);
  assert.equal(debris.rebases, 1);
  assert.ok(debris.rebaseDeltaM < 0.002);
  assert.ok(debris.maxZM > 10 && debris.maxZM < 14.5 && debris.lastZM < debris.maxZM - 2, "a fragment passes the player and rebounds off fixed geometry");

  const speedGate = await ev(`__test.physics.simulate({
    startVelocityBodyMps: [0,0,980],
    rocks: [{ kind: "box", half: [8,4,12], posM: [0,0,45] }],
    segments: [{ decoupled: true, seconds: 0.12 }]
  })`);
  assert.ok(speedGate.suspensionLog.some(row => row.reason === "over-speed"), "physics surrenders over its speed gate");
  assert.equal(speedGate.impacts.length, 0, "the station solver does not handle a suspended flight");

  const source = await ev(`${G}.industry.catalog().spots.find(s => s.id === "earth_pocket")`);
  await warp(page, source.frameId, source.positionKm);
  const rock = await waitFor(async () => (await ev(`${P}.asteroids.nearest(1)`))[0], 30000);
  assert.ok(rock, "a real mineable rock is loaded in the volatile pocket");
  await ev(`${P}.asteroids.standoff(${rock.instanceId},150)`);
  await page.frames(8);
  assert.ok(await waitFor(() => ev(`${P}.asteroids.state(${rock.instanceId}).collider?.inEngine`)), "rock arrives in the solver's near field");
  const cargoBefore = await ev(`${P}.game.cargo()`);
  assert.ok(await ev(`${P}.asteroids.destroy(${rock.instanceId})`));
  assert.ok(await waitFor(() => ev(`${P}.stats().debris > 0`)), "committed asteroid destruction spawns real debris");
  assert.ok(await waitFor(() => ev(`${P}.stats().debris === 0`)), "committed fragments expire");
  assert.deepEqual(await ev(`${P}.game.cargo()`), cargoBefore, "fragments do not mint resources");
  assert.equal(await ev(`${P}.asteroids.state(${rock.instanceId}).loaded`), false);
  return { pass: true, scenario, before, after, low, stationHit,
    speedGate: speedGate.suspensionLog, debris, screenshots };
}

export default async function m5Physics(page) {
  const oldWorld = await page.evaluate("__test.save.info().id");
  assert.ok(oldWorld, "run the solo gate from an active world");
  const fixture = await page.evaluate(`${G}.fixtures.create("m5-physics", "new", { seed: 1 })`);
  try {
    await page.evaluate(`${G}.fixtures.activate(${J(fixture)})`);
    await page.reload();
    assert.equal(await page.evaluate("__test.save.info().id"), fixture);
    return await stationDebrisGate(page);
  } finally {
    await page.evaluate(`${G}.fixtures.activate(${J(oldWorld)})`);
    await page.reload();
    assert.equal(await page.evaluate("__test.save.info().id"), oldWorld);
    assert.equal(await page.evaluate(`${G}.fixtures.remove(${J(fixture)})`), true);
  }
}

/** Two real pilots in the same frame. Commands and poses use their normal WebRTC channels. */
export async function pilotContactGate({ host, guest }) {
  const at = [0, 10000, 0];
  const h0 = await hull(host), g0 = await hull(guest);
  const prepare = async (distanceM) => {
    await warp(host, "earth", at);
    await warp(guest, "earth", [at[0], at[1], distanceM / 1000], [0, 1, 0, 0]);
    await Promise.all([host, guest].map(p => p.evaluate(`${P}.impacts.clear()`)));
    await sleep(1500); // Fresh clock samples and both tracks before the approach.
  };
  await prepare(11);
  await guest.evaluate(`${P}.m5.coast([0,0,-0.002])`);
  await sleep(2800);
  const rub = [await ship(host), await ship(guest)];
  assert.equal(await hull(host), h0);
  assert.equal(await hull(guest), g0);
  assert.ok(rub[0].posKm[2] < -0.00015 && rub[1].posKm[2] - rub[0].posKm[2] > 0.006, "a gentle contact transfers motion while holding separation");

  await prepare(60);
  await guest.evaluate(`${P}.m5.coast([0,0,-0.04])`);
  const pair = await waitFor(async () => {
    const a = await impacts(host), b = await impacts(guest);
    const ha = a.find(i => i.colliderId < 0 && i.damageHp > 0), hb = b.find(i => i.colliderId < 0 && i.damageHp > 0);
    return ha && hb ? [ha, hb] : null;
  });
  assert.ok(pair, "both pilots apply the measured hit");
  assert.equal(pair[0].colliderId, pair[1].colliderId, "one host event owns both responses");
  assert.ok(Math.abs(pair[0].dvMps - pair[1].dvMps) < 1e-8);
  await sleep(400);
  const repeats = (await Promise.all([impacts(host), impacts(guest)])).map(rows => rows.filter(i => i.colliderId < 0 && i.damageHp > 0).length);
  assert.deepEqual(repeats, [1, 1], "exactly one damage event for either side");

  // Explicitly leave a remote pose at the crossing location by suspending its outbound pose delivery.
  await prepare(45);
  await guest.evaluate(`(() => {
    const original = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data) {
      if (this.label !== "pose") return original.call(this, data);
    };
    window.__restoreM5Pose = () => { RTCDataChannel.prototype.send = original; };
  })()`);
  try {
    await sleep(450);
    await host.evaluate(`${P}.m5.coast([0,0,0.04])`);
    await sleep(1700);
    const ghost = await impacts(host);
    assert.ok(ghost.every(i => i.colliderId >= 0), "an unrefreshed pilot pose cannot impart an impulse");
    assert.ok((await ship(host)).posKm[2] > 0.05, "the host passed through the stale location");
    return { pass: true, rub: rub.map(s => s.posKm), pair, repeats, ghost };
  } finally {
    await guest.evaluate("window.__restoreM5Pose(); delete window.__restoreM5Pose; true");
  }
}
