// DRIVE_PROFILE=m5motion DRIVE_CDP_PORT=9350 pnpm drive -- --perf --no-isolate --url http://127.0.0.1:3012/ run:scripts/drive-examples/m5-drone-motion.mjs
import assert from "node:assert/strict";
import { earthMiningLoot, earthMiningRock, earthMiningSite } from "../lib/industry-rock.mjs";

const J = JSON.stringify;
const G = "__test.gameplay";
const I = G + ".industry";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const offset = (a, b) => a.map((x, i) => x + b[i]);
const distance = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
const tuples = points => Array.from({ length: points.length / 3 }, (_, i) => points.slice(i * 3, i * 3 + 3));

async function waitFor(sample, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await sample();
    if (value) return value;
    await sleep(45);
  }
  return null;
}

async function warp(page, frameId, positionKm, quaternion = [0, 0, 0, 1]) {
  await page.evaluate(`${G}.rep.teleportRel(${J(frameId)}, ${J(positionKm)}, ${J(quaternion)})`);
  await page.frames(8);
}

async function verifyProspect(page, source, site) {
  const ev = page.evaluate;
  const rendered = () => ev(`${I}.prospect(${J(source.id)})`);
  const contact = () => ev("__phys.impacts.log()");
  const observer = offset(site, [0, 0, 0.055]);

  // Still inside the 30 km extraction range.
  await warp(page, source.frameId, offset(site, [0, 0, 5]));
  const far = await waitFor(rendered);
  assert.ok(far, "prospect group exists in the local render scene");
  assert.equal(far.visible, false);
  assert.equal(far.colliders.length, 0, "the extraction radius carries no collision hull");

  await warp(page, source.frameId, observer, [0, 1, 0, 0]);
  const near = await waitFor(async () => {
    const geometry = await rendered();
    return geometry?.visible && geometry.colliders.every(c => c.pose) && geometry.colliders.length === 3 && geometry;
  });
  assert.ok(near, "all three rendered rocks share the near-field solver");
  const poseErrorM = Math.max(...near.parts.map((mesh, i) => {
    const collider = near.colliders[i];
    const colliderM = collider.pose.relKm.map((x, k) => (x - observer[k]) * 1000);
    const drawM = offset(near.positionM, mesh.positionM);
    const dot = mesh.quaternion.reduce((sum, q, k) => sum + q * collider.pose.quat[k], 0);
    assert.ok(Math.abs(dot) > 0.99999, "Rapier and renderer use the same mesh rotation");
    const engineVertices = tuples(collider.points);
    const meshVertices = tuples(mesh.points);
    assert.ok(engineVertices.length >= 20, "rock uses a convex hull");
    const vertexErrorM = Math.max(...engineVertices.map(p => Math.min(...meshVertices.map(m => distance(p, m)))));
    assert.ok(vertexErrorM < 0.001, "convex hull vertices match the scaled rock mesh");
    return distance(colliderM, drawM);
  }));
  assert.ok(poseErrorM < 0.02, `prospect's meshes align with Rapier to 2 cm, measured ${poseErrorM} m`);

  // Validate both placement authorities where the visible rocks are the obstruction.
  const place = { name: "Blocked trial", frameId: source.frameId, positionKm: site, quaternion: [0, 0, 0, 1] };
  await warp(page, source.frameId, offset(site, [0, 0, 0.8]));
  const depotBlocked = await ev(`${G}.settled(${J({ type: "depot.place", ...place })})`);
  assert.equal(depotBlocked.reason, "near_rock");
  const pointBlocked = await ev(`${G}.settled(${J({ type: "replication.place", ...place })})`);
  assert.equal(pointBlocked.reason, "near_rock");

  await warp(page, source.frameId, observer, [0, 1, 0, 0]);
  await ev("__phys.impacts.clear(); __phys.m5.coast([0,0,-0.035])");
  const hit = await waitFor(async () => (await contact()).find(i => near.colliders.some(c => c.id === i.colliderId)));
  assert.ok(hit?.damageHp > 0, "35 m/s approach hits the rendered prospect");
  const ship = await ev(`${G}.rep.ship()`);
  assert.ok(ship.posKm[2] - site[2] > 0.003, "the approaching ship does not tunnel through the rock");
  await warp(page, source.frameId, offset(site, [0, 0, 5]));
  assert.equal((await rendered()).colliders.length, 0, "prospect collision unloads outside the near field");
  return { poseErrorM, impactMps: hit.dvMps };
}

