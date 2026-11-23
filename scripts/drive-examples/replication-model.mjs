/** Live respawn, instanced LOD selection, and player-ship contact with a rotated station. */
import assert from "node:assert/strict";

const G = "__test.gameplay";
const R = G + ".rep";
const FRAME = "earth";
const ID = "replication-model-review";
const CENTER = [0, 10_000, 0];
const SPAWN = [0, -16.55, -38.3];
const YAW = 31 * Math.PI / 180;
const Q = [0, Math.sin(YAW / 2), 0, Math.cos(YAW / 2)];
const j = JSON.stringify;

function move([x, y, z], angle = YAW) {
  return [x * Math.cos(angle) + z * Math.sin(angle), y, z * Math.cos(angle) - x * Math.sin(angle)];
}

function relative(positionKm) {
  return move(positionKm.map((n, i) => (n - CENTER[i]) * 1000), -YAW);
}

function product([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function lookAtCenter([x, y, z]) {
  const length = Math.hypot(x, y, z);
  const q = [y / length, -x / length, 0, 1 - z / length];
  return q.map(n => n / Math.hypot(...q));
}

export default async function replicationModel(d) {
  const ev = expression => d.evaluate(expression);
  const until = async (label, fn, ms = 12_000) => {
    const end = Date.now() + ms;
    do {
      const value = await fn();
      if (value) return value;
      await d.sleep(65);
    } while (Date.now() < end);
    throw Error(label);
  };
  const ship = () => ev(R + ".ship()");
  const lods = () => ev(R + ".lods()");
  const colliders = () => ev(R + ".colliders()");
  const teleport = async (position, lookAt = false) => {
    const destination = move(position).map((n, i) => CENTER[i] + n / 1000);
    const orientation = lookAt ? product(Q, lookAtCenter(position)) : Q;
    await ev(`${R}.teleportRel(${j(FRAME)}, ${j(destination)}, ${j(orientation)})`);
    // Let the pending dev warp reset velocity even if the old pose was already close.
    await d.frames(3);
    await until("Expected point-relative ship placement", async () => {
      const current = await ship();
      return current?.frameId === FRAME && Math.hypot(...relative(current.posKm).map((n, i) => n - position[i])) < 0.2;
    });
  };
  const coast = z => ev(`__phys.m5.coast(${j(move([0, 0, z / 1000]))})`);
  const previous = await ev("__test.save.info().id");
  const originalTuning = await ev("__phys.tuning.get()");
  const fixture = await ev(`(async () => {
    const game = ${G};
    const data = JSON.parse(await game.fixtures.export(${j(previous)})).data;
    const by = game.localId();
    data.world.replication.points = data.world.replication.points.filter(p => p.starter);
    data.world.replication.points.push({
      id: ${j(ID)}, name: "Fabricator trial", frameId: ${j(FRAME)}, positionKm: ${j(CENTER)},
      quaternion: ${j(Q)}, by, starter: false, createdAt: Date.now(),
    });
    data.players[by].isDead = false;
    data.players[by].replication.activeId = ${j(ID)};
    return game.fixtures.create("replication-model", data);
  })()`);

  try {
    await ev(`${G}.fixtures.activate(${j(fixture)})`);
    await d.reload();
    await ev(`__test.simRate(0); ${G}.m37.comms.dismiss(); ${G}.kill()`);
    await until("Death screen never offered recovery", () => ev('!!document.querySelector(".death-screen__respawn")'));
    await ev('document.querySelector(".death-screen__respawn").click()');
    await until("Recovery did not use the deployed point", () => ev(`(() => {
      const r = ${R}.runtime();
      return ${R}.lastRecovery()?.pointId === ${j(ID)} && !r.pending && !r.arriving && !r.paused;
    })()`));
    const respawned = await ship();
    const spawn = relative(respawned.posKm);
    assert.ok(Math.hypot(...spawn.map((n, i) => n - SPAWN[i])) < 0.2, `Unexpected respawn pose ${spawn}`);
    const outward = product(Q, [0, 1, 0, 0]);
    assert.ok(Math.abs(respawned.quat.reduce((sum, n, i) => sum + n * outward[i], 0)) > 0.9999, "Ship should face away from the station");
    await until("LOD0 did not render at respawn", async () => (await lods())[0] === 1);
    const [installed] = await until("Station collider did not reach Rapier", async () => {
      const items = await colliders();
      return items.length === 1 && items[0].inEngine && items;
    });
    assert.equal(installed.pieces, 37);
    const contacts = async id => (await ev("__phys.drainContacts()")).filter(c => c.colliderId === id);
    await contacts(installed.id);
    await coast(-10);
    await until("Departure from the real respawn position", async () => {
      assert.deepEqual(await contacts(installed.id), [], "Outward departure should be clear");
      return relative((await ship()).posKm)[2] < -60;
    }, 8_000);
    await coast(0);
    assert.deepEqual(await contacts(installed.id), []);

    await teleport([0, 0, -500]);
    await until("LOD0 did not persist at 500 m", async () => (await lods())[0] === 1);
    await d.settle(900);
    const distanceShot = await d.canvas("replication-lod0-500m");

    await teleport([67, 41, -112], true);
    await until("LOD0 did not render up close", async () => (await lods())[0] === 1);
    await d.settle(900);
    async function waitForBeacon(intensity) {
      return until(`Mast beacons did not turn ${intensity ? "on" : "off"}`, async () => {
        const lights = await ev(`${R}.lights()`);
        assert.equal(lights["Amber indicators"], 1, "Body lights remain steady");
        return lights["Amber mast beacons"] === intensity && Date.now();
      }, 3_500);
    }
    // Beacons blink on SIM time since VFX plan §1 (co-op peers agree): let it run.
    await ev("__test.simRate(1)");
    await waitForBeacon(0);
    const firstFlash = await waitForBeacon(1);
    const close = await d.canvas("replication-door-and-beacons");
    await waitForBeacon(0);
    const flashPeriodMs = (await waitForBeacon(1)) - firstFlash;
    assert.ok(flashPeriodMs > 1_650 && flashPeriodMs < 2_350, `Unexpected mast beacon period ${flashPeriodMs} ms`);
    await ev("__test.simRate(0)");

    await teleport([0, 0, -810]);
    await until("Mid LOD did not render at 810 m", async () => (await lods())[1] === 1);

    await teleport([0, 0, -2700]);
    await until("Far LOD or collider unloading failed", async () => (await lods())[2] === 1 && (await colliders()).length === 0);
    await teleport([0, 0, -810]);
    await until("Station did not reload", async () => (await lods())[1] === 1 && (await colliders())[0]?.inEngine);
    const { id } = (await colliders())[0];
    assert.notEqual(id, installed.id);
    assert.equal((await ev("__phys.stats()")).ship.source, "mesh");
    await ev("__phys.tuning.set({ noDamageSpeedMps: 1e5, lethalSpeedMps: 2e5 })");

    const stationContacts = () => contacts(id);
    async function hit(label, start, region) {
      await teleport(start);
      await stationContacts();
      await coast(18);
      const contact = await until(`No positive station contact against ${label}`, async () => {
        return (await stationContacts()).find(c => c.impulseNs > 0 && c.hasPoint);
      }, 4_000);
      await coast(0);
      const local = relative([contact.pxKm, contact.pyKm, contact.pzKm]);
      assert.ok(region(local), `Wrong contact location for ${label}: ${local}`);
      return { part: label, positionM: local.map(n => Math.round(n * 100) / 100), impulseNs: Math.round(contact.impulseNs) };
    }

    const wings = [];
    for (const sign of [-1, 1]) {
      wings.push(await hit(`wing ${sign}`, [sign * 35, 15.7, -24], ([x, y]) => sign * x > 26 && y > 8));
    }
    const arm = await hit("arm", [-32, -12.65, -45], ([x, y, z]) => x < -24 && y < -8 && z < -16);

    async function clearFlight(label, start, speed, finished) {
      await teleport(start);
      await stationContacts();
      await coast(speed);
      let lastPosition;
      const end = await until(`Ship did not complete ${label}`, async () => {
        assert.deepEqual(await stationContacts(), [], `Unexpected station contact during ${label}`);
        lastPosition = relative((await ship()).posKm);
        return finished(lastPosition[2]) && lastPosition;
      }, 8_000).catch(async (err) => {
        throw Error(`${err.message}. Local position ${lastPosition}, velocity ${(await ship()).velKmps}`);
      });
      await coast(0);
      assert.deepEqual(await stationContacts(), [], `Unexpected ending contact during ${label}`);
      return { path: label, fromZM: start[2], toZM: Math.round(end[2] * 100) / 100 };
    }

    const door = await hit("closed berth door", SPAWN, ([x, y, z]) => Math.abs(x) < 6.4 && y > -21.7 && y < -11.4 && Math.abs(z + 18.3) < 0.6);
    const outsideWing = await clearFlight("outside solar span", [46, 17.5, -17], 12, z => z > 10);
    await ev(`(() => {
      const point = ${R}.points().find(p => p.id === ${j(ID)});
      ${R}.devSetPoint({ ...point, id: "blocked-launch-fixture", positionKm: ${j(respawned.posKm)} });
    })()`);
    const alternative = await ev(`${R}.resolve("active")`);
    assert.equal(alternative.pointId, ID);
    assert.ok(alternative.candidate > 0 && Math.hypot(...relative(alternative.positionKm)) >= 499,
      "A neighbouring station that blocks the door should select an outer recovery position");
    return {
      pass: true, spawnM: spawn.map(n => Math.round(n * 100) / 100), outwardDeparture: true,
      lods: { 500: 0, 810: 1, 2700: 2 }, pieces: installed.pieces, wings, arm, door, outsideWing,
      alternativeCandidate: alternative.candidate, flashPeriodMs, distanceShot, close,
    };
  } finally {
    await ev(`__phys.tuning.set(${j(originalTuning)}); ${G}.fixtures.activate(${j(previous)})`);
    await d.reload();
    await ev(`${G}.fixtures.remove(${j(fixture)})`);
  }
}
