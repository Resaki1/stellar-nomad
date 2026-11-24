/** Fabricate two utility drones and review their shipped model and lamps in flight. */
import assert from "node:assert/strict";

const G = "__test.gameplay";
const ID = "drone-model-workshop";
const YAW = 211 * Math.PI / 180;
const QUAT = [0, Math.sin(YAW / 2), 0, Math.cos(YAW / 2)];
const HOME = [0, 10_000, 0];
const FIRST_LANE = [8, 10, -12];
const j = JSON.stringify;

function shipPose([x, y, z]) {
  const [dx, dy, dz] = [x + FIRST_LANE[0], y + FIRST_LANE[1], z + FIRST_LANE[2]];
  const positionKm = [
    HOME[0] + (dx * Math.cos(YAW) + dz * Math.sin(YAW)) / 1000,
    HOME[1] + dy / 1000,
    HOME[2] + (dz * Math.cos(YAW) - dx * Math.sin(YAW)) / 1000,
  ];
  const yaw = (YAW + Math.atan2(-x, -z)) / 2;
  const pitch = Math.atan2(y, Math.hypot(x, z)) / 2;
  const quaternion = [Math.cos(yaw) * Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch),
    -Math.sin(yaw) * Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  return { frameId: "earth", positionKm, quaternion };
}

export default async function droneModel(d) {
  const ev = expression => d.evaluate(expression);
  const until = async (label, sample, timeout = 12_000) => {
    const end = Date.now() + timeout;
    do {
      const result = await sample();
      if (result) return result;
      await d.sleep(45);
    } while (Date.now() < end);
    throw Error(label);
  };
  const near = [-10, 7, 16];
  const previous = await ev("__test.save.info().id");
  const fixture = await ev(`(async () => {
    const g = ${G}, data = JSON.parse(await g.fixtures.export(${j(previous)})).data, by = g.localId();
    data.world.industry.depots = [{
      id: ${j(ID)}, name: "Drone Model Workshop", frameId: "earth", positionKm: ${j(HOME)}, quaternion: ${j(QUAT)},
      by, refinery: false, refineProgressS: 0,
      storage: { items: { fe_ni_metal: 90, silicates: 60, carbon: 20 }, consumables: {}, fuelKg: 0 },
    }];
    data.world.industry.drones = [];
    data.world.research.completedNodes = ["lg1_bulk_handling"];
    data.players[by].isDead = false;
    data.players[by].ship = ${j(shipPose(near))};
    return g.fixtures.create("drone-model", data);
  })()`);
  const drones = () => ev(G + ".world().industry.drones");
  const drawn = id => ev(`${G}.industry.drone(${j(id)})`);
  const teleport = async local => {
    const { frameId, positionKm, quaternion } = shipPose(local);
    await ev(`${G}.rep.teleportRel(${j(frameId)}, ${j(positionKm)}, ${j(quaternion)})`);
    await d.frames(5);
    await until("Ship did not reach the drone-relative pose", async () => {
      const s = await ev(G + ".rep.ship()");
      return s?.frameId === frameId && Math.hypot(...s.posKm.map((km, i) => km - positionKm[i])) < 0.0002;
    });
  };
  try {
    await ev(`${G}.fixtures.activate(${j(fixture)})`);
    await d.reload();
    await ev(`${G}.m37.comms.nameAi("Vega"); ${G}.m37.comms.dismiss()`);
    assert.deepEqual(await drones(), []);
    const requests = 'performance.getEntriesByType("resource").filter(e => e.name.includes("/models/drones/base-drone") && e.name.split("?")[0].endsWith(".glb"))';
    assert.equal(await ev(requests + ".length"), 0, "A world with no drones does not fetch drone models");
    for (let i = 0; i < 2; i++) {
      const outcome = await ev(`${G}.settled({type:"depot.fabricate", depotId:${j(ID)}, recipeId:"drone"})`);
      assert.equal(outcome.status, "accepted", j(outcome));
    }
    const [first, second] = await until("Two fabricated drones did not appear", async () => {
      const fleet = await drones();
      return fleet.length === 2 && fleet;
    });
    const close = await until("Fabricated drone model was not visible", async () => {
      const a = await drawn(first.id), b = await drawn(second.id);
      return a?.visible && b?.visible && a.level === 0 && b.level === 0 && a;
    });
    assert.ok(close.muzzleM, "The installed mesh exposes its mining socket");
    assert.equal(await ev(requests + ".length"), 3, "Both drones share three LOD fetches");
    await teleport(near);
    await d.settle(420);
    const shot = await d.canvas("base-drone-close");

    const beacon = intensity => until("Drone beacon phase did not change", async () => {
      const a = await drawn(first.id), b = await drawn(second.id);
      for (const model of [a, b]) {
        assert.equal(model?.lights["Amber drone status"], 1, "Ready windows stay lit");
      }
      return a.lights["Amber drone beacon"] === intensity && b.lights["Amber drone beacon"] === intensity && Date.now();
    }, 4000);
    await beacon(0);
    const firstFlash = await beacon(1);
    await beacon(0);
    const flashIntervalMs = await beacon(1) - firstFlash;
    assert.ok(flashIntervalMs > 1600 && flashIntervalMs < 2400, `Flash interval was ${flashIntervalMs} ms`);

    for (const [distance, level] of [[150, 1], [560, 2]]) {
      await teleport([0, 0, distance]);
      await until(`Expected LOD${level} at ${distance} m`, async () => (await drawn(first.id))?.level === level);
    }
    await teleport([0, 0, 3_400]);
    await until("Drone still visible past its culling range", async () => (await drawn(first.id))?.visible === false);
    await teleport(near);
    await until("Drone failed to restore LOD0 on approach", async () => (await drawn(first.id))?.level === 0);
    return { pass: true, shot, flashIntervalMs };
  } finally {
    await ev(`${G}.fixtures.activate(${j(previous)})`);
    await d.reload();
    assert.ok(await ev(`${G}.fixtures.remove(${j(fixture)})`));
  }
}