async function verifyFlight(page, rock, home, droneId, tuning) {
  const ev = page.evaluate;
  const record = () => ev(`${G}.world().industry.drones.find(d => d.id === ${J(droneId)})`);
  const rendered = () => ev(`${I}.drone(${J(droneId)})`);
  const paused = on => ev(`${G}.res.setLoadingPause(${on})`);
  const baseline = await ev("__test.flight.simulate({ segments: [{ seconds: 10, throttle: 1 }] }).segments[0]");
  assert.ok(baseline.peakSpeedMps > 400 && baseline.peakSpeedMps < 405, "compared with the baseline Replicant main engine without boost");
  await warp(page, rock.frameId, offset(home.positionKm, [0, 0, -0.8]));
  const present = () => ev(`${I}.rockPresent(${J(rock)})`);
  assert.ok(await waitFor(present), "the generated target is visible to the asteroid streamer before mining");
  const parked = await rendered();
  assert.ok(parked, `drone group exists in the local render scene (authority: ${J(await record())})`);
  assert.ok(parked.visible, "parked drone is visible at the observing ship");
  const tracking = ev(`${I}.trackDrone(${J(droneId)}, 64000)`, 70000);
  await page.frames(2);
  const job = { kind: "mine", targetId: rock.fieldId, priorities: [], mineFilter: { mode: "resource", ids: ["hydrates"] },
    reserveKg: 0, stopAt: tuning.cargoCapacity, enabled: true };
  const configure = next => ev(`${G}.settled(${J({ type: "drone.configure", droneId, job: next })})`);
  const configured = await configure(job);
  assert.equal(configured.status, "accepted", J(configured));

  const working = await waitFor(async () => {
    const current = await record();
    return current.phase === "working" && (await rendered()).beam > 0.7 && current;
  }, 30000);
  assert.ok(working, "committed mining turns on the beam");
  assert.equal(working.flight.rock.instanceId, rock.instanceId);
  assert.equal(working.flight.rock.chunkKey, rock.chunkKey);
  const liveShip = await ev(`${G}.rep.ship()`);
  const miningPose = await rendered();
  const rockCentreM = rock.positionKm.map((km, i) => (km - liveShip.posKm[i]) * 1000);
  assert.ok(Math.abs(distance(rockCentreM, miningPose.positionM) - (rock.radiusM + 14)) < 2,
    "the beam drone hovers just off the generated rock surface");
  assert.equal((await configure({ ...job, enabled: false })).status, "accepted");
  let frozen;
  try {
    await paused(true);
    await page.frames(2);
    frozen = await rendered();
    const countdown = await record();
    await sleep(1300);
    await page.frames(2);
    const during = await rendered();
    assert.ok(distance(during.positionM, frozen.positionM) < 0.01, "extraction hover freezes while the sim is paused");
    assert.equal(during.beam, frozen.beam, "beam fade/scan freezes too");
    assert.equal((await record()).remainingS, countdown.remainingS, "the authority pauses with the renderer");
  } finally {
    await paused(false);
  }

  const samples = await tracking;
  assert.ok(samples.length > 100, "sampled live WebGPU frames over the whole trip");
  assert.ok(samples.every(s => s.visible), "the whole short extraction flight remains in the observer's render range");
  const firstOutbound = samples.findIndex(s => s.phase === "outbound");
  const firstWork = samples.findIndex(s => s.phase === "working");
  const firstReturn = samples.findIndex(s => s.phase === "returning");
  const lastIdle = samples.findIndex((s, i) => s.phase === "idle" && i > firstReturn);
  assert.ok(firstOutbound >= 0 && firstOutbound < firstWork && firstWork < firstReturn && firstReturn < lastIdle,
    `outbound, working, returning and idle were recorded in order (${firstOutbound}, ${firstWork}, ${firstReturn}, ${lastIdle})`);
  const work = samples.slice(firstWork, firstReturn);
  assert.ok(samples.slice(0, firstWork).every(s => s.beam === 0), "beam waits for committed extraction");
  assert.ok(work.some(s => s.beam > 0.1 && s.beam < 0.55) && work.some(s => s.beam > 0.7),
    "beam ramps up through intermediate opacity");
  const finalBeam = samples.findLastIndex(s => s.beam > 0);
  assert.ok(finalBeam > firstWork && finalBeam < lastIdle && samples[finalBeam].beam < 0.1,
    "beam fades at the end of the work phase");
  const rows = samples.slice(firstOutbound + 1, lastIdle + 1).map((next, i) => {
    const prev = samples[firstOutbound + i];
    const dt = next.frameMs - prev.frameMs;
    const wallDt = next.atMs - prev.atMs;
    const metres = distance(next.positionM, prev.positionM);
    return { ...next, dt, wallDt, speed: metres * 1000 / dt, wallSpeed: metres * 1000 / wallDt };
  }).filter(r => r.dt >= 4 && r.dt <= 150);
  const fromX = parked.positionM[0], toX = work.at(-1).positionM[0];
  const progress = s => (s.positionM[0] - fromX) / (toX - fromX);
  const midLeg = rows.filter(s => s.phase === "outbound" && progress(s) > 0.15 && progress(s) < 0.85);
  const speedAt = (group, min, max) => {
    const bucket = group.filter(s => progress(s) >= min && progress(s) <= max).map(r => r.speed).sort((a, b) => a - b);
    assert.ok(bucket.length > 1, "rendered enough frames in the speed measurement window");
    return bucket[Math.floor(bucket.length / 2)];
  };
  const outbound = rows.filter(s => s.atMs < samples[firstWork].atMs);
  const approach = rows.filter(s => s.atMs < samples[firstReturn].atMs);
  const returning = rows.filter(s => s.phase === "returning");
  const departureMps = speedAt(outbound, 0, 0.025);
  const settledMps = speedAt(approach, 0.975, 0.9999);
  const returningMps = speedAt(returning, 0.975, 0.9999);
  const midMps = speedAt(midLeg, 0.25, 0.75);
  assert.ok(midMps > 90 && departureMps < midMps * 0.6 && settledMps < midMps * 0.6 && returningMps < midMps * 0.6,
    `drone visibly accelerates and brakes (start ${departureMps}, cruise ${midMps}, finish ${settledMps}, return ${returningMps})`);
  let stoppedMs = 0, longestStopMs = 0, longestStopAtMs = 0;
  for (const row of midLeg) {
    stoppedMs = row.speed < 2 ? stoppedMs + row.dt : 0;
    if (stoppedMs > longestStopMs) {
      longestStopMs = stoppedMs;
      longestStopAtMs = row.atMs;
    }
  }
  const peakMps = Math.max(...rows.map(r => r.speed));
  const wallPeakMps = Math.max(...rows.filter(r => r.wallDt >= 4 && r.wallDt <= 150).map(r => r.wallSpeed));
  if (longestStopMs >= 150) {
    const snapshots = samples.filter((s, i) => s.remainingS !== samples[i - 1]?.remainingS &&
      Math.abs(s.atMs - longestStopAtMs) <= 3500);
    console.log(J({ stage: "countdown boundary", peakMps, longestStopMs, longestStopAtMs,
      snapshots: snapshots.map(s => ({ atMs: s.atMs, remainingS: s.remainingS })) }));
  }
  assert.ok(longestStopMs < 150, `flight paused for ${longestStopMs} ms at a countdown boundary`);
  assert.ok(peakMps <= 1.5 * tuning.cruiseKmPerS * 1000 + 0.05,
    `renderer-clock peak ${peakMps} m/s stays within the local thruster limit including snapshot catch-up`);
  assert.ok(wallPeakMps > 0 && wallPeakMps < baseline.peakSpeedMps,
    `wall-clock samples of rendered positions peaked at ${wallPeakMps} m/s, below the ${baseline.peakSpeedMps} m/s Replicant`);
  assert.ok(distance((await rendered()).positionM, parked.positionM) < 0.02, "return docks at the same lane's starting position");
  const world = await ev(`${G}.world().industry`);
  assert.deepEqual(world.depots[0].storage.items, { ...earthMiningLoot, carbon: earthMiningLoot.carbon + 20 });
  assert.deepEqual(world.drones[0].cargo.items, {}, "the return delivered the full manifest exactly once");
  assert.equal(await present(), false, "the real generated rock disappears from the loaded chunk");
  const depleted = await ev(`${G}.world().asteroidDeltas[${J(rock.fieldId)}][${J(rock.chunkKey)}]`);
  assert.equal(depleted.filter(id => id === rock.instanceId).length, 1);
  return { frames: samples.length, legS: working.returnS, departureMps, midMps, settledMps, returningMps, peakMps, wallPeakMps,
    baselineMps: baseline.peakSpeedMps, longestStopMs };
}

