/** Live depot review with a rotated fixture, real player ship and fixed Rapier collider. */
import assert from "node:assert/strict";

const G = "__test.gameplay";
const FRAME = "earth";
const ID = "depot-model-review";
const CENTER = [0, 10_000, 0];
const YAW = 211 * Math.PI / 180;
const ROTATION = [0, Math.sin(YAW / 2), 0, Math.cos(YAW / 2)];
const j = JSON.stringify;

function rotate([x, y, z], angle = YAW) {
  return [x * Math.cos(angle) + z * Math.sin(angle), y, z * Math.cos(angle) - x * Math.sin(angle)];
}

function localMetres(positionKm) {
  return rotate(positionKm.map((n, i) => (n - CENTER[i]) * 1000), -YAW);
}

function worldKm(positionM) {
  return rotate(positionM).map((n, i) => CENTER[i] + n / 1000);
}

function lookAtDepot([x, y, z]) {
  const yaw = (YAW + Math.atan2(-x, -z)) * 0.5;
  const pitch = Math.atan2(y, Math.hypot(x, z)) * 0.5;
  return [Math.cos(yaw) * Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch),
    -Math.sin(yaw) * Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
}

export default async function depotModel(d) {
  const ev = expression => d.evaluate(expression);
  const ship = () => ev(G + ".rep.ship()");
  const model = () => ev(`${G}.industry.depotModel(${j(ID)})`);
  const colliders = () => ev(G + ".industry.depotColliders()");
  const until = async (label, sample, timeout = 12_000) => {
    const deadline = Date.now() + timeout;
    do {
      const value = await sample();
      if (value) return value;
      await d.sleep(55);
    } while (Date.now() < deadline);
    throw Error(label);
  };
  const teleport = async (position, orientation = ROTATION) => {
    await ev(`${G}.rep.teleportRel(${j(FRAME)}, ${j(worldKm(position))}, ${j(orientation)})`);
    await d.frames(3);
    await until("Ship did not reach the depot-relative pose", async () => {
      const state = await ship();
      return state?.frameId === FRAME &&
        Math.hypot(...localMetres(state.posKm).map((n, i) => n - position[i])) < 0.2;
    });
  };
  const coast = (velocityMps) => ev(`__phys.m5.coast(${j(rotate(velocityMps).map(n => n / 1000))})`);

  const previous = await ev("__test.save.info().id");
  const tuning = await ev("__phys.tuning.get()");
  const initial = [0, 0, 40.4];
  const fixture = await ev(`(async () => {
    const game = ${G};
    const data = JSON.parse(await game.fixtures.export(${j(previous)})).data;
    const by = game.localId();
    data.world.industry.depots = [{
      id: ${j(ID)}, name: "Depot Flight Review", frameId: ${j(FRAME)}, positionKm: ${j(CENTER)},
      quaternion: ${j(ROTATION)}, by, createdAt: Date.now(), refinery: false, refineProgressS: 0,
      storage: { items: {}, consumables: {}, fuelKg: 0 },
    }];
    data.world.industry.drones = [];
    data.world.replication.points = data.world.replication.points.filter(point => point.starter);
    const player = data.players[by];
    player.replication.activeId = "starter";
    player.isDead = false;
    player.ship = {frameId: ${j(FRAME)}, positionKm: ${j(worldKm(initial))}, quaternion: ${j(lookAtDepot(initial))}};
    return game.fixtures.create("depot-model", data);
  })()`);

  try {
    await ev(`${G}.fixtures.activate(${j(fixture)})`);
    await d.reload();
    await ev(`__test.simRate(0); ${G}.m37.comms.dismiss()`);
    await teleport(initial, lookAtDepot(initial));
    const first = await until("The station has no fixed Rapier collider", async () => {
      const list = await colliders();
      return list.length === 1 && list[0].inEngine && list[0];
    });
    assert.equal(first.pieces, 89);
    assert.equal((await ev("__phys.stats()")).ship.source, "mesh");
    await until("Close depot LOD never loaded", async () => (await model())?.level === 0);
    await d.settle(420);
    const approachShot = await d.canvas("depot-docking-approach-20m");

    const oblique = [-34, 19, 57];
    await teleport(oblique, lookAtDepot(oblique));
    await d.settle(420);
    async function beacon(intensity) {
      return until("Depot beacons did not switch", async () => {
        const lights = (await model())?.lights;
        assert.equal(lights?.["Amber depot guides"], 1, "Docking and telemetry lights remain steady");
        return lights?.["Amber depot mast beacons"] === intensity && Date.now();
      }, 4_000);
    }
    await beacon(0);
    const firstFlash = await beacon(1);
    const closeShot = await d.canvas("depot-close-beacons");
    await beacon(0);
    const flashIntervalMs = (await beacon(1)) - firstFlash;
    assert.ok(flashIntervalMs > 1600 && flashIntervalMs < 2400, `Flash interval was ${flashIntervalMs} ms`);

    for (const [distance, expected] of [[500, 0], [850, 1], [3800, 2]]) {
      await teleport([0,0,distance], lookAtDepot(initial));
      await until(`Incorrect LOD at ${distance} m`, async () => (await model())?.level === expected);
    }
    await until("Far-away collider remained loaded", async () => !(await colliders()).length);
    await teleport([0,0,850], lookAtDepot(initial));
    const installed = await until("Collider failed to reload after returning", async () => {
      const list = await colliders();
      return list.length === 1 && list[0].inEngine && list[0];
    });
    assert.notEqual(installed.id, first.id);
    await ev("__phys.tuning.set({ noDamageSpeedMps: 1e5, lethalSpeedMps: 2e5 })");
    const contacts = async () => (await ev("__phys.drainContacts()")).filter(contact => contact.colliderId === installed.id);

    async function clearFlight(name, position, velocity, finished, orientation) {
      await teleport(position, orientation);
      await contacts();
      await coast(velocity);
      const end = await until(`Did not finish ${name}`, async () => {
        assert.deepEqual(await contacts(), [], `Unexpected contact on ${name}`);
        const at = localMetres((await ship()).posKm);
        return finished(at) && at;
      }, 8_000);
      await coast([0,0,0]);
      assert.deepEqual(await contacts(), [], `Ending contact on ${name}`);
      return end.map(n => Math.round(n * 100) / 100);
    }

    const dockingClear = await clearFlight("centreline docking approach", [0,0,71], [0,0,-13],
      ([,,z]) => z < 27.5, lookAtDepot(initial));

    async function hit(name, position, velocity, intersects, orientation) {
      await teleport(position, orientation);
      await contacts();
      await coast(velocity);
      const impact = await until(`No contact on ${name}`, async () => {
        return (await contacts()).find(contact => contact.hasPoint && contact.impulseNs > 0);
      }, 4_000);
      await coast([0,0,0]);
      const at = localMetres([impact.pxKm, impact.pyKm, impact.pzKm]);
      assert.ok(intersects(at), `Impact outside ${name} at ${at}`);
      return { name, positionM: at.map(n => Math.round(n * 100) / 100), impulseNs: Math.round(impact.impulseNs) };
    }

    const backing = await hit("recessed docking backing", initial, [0,0,-10],
      ([x,y,z]) => Math.abs(x) < 2 && Math.abs(y) < 1.5 && z > 19 && z < 20.65, lookAtDepot(initial));
    const panels = [];
    for (const sign of [-1, 1]) {
      panels.push(await hit(`solar panel ${sign}`, [sign * 14.8, 10, -15.5], [0,-12,0],
        ([x,y,z]) => sign*x > 9 && sign*x <= 13.4 && y < 0.6 && Math.abs(z+15.5) < 1.8));
    }
    const overPanel = await clearFlight("over the solar tray", [14.8, 3.2, -25], [0,0,11], ([,,z]) => z > -8);
    return {
      pass: true, lods: { 500: 0, 850: 1, 3800: 2 }, pieces: installed.pieces, dockingClear,
      backing, panels, overPanel, flashIntervalMs, approachShot, closeShot,
    };
  } finally {
    await ev(`__phys.tuning.set(${j(tuning)}); ${G}.fixtures.activate(${j(previous)})`);
    await d.reload();
    await ev(`${G}.fixtures.remove(${j(fixture)})`);
  }
}
