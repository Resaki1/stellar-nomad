/**
 * Fabricate utility drones with the actual Industry controls and verify the two inventories.
 * DRIVE_PROFILE=m5dronefab DRIVE_CDP_PORT=9353 pnpm drive -- --no-isolate --url http://127.0.0.1:3012/ run:scripts/drive-examples/drone-fabrication-cargo.mjs
 */
import assert from "node:assert/strict";

const G = "__test.gameplay";
const J = JSON.stringify;
const mixedId = "mixed-fabrication";
const remoteId = "remote-fabrication";
const recipeRow = '[data-industry-recipe="drone"]';
const craft = `${recipeRow} [data-industry-action="fabricate"]`;
const tab = '[data-industry-tab="fabrication"]';
const before = { fe_ni_metal: 80, silicates: 40, carbon: 20 };
const split = { fe_ni_metal: 20, silicates: 35, carbon: 3 };

export default async function droneFabricationCargo(d) {
  const ev = expression => d.evaluate(expression);
  const previous = await ev("__test.save.info().id");
  const fixture = await ev(`(async () => {
    const g = ${G}, data = JSON.parse(await g.fixtures.export(${J(previous)})).data, by = g.localId();
    const depot = (id, name, x, items) => ({ id, name, by, frameId: "earth", positionKm: [x,10_000,0], quaternion: [0,0,0,1],
      refinery: false, refineProgressS: 0, storage: { items, consumables: {}, fuelKg: 0 } });
    data.world.industry.depots = [depot(${J(mixedId)}, "Mixed workshop", 0, ${J(split)}),
      depot(${J(remoteId)}, "Remote workshop", 30, { fe_ni_metal: 45, silicates: 30, carbon: 10 })];
    data.world.industry.drones = [];
    data.world.research.completedNodes = ["lg1_bulk_handling"];
    data.players[by].cargo.items = ${J(before)};
    data.players[by].isDead = false;
    return g.fixtures.create("drone-fabrication-cargo", data);
  })()`);
  const until = async (label, expression) => {
    const end = Date.now() + 12_000;
    do {
      const value = await ev(expression);
      if (value) return value;
      await d.sleep(90);
    } while (Date.now() < end);
    throw Error(label);
  };
  const click = async selector => {
    const xy = await until(selector, `(() => {
      const el = document.querySelector(${J(selector)});
      if (!el || el.disabled) return false;
      el.scrollIntoView({block:"nearest"});
      const r = el.getBoundingClientRect(), x = r.x+r.width/2, y = r.y+r.height/2;
      return r.width && r.height && el.contains(document.elementFromPoint(x,y)) ? [x,y] : false;
    })()`);
    await d.click(...xy);
  };
  const shipAt = async z => {
    await ev(`${G}.rep.teleportRel("earth", [0,10_000,${z}], [0,0,0,1])`);
    await until("ship at expected range", `(() => {
      const s = ${G}.rep.ship();
      return s?.frameId === "earth" && Math.abs(s.posKm[0]) < 0.05 && Math.abs(s.posKm[1] - 10_000) < 0.05 && Math.abs(s.posKm[2] - ${z}) < 0.05;
    })()`);
  };
  const openFabrication = async id => {
    await click(`[data-industry-depot=${J(id)}]`);
    await click(tab);
    await until("fabrication controls shown", `!!document.querySelector(${J(craft)})`);
  };
  const cost = (id, kind) => {
    const source = kind === "missing" ? "[data-fabrication-missing]" : `[data-fabrication-from=${J(kind)}]`;
    const selector = `[data-fabrication-material=${J(id)}] ${source}`;
    return ev(`document.querySelector(${J(selector)})?.textContent ?? null`);
  };
  const stock = id => ev(`${G}.world().industry.depots.find(d => d.id === ${J(id)}).storage.items`);
  const cargo = () => ev(`${G}.player().cargo.items`);
  const droneCount = id => `${G}.world().industry.drones.filter(d => d.homeId === ${J(id)}).length`;
  const disabled = () => ev(`document.querySelector(${J(craft)}).disabled`);

  try {
    await ev(`${G}.fixtures.activate(${J(fixture)})`);
    await d.reload();
    await ev(`${G}.m37.comms.nameAi("Vega"); ${G}.m37.comms.dismiss()`);
    await shipAt(-5);
    await d.press("b");
    await openFabrication(mixedId);
    assert.equal(await disabled(), true, "The remote pilot's cargo cannot cover a depot shortfall");
    assert.equal(await cost("fe_ni_metal", "depot"), "20 from depot");
    assert.equal(await cost("fe_ni_metal", "ship"), null);
    assert.equal(await cost("fe_ni_metal", "missing"), "25 short");

    await openFabrication(remoteId);
    assert.equal(await disabled(), false);
    await click(craft);
    await until("remote depot-funded build", `${droneCount(remoteId)} === 1`);
    assert.deepEqual(await stock(remoteId), {});
    assert.deepEqual(await cargo(), before);

    await openFabrication(mixedId);
    await shipAt(-1.9);
    await until("ship-assisted build enabled", `document.querySelector(${J(craft)})?.disabled === false`);
    assert.deepEqual(await Promise.all([cost("fe_ni_metal", "depot"), cost("fe_ni_metal", "ship"),
      cost("silicates", "depot"), cost("silicates", "ship"), cost("carbon", "depot"), cost("carbon", "ship")]),
    ["20 from depot", "25 from your ship", "30 from depot", "0 from your ship", "3 from depot", "7 from your ship"]);
    await ev(`document.querySelector(${J(recipeRow)}).scrollIntoView({ block: "center" })`);
    const desktop = await d.shot("drone-fabrication-split");
    await d.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await d.frames(3);
    await ev(`document.querySelector(${J(recipeRow)}).scrollIntoView({ block: "center" })`);
    assert.equal(await ev(`(() => {
      const row = document.querySelector(${J(recipeRow)});
      return row.scrollWidth <= row.clientWidth + 1 &&
        [...row.querySelectorAll("[data-fabrication-material]")].every(item => item.scrollWidth <= item.clientWidth + 1);
    })()`), true, "The cost preview fits the phone layout");
    const phone = await d.shot("drone-fabrication-split-phone");
    await d.send("Emulation.clearDeviceMetricsOverride");

    await click(craft);
    await until("mixed-material build", `${droneCount(mixedId)} === 1`);
    await until("fabrication completion shown", 'document.querySelector(".industry__feedback [role=status]")?.textContent === "Utility drone ready."');
    assert.deepEqual(await stock(mixedId), { silicates: 5 });
    assert.deepEqual(await cargo(), { fe_ni_metal: 55, silicates: 40, carbon: 13 });
    assert.equal(await ev('document.querySelector(\'[data-industry-recipe="hull_patch"] [data-industry-action="fabricate"]\').disabled'), true,
      "Other recipes continue to use depot stock only");
    await click(craft);
    await until("second mixed-material build", `${droneCount(mixedId)} === 2`);
    assert.deepEqual(await stock(mixedId), {});
    assert.deepEqual(await cargo(), { fe_ni_metal: 10, silicates: 15, carbon: 3 });
    assert.equal(await disabled(), true, "Both drone bays are filled");
    return { pass: true, desktop, phone };
  } finally {
    await d.send("Emulation.clearDeviceMetricsOverride");
    await ev(`${G}.fixtures.activate(${J(previous)})`);
    await d.reload();
    await ev(`${G}.fixtures.remove(${J(fixture)})`);
  }
}
