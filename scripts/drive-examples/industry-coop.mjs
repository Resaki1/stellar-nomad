// COOP_PARTS=industry pnpm drive:coop -- --perf --url http://127.0.0.1:3012/ run:scripts/drive-examples/coop-check.mjs
// Two rendered browsers, production command paths and real active time. Only the starting
// building materials and travel between test sites use developer shortcuts.
import assert from "node:assert/strict";
import { earthMiningLoot, earthMiningRock, earthMiningSite } from "../lib/industry-rock.mjs";

const json = JSON.stringify;
const G = "__test.gameplay";
const C = "__test.coop";
const state = page => page.evaluate(`${G}.world().industry`);

export async function stockConstructionShip(host) {
  await host.evaluate(`__dev.grantCargo("fe_ni_metal", 650); __dev.grantCargo("silicates", 550); __dev.grantCargo("carbon", 80); true`);
}

async function visit(page, pose, offset = [0, 0, -0.8]) {
  const p = pose.positionKm.map((x, i) => x + offset[i]);
  await page.evaluate(`${G}.rep.teleportRel(${json(pose.frameId)}, ${json(p)}, [0,0,0,1])`);
  await page.frames(8);
  const ship = await page.evaluate(`${G}.rep.ship()`);
  assert.equal(ship.frameId, pose.frameId, "arrived in the intended frame");
  assert.ok(Math.hypot(...ship.posKm.map((x, i) => x - p[i])) < 0.12, "arrived within service range");
}