async function verifyRestoredFieldFlight(page, fixture, home, relay, droneId) {
  const ev = page.evaluate;
  const record = () => ev(`${G}.world().industry.drones.find(d => d.id === ${J(droneId)})`);
  const configured = await ev(`${G}.settled(${J({
    type: "drone.configure", droneId, job: {
      kind: "haul", targetId: relay.id, priorities: ["carbon"], reserveKg: 10, stopAt: 100, enabled: true,
    },
  })})`);
  assert.equal(configured.status, "accepted", J(configured));
  const flight = await waitFor(async () => {
    const drone = await record();
    return drone.phase === "outbound" && drone;
  });
  assert.ok(flight, "the shared authority committed the far outbound flight");
  assert.equal(flight.flight.profile, "field");
  assert.equal(flight.cargo.items.carbon, 20 + earthMiningLoot.carbon);
  assert.ok(flight.durationS > 440 && flight.durationS < 480);

  // Start a replay near the middle of the committed leg to exercise real reload/rendering
  // without waiting several minutes before reaching the measured portion.
  const saved = JSON.parse(await ev(`${G}.fixtures.export(${J(fixture)})`)).data;
  const funded = saved.world.industry.drones.find(d => d.id === droneId);
  assert.equal(funded.phase, "outbound");
  const replayS = Math.ceil(funded.durationS / 2) + 5;
  funded.remainingS = replayS;
  const replay = await ev(`${G}.fixtures.create("m5-field-midflight", ${J(saved)})`);
  try {
    await ev(`${G}.fixtures.activate(${J(replay)})`);
    await page.reload();
    const restored = await record();
    assert.equal(restored.phase, "outbound");
    assert.deepEqual(restored.flight, flight.flight);
    assert.equal(restored.fuelKg, flight.fuelKg);
    assert.equal(restored.cargo.items.carbon, flight.cargo.items.carbon);
    assert.ok(restored.remainingS <= replayS && restored.remainingS > 204);
    assert.ok(await waitFor(() => ev(`${I}.drone(${J(droneId)})`)), "restored drone is in the scene");
    const samples = await ev(`(() => {
      const id = ${J(droneId)};
      const position = ${I}.drone(id).positionM;
      const observer = ${G}.rep.ship();
      const p = observer.posKm.map((km, i) => km + (position[i] + (i === 0 ? 2100 : i === 2 ? 750 : 0)) / 1000);
      ${G}.rep.teleportRel(${J(home.frameId)}, p, [0,0,0,1]);
      return ${I}.trackDrone(id, 1100);
    })()`);
    const speeds = samples.slice(1).flatMap((s, i) => {
      const prev = samples[i];
      const dt = s.frameMs - prev.frameMs;
      if (!prev.visible || !s.visible || dt < 4 || dt > 120) return [];
      return [distance(s.positionM, prev.positionM) * 1000 / dt];
    }).sort((a, b) => a - b);
    assert.ok(speeds.length > 10, `observed ${speeds.length} rendered frames as the restored drone crossed the ship`);
    const medianMps = speeds[Math.floor(speeds.length / 2)];
    assert.ok(medianMps > 8000 && medianMps < 11000, `restored field flight crossed at ${medianMps} m/s`);
    assert.ok(speeds.at(-1) < 16000, `snapshot correction stayed within field-flight limits: ${speeds.at(-1)} m/s`);
    return { pathKm: distance(home.positionKm, relay.positionKm), legS: flight.durationS,
      fuelEscrowKg: flight.fuelKg, frames: speeds.length, medianMps, peakMps: speeds.at(-1) };
  } finally {
    await ev(`${G}.fixtures.activate(${J(fixture)})`);
    await page.reload();
    assert.ok(await ev(`${G}.fixtures.remove(${J(replay)})`));
  }
}