export async function supplyRoute({ host, guest, code, worldId, settledCommand, waitFor }) {
  await settledCommand(host, { type: "research.devSet", nodeIds: ["lg1_bulk_handling", "ex1_controlled_extraction", "lg2_station_refining"] });
  const { recipes, tuning } = await host.evaluate(`${G}.industry.catalog()`);
  const source = earthMiningRock;

  async function place(name, centre) {
    await settledCommand(host, { type: "item.craft", itemId: "consumable_depot_kit" });
    // Find open space inside the same region; the candidate can land inside a rock.
    for (let i = 0; i < 8; i++) {
      const pose = { ...centre, positionKm: centre.positionKm.map((x, k) => x + (k === 1 ? i * 0.2 : 0)), quaternion: [0, 0, 0, 1] };
      const obstruction = await host.evaluate(`${G}.rep.probe(${json(pose.frameId)},${json(pose.positionKm)})`);
      if (Number.isFinite(obstruction.rockClearM) && obstruction.rockClearM < 300) continue;
      await visit(host, pose);
      const { depotId } = await settledCommand(host, { type: "depot.place", name, ...pose });
      return { id: depotId, ...pose };
    }
    throw Error("No clear placement candidate near " + name);
  }
  const sourceDepot = await place("Prospect works", earthMiningSite(1.9));
  const relay = await place("Belt relay", earthMiningSite(5.9));
  const fieldDepot = await place("Far belt depot", earthMiningSite(2001.9));
  const routeKm = Math.hypot(...relay.positionKm.map((x, i) => x - sourceDepot.positionKm[i]));
  const fieldRouteKm = Math.hypot(...fieldDepot.positionKm.map((x, i) => x - sourceDepot.positionKm[i]));
  console.log(JSON.stringify({ stage: "commissioned", frameId: source.frameId, routeKm, fieldRouteKm, source: sourceDepot.id, relay: relay.id }));
  await visit(host, sourceDepot);
  await visit(guest, sourceDepot, [0.5, 0, 0]);
  const transfer = (depotId, direction, kind, itemId, amount) => ({ type: "depot.transfer", depotId, direction, kind, itemId, amount });

  // A contested final unit exercises atomic interaction between both ships and a shared hold.
  await settledCommand(host, transfer(sourceDepot.id, "deposit", "cargo", "carbon", 1));
  const beforeRace = await Promise.all([host, guest].map(p => p.evaluate(`${G}.player().cargo.items.carbon ?? 0`)));
  const claim = transfer(sourceDepot.id, "withdraw", "cargo", "carbon", 1);
  const race = await Promise.all([host, guest].map(p => p.evaluate(`${G}.settled(${json(claim)})`)));
  assert.deepEqual(race.map(r => r.status).sort(), ["accepted", "rejected"]);
  const afterRace = await Promise.all([host, guest].map(p => p.evaluate(`${G}.player().cargo.items.carbon ?? 0`)));
  assert.equal(afterRace[0] + afterRace[1], beforeRace[0] + beforeRace[1] + 1);

  const materials = {};
  for (const recipeId of ["refinery", "drone", "drone"]) {
    for (const [id, qty] of Object.entries(recipes.find(r => r.id === recipeId).recipe)) materials[id] = (materials[id] ?? 0) + qty;
  }
  for (const [itemId, amount] of Object.entries(materials)) {
    await settledCommand(host, transfer(sourceDepot.id, "deposit", "cargo", itemId, amount));
  }
  const fabricate = recipeId => settledCommand(host, { type: "depot.fabricate", depotId: sourceDepot.id, recipeId });
  await fabricate("refinery");
  const extractor = (await fabricate("drone")).droneId;
  const hauler = (await fabricate("drone")).droneId;
  assert.ok(extractor && hauler && extractor !== hauler);
  const assign = (page, droneId, job) => settledCommand(page, { type: "drone.configure", droneId, job: { enabled: true, ...job } });
  await visit(guest, relay);
  const requestedJob = { kind: "haul", targetId: fieldDepot.id, priorities: ["propellant"], reserveKg: 12, enabled: false };
  const requestedStops = [580, 600];
  const requestRace = await Promise.all([host, guest].map((page, index) => page.evaluate(`${G}.settled(${json({
    type: "drone.configure", droneId: hauler, onlyIfUnassigned: true, job: { ...requestedJob, stopAt: requestedStops[index] },
  })})`)));
  assert.deepEqual(requestRace.map(outcome => outcome.status).sort(), ["accepted", "rejected"]);
  assert.equal(requestRace.find(outcome => outcome.status === "rejected").reason, "drone_assigned");
  const winningJob = (await state(host)).drones.find(drone => drone.id === hauler).job;
  assert.equal(winningJob.targetId, fieldDepot.id);
  assert.equal(winningJob.stopAt, requestedStops[requestRace.findIndex(outcome => outcome.status === "accepted")]);
  await assign(guest, hauler, { kind: "haul", targetId: relay.id, priorities: ["propellant"], reserveKg: 12, stopAt: 600 });
  await visit(guest, sourceDepot, [0.5, 0, 0]);
  const mining = { kind: "mine", targetId: source.fieldId, priorities: [], mineFilter: { mode: "resource", ids: ["hydrates"] }, reserveKg: 0, stopAt: 200 };
  await assign(host, extractor, mining);
  // This is the only hand refuel in the run. Once the extractor departs, the hauler's
  // configured reserve makes it wait for the refinery before carrying its first load.
  await settledCommand(guest, transfer(sourceDepot.id, "deposit", "fuel", "fuel", 12));

  // Observe an actual rendered flight with the worker still ticking while this guest's
  // incoming messages are held. Sample within its approach, clear of docking and the worksite.
  const onLeg = await waitFor(async () => {
    const drone = (await state(guest)).drones.find(d => d.id === extractor);
    return drone?.phase === "outbound" && drone.remainingS === drone.durationS - 6;
  }, 40000, 50);
  assert.ok(onLeg, "guest observed the extraction drone leave");
  assert.equal(onLeg.flight.rock.instanceId, source.instanceId);
  const present = page => page.evaluate(`${G}.industry.rockPresent(${json(source)})`);
  assert.ok(await waitFor(() => present(guest), 7000, 100), "target rock was streamed on the guest");
  assert.ok(await guest.evaluate(`${C}.holdIncoming(1650)`));
  const samples = await guest.evaluate(`${G}.industry.trackDrone(${json(extractor)}, 2400)`);
  const speeds = [];
  let stoppedMs = 0, longestStopMs = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1], next = samples[i];
    assert.ok(prev.visible && next.visible, "the guest can see the extractor throughout its approach");
    const dt = next.frameMs - prev.frameMs;
    if (dt <= 0) continue;
    const metres = Math.hypot(...next.positionM.map((x, j) => x - prev.positionM[j]));
    const speed = metres * 1000 / dt;
    speeds.push(speed);
    stoppedMs = speed < 0.1 ? stoppedMs + dt : 0;
    longestStopMs = Math.max(longestStopMs, stoppedMs);
  }
  assert.ok(speeds.length > 10, "sampled individual rendered frames on the guest");
  speeds.sort((a, b) => a - b);
  const median = speeds[Math.floor(speeds.length / 2)], peak = speeds.at(-1);
  assert.ok(median > 1 && longestStopMs < 250, `mid-flight stall lasted ${longestStopMs} ms`);
  assert.ok(peak <= 1.5 * tuning.cruiseKmPerS * 1000 + 0.05,
    `snapshot catch-up produced a speed spike: ${peak} m/s, median ${median}`);
  console.log(JSON.stringify({ stage: "guest extractor flight", heldMs: 1650, frames: samples.length,
    longestStopMs: Math.round(longestStopMs), medianMps: Math.round(median), peakMps: Math.round(peak) }));
  assert.ok(await waitFor(async () => {
    const d = (await state(guest)).drones.find(drone => drone.id === extractor);
    return d.phase === "working" && (await guest.evaluate(`${G}.industry.drone(${json(extractor)})`))?.beam > 0.4;
  }, 35000, 120), "the guest renders the beam at the real rock");
  const mined = page => page.evaluate(
    `${G}.world().asteroidDeltas[${json(source.fieldId)}]?.[${json(source.chunkKey)}]?.filter(id => id === ${source.instanceId}).length ?? 0`);
  assert.ok(await waitFor(async () => (await mined(host)) === 1 && (await mined(guest)) === 1 && !(await present(guest)), 22000, 100),
    "shared mining depletes the streamed rock once on both peers");
  const miningPayload = (await state(host)).drones.find(d => d.id === extractor).cargo.items;
  assert.deepEqual(miningPayload, earthMiningLoot, "one rock yields the full material mix");
  console.log(JSON.stringify({ stage: "finite rock mined", instanceId: source.instanceId, cargo: miningPayload }));
  await visit(guest, relay);
  const denied = await guest.evaluate(`${G}.settled(${json(transfer(sourceDepot.id, "withdraw", "fuel", "fuel", 1))})`);
  assert.equal(denied.status, "rejected");
  assert.equal(denied.reason, "too_far");

  const shipFuel = () => guest.evaluate(`${G}.player().propellant.ordinaryKg`);
  const guestFuelBefore = await shipFuel();
  const stores = s => s.depots.find(d => d.id === relay.id).storage.fuelKg;
  const flight = s => s.drones.find(d => d.id === hauler);
  const outbound = await waitFor(async () => {
    const s = await state(host);
    return flight(s)?.phase === "outbound" && flight(s).cargo.fuelKg > 0 ? flight(s) : null;
  }, 120000, 300);
  assert.ok(outbound, "self-funded first shipment left the prospect depot");
  assert.ok(outbound.durationS >= 36 && outbound.durationS <= 39, "4 km basic-engine leg has a local ETA");
  const generation = (await host.evaluate(`${C}.status()`)).session.gen;
  console.log(JSON.stringify({ stage: "first departure", payloadKg: outbound.cargo.fuelKg, legS: outbound.durationS }));
  await host.load();
  await host.ready();
  assert.equal(await host.evaluate(`${C}.worldId()`), worldId);
  const reopened = await state(host);
  assert.equal(reopened.depots.length, 3, "all depots survived the host reload");
  assert.equal(reopened.drones.length, 2, "both drones survived the host reload");
  assert.equal(flight(reopened).phase, "outbound", "host reload restored the outgoing leg");
  assert.equal(flight(reopened).cargo.fuelKg, outbound.cargo.fuelKg, "in-flight payload survives restart");
  assert.equal(await host.evaluate(`${C}.host()`), code);
  assert.ok(await waitFor(async () => {
    const s = await guest.evaluate(`${C}.status()`);
    return s.status === "joined" && s.session?.gen === generation + 1;
  }, 60000, 400), "guest reclaimed the same ship");

  async function readRelayAtBoth(predicate, timeout) {
    return waitFor(async () => {
      const [a, b] = await Promise.all([host, guest].map(state));
      const fuel = stores(a);
      return fuel === stores(b) && predicate(fuel) ? fuel : null;
    }, timeout, 500);
  }
  const first = await readRelayAtBoth(n => n > 0, 180000);
  assert.equal(first, outbound.cargo.fuelKg, "first manifest unloaded exactly once");
  console.log(JSON.stringify({ stage: "first delivery after rejoin", fuelKg: first }));
  const usedKg = Math.min(5, first);
  await settledCommand(guest, transfer(relay.id, "withdraw", "fuel", "fuel", usedKg));
  assert.ok(Math.abs(await shipFuel() - guestFuelBefore - usedKg) < 0.01, "relay supplied the waiting ship");
  const second = await readRelayAtBoth(n => n > first - usedKg, 260000);
  assert.ok(second, "extraction, refining and transport funded a second delivery without player input");
  const final = await state(host);
  const saved = await host.evaluate(`${G}.fixtures.export(${json(worldId)}).then(s => JSON.parse(s).data.world.industry)`);
  assert.equal(stores(saved), second);
  assert.equal(stores(final), second);
  return { pass: true, frames: [sourceDepot.frameId, relay.frameId], routeKm, fieldRouteKm, legS: outbound.durationS, contestedUnit: race.map(r => r.status),
    contestedDrone: requestRace.map(outcome => outcome.status),
    restartGeneration: generation + 1, bootstrapKg: 12, firstDeliveryKg: first, withdrawnKg: usedKg,
    secondDeliveryKg: second - first + usedKg, durableRelayKg: stores(saved) };
}