export default async function m5DroneMotion(page) {
  const ev = page.evaluate;
  const { id: old, schemaVersion } = await ev("__test.save.info()");
  const { sources, tuning } = await ev(`${I}.catalog()`);
  const source = sources.find(s => s.id === "earth_hydrates");
  const site = offset(source.positionKm, [0, 0.085, 0]);
  const me = await ev(`${G}.localId()`);
  const home = { id: "home", name: "Hydrate Works", by: me, ...earthMiningSite(1.9),
    quaternion: [0, 0, 0, 1], storage: { fuelKg: 100, items: { carbon: 20 } } };
  const relay = { ...home, id: "field-relay", name: "Field Relay", positionKm: offset(home.positionKm, [2150, 0, 0]),
    storage: { fuelKg: 0 } };
  const drone = { id: "extractor", homeId: home.id, phase: "idle", status: "unassigned" };
  const hauler = { ...drone, id: "field-hauler" };
  const state = { schemaVersion, world: { industry: { depots: [home, relay], drones: [drone, hauler] },
    research: { completedNodes: ["ex1_controlled_extraction"] } },
    players: { [me]: { modules: { consumables: { consumable_depot_kit: 1, consumable_replication_kit: 1 } } } } };
  const fixture = await ev(`${G}.fixtures.create("m5-motion", ${J(state)})`);
  try {
    await ev(`${G}.fixtures.activate(${J(fixture)})`);
    await page.reload();
    assert.equal(await ev("__test.save.info().id"), fixture);
    const prospect = await verifyProspect(page, source, site);
    console.log(J({ stage: "prospect contact", ...prospect }));
    const flight = await verifyFlight(page, earthMiningRock, home, drone.id, tuning);
    console.log(J({ stage: "terminal flight", ...flight }));
    const fieldFlight = await verifyRestoredFieldFlight(page, fixture, home, relay, hauler.id);
    return { pass: true, prospect, flight, fieldFlight };
  } finally {
    await ev(`${G}.fixtures.activate(${J(old)})`);
    await page.reload();
    assert.ok(await ev(`${G}.fixtures.remove(${J(fixture)})`));
  }
}
