/**
 * Point tank installation, stable transfer controls, drone setup, and recovery via the visible HUD.
 * DRIVE_PROFILE=m5pointfuel DRIVE_CDP_PORT=9353 pnpm drive -- --perf --no-isolate --url http://127.0.0.1:3012/ run:scripts/drive-examples/replication-fuel.mjs
 * Set POINT_FUEL_TOUCH=1 for the same flow with a 390×844 touch viewport.
 * Set POINT_FUEL_LAYOUT_ONLY=1 to stop after the delivery draft and skip the simulated flight.
 */
import assert from "node:assert/strict";

const G = "__test.gameplay";
const j = JSON.stringify;
const pointId = "fuel-test-point";
const depotId = "fuel-test-depot";
const droneId = "fuel-test-hauler";
const destination = "Cinder Refuge";
const frameId = "earth";
const near = [0, 10_000, -1.2];
const details = `[data-point-tank-details="${pointId}"]`;
const transfer = direction => `${details} [data-point-tank-action="${direction}"]`;
const stock = `${G}.world().industry.pointTanks[${j(pointId)}]`;
const aimFor = `${G}.rep.teleportRel(${j(frameId)}, ${j(near)}, [0,0,0,1])`;

export default async function replicationFuel(d) {
  const touch = process.env.POINT_FUEL_TOUCH === "1";
  const layoutOnly = process.env.POINT_FUEL_LAYOUT_ONLY === "1";
  const ev = expression => d.evaluate(expression);
  const previous = await ev("__test.save.info().id");
  const fixture = await ev(`(async () => {
    const g = ${G}, who = g.localId(), data = JSON.parse(await g.fixtures.export(${j(previous)})).data;
    const pose = { frameId: ${j(frameId)}, positionKm: [0,10_000,0], quaternion: [0,0,0,1] };
    data.world.replication.points = [...data.world.replication.points.filter(p => p.starter),
      { ...pose, id: ${j(pointId)}, name: ${j(destination)}, by: who, starter: false, createdAt: Date.now() }];
    data.world.industry.depots = [{ ...pose, id: ${j(depotId)}, name: "Refinery Post", by: who, positionKm: [1.5,10_000,0],
      refinery: false, refineProgressS: 0, storage: { items: {}, consumables: {}, fuelKg: 300 } }];
    data.world.industry.drones = [{ id: ${j(droneId)}, homeId: ${j(depotId)}, job: null,
      phase: "idle", status: "unassigned", remainingS: 0, durationS: 0, fuelKg: 0, returnS: 0,
      via: null, cargo: { items: {}, consumables: {}, fuelKg: 0 } }];
    data.world.industry.pointTanks = {};
    data.world.research.completedNodes = [];
    const me = data.players[who];
    me.isDead = false;
    me.propellant = { ordinaryKg: 200, protectedKg: 25 };
    me.replication.activeId = ${j(pointId)};
    me.cargo.items = { fe_ni_metal: 150, silicates: 80 };
    return g.fixtures.create("replication-fuel", data);
  })()`);

  const until = async (label, expression, timeout = 10_000) => {
    const end = Date.now() + timeout;
    do {
      const result = await ev(expression);
      if (result) return result;
      await d.sleep(90);
    } while (Date.now() < end);
    throw Error(label);
  };
  const text = selector => ev(`document.querySelector(${j(selector)})?.textContent?.trim()`);
  const click = async selector => {
    for (let i = 0; i < 10; i++) {
      const [x, y, comms] = await until(selector, `(() => {
        const el = document.querySelector(${j(selector)});
        if (!el || el.disabled) return false;
        el.scrollIntoView({block:"nearest"});
        const r = el.getBoundingClientRect(), x = r.x+r.width/2, y = r.y+r.height/2;
        const hit = document.elementFromPoint(x,y);
        if (r.width && r.height && el.contains(hit)) return [x,y,false];
        // A tutorial arriving during setup can sit over the point card on a short viewport.
        return ${selector === "[data-point-fuel-open]"} && hit?.closest(".comms-overlay") ? [x,y,true] : false;
      })()`);
      if (touch) {
        await d.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        await d.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else await d.click(x, y);
      if (!comms) return;
      await d.frames(2);
    }
    throw Error(`Comms did not clear ${selector}`);
  };
  const fill = async (selector, value) => {
    await click(selector);
    await d.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, commands: ["SelectAll"] });
    await d.type(value);
  };
  const select = async (selector, value) => {
    await until(selector, `[...document.querySelector(${j(selector)})?.options ?? []].some(o => o.value === ${j(value)} && !o.disabled)`);
    await ev(`(() => {
      const input = document.querySelector(${j(selector)});
      input.value = ${j(value)};
      input.dispatchEvent(new Event("change",{bubbles:true}));
    })()`);
  };
  const amountSelector = `${details} [data-point-tank-amount]`;
  const pointRosterItem = "[data-industry-points]";
  const depotRosterItem = `[data-industry-depot="${depotId}"]`;
  const reveal = selector => until(`Fully visible active roster entry: ${selector}`, `(() => {
    const list = document.querySelector(".industry__roster");
    const item = list?.querySelector(${j(selector)});
    if (!item || item.getAttribute("aria-current") !== "true") return false;
    const entry = item.getBoundingClientRect(), viewport = list.getBoundingClientRect();
    const left = viewport.left + list.clientLeft, right = left + list.clientWidth;
    return entry.left >= left - 0.75 && entry.right <= right + 0.75
      ? { left: entry.left, right: entry.right, viewport: [left, right], scrollX: list.scrollLeft }
      : false;
  })()`);
  const detailScroll = 'document.querySelector(".industry__detail").scrollTop';

  try {
    if (touch) {
      await d.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
      await d.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 3 });
    }
    await ev(`${G}.fixtures.activate(${j(fixture)})`);
    await d.reload();
    if (touch) {
      await until("phone navigation is mounted", 'innerWidth === 390 && matchMedia("(pointer:coarse)").matches && !!document.querySelector(".touch-flight")');
    }
    await ev(`${G}.m37.comms.nameAi("Vega"); ${G}.m37.comms.dismiss(); ${aimFor}`);
    await until("ship reached the point", `(() => {
      const ship = ${G}.rep.ship();
      return ship?.frameId === ${j(frameId)} && Math.hypot(...ship.posKm.map((axis,i) => axis - ${j(near)}[i])) < 0.05;
    })()`);
    await click('[data-point-fuel-open]');
    let directlyOpenedRoster;
    if (touch) {
      directlyOpenedRoster = await reveal(pointRosterItem);
      assert.ok(directlyOpenedRoster.scrollX > 0, "Opening a point directly reveals the last item of the narrow roster");
      const before = await ev(`(() => {
        document.querySelector(".panel__close").focus({ preventScroll: true });
        const top = ${detailScroll};
        document.querySelector(${j(depotRosterItem)}).click();
        return top;
      })()`);
      await reveal(depotRosterItem);
      assert.equal(await ev('document.activeElement?.matches(".panel__close")'), true, "Revealing a new roster item keeps focus in place");
      assert.equal(await ev(detailScroll), before);
      await ev(`document.querySelector(${j(pointRosterItem)}).click()`);
      await reveal(pointRosterItem);
    }
    assert.equal(await ev(`document.querySelector(${j(details)})?.open`), true, "Fuel opens the matching point directly");
    assert.match(await text(`${details} [data-required-research]`), /Bulk Handling/);
    assert.equal(await ev(`document.querySelector(${j(transfer("install"))})?.disabled`), true);
    await ev(`${G}.m33.devSetWorld({ completedNodes: ["lg1_bulk_handling"] })`);
    await click(transfer("install"));
    await until("empty tank installed", `${stock} === 0`);
    assert.deepEqual(await ev(`${G}.player().cargo.items`), { fe_ni_metal: 30, silicates: 30 });
    assert.match(await text(`${details} [data-point-tank-stock]`), /0 \/ 1,200 kg/);

    await fill(amountSelector, "85");
    await click(transfer("deposit"));
    await until("85 kg deposited", `${stock} === 85`);
    assert.deepEqual(await ev(`${G}.player().propellant`), { ordinaryKg: 115, protectedKg: 25 });
    await fill(amountSelector, "5");
    const depositHeight = () => ev(`document.querySelector(${j(details)}).getBoundingClientRect().height`);
    const before = await depositHeight();
    await click(transfer("withdraw"));
    await until("5 kg withdrawn", `${stock} === 80`);
    assert.equal(await depositHeight(), before, "An accepted transfer leaves panel layout stable");
    assert.deepEqual(await ev(`${G}.player().propellant`), { ordinaryKg: 120, protectedKg: 25 });
    const stockShot = await d.shot(`point-tank-stock${touch ? "-phone" : ""}`);
    if (touch) {
      const controls = await ev(`(() => {
        const tank = document.querySelector(${j(details)});
        return [...tank.querySelectorAll("summary,input,button")].map(control => {
          const r = control.getBoundingClientRect();
          return { name: control.dataset.pointTankAction ?? control.tagName, h: r.height, l: r.left, r: r.right };
        });
      })()`);
      assert.ok(controls.every(control => control.h >= 44 && control.l >= 0 && control.r <= 390),
        `Tank controls fit the phone screen with 44 px targets: ${JSON.stringify(controls)}`);
    }

    await click(transfer("request"));
    assert.match(await text("[data-industry-delivery-request]"), /Cinder Refuge/);
    await select("[data-industry-request-source]", depotId);
    await select("[data-industry-request-drone]", droneId);
    await click('[data-industry-action="edit-requested-delivery"]');
    const deliveryRoster = touch ? await reveal(depotRosterItem) : undefined;
    assert.equal(await ev('document.querySelector("[data-industry-job-target]")?.selectedOptions[0]?.textContent.includes("Cinder Refuge")'), true);
    await fill("[data-industry-job-reserve]", "20");
    await fill("[data-industry-job-stop]", "118");
    const requestShot = await d.shot(`point-tank-delivery-draft${touch ? "-phone" : ""}`);
    if (layoutOnly) return { pass: true, touch, directlyOpenedRoster, deliveryRoster, stockShot, requestShot };
    await click('[data-industry-action="start-job"]');
    const job = await until("funded point delivery started", `${G}.world().industry.drones[0]?.job`);
    assert.deepEqual(job, { kind: "haul", targetKind: "point", targetId: pointId, priorities: ["propellant"], reserveKg: 20, stopAt: 118, enabled: true });
    if (touch) await click(".panel__close");
    else await d.press("Escape");
    await until("38 kg delivered", `Math.abs(${stock} - 118) < 1e-6`, 35_000);

    await ev("__test.save.flush()");
    await d.reload();
    assert.equal(await ev(stock), 118, "Point fuel delivery persists across reload");
    const destroy = await ev(`${G}.settled({ type:"ship.destroy", frameId:${j(frameId)}, positionKm:${j(near)} })`);
    assert.equal(destroy.status, "accepted");
    await until("point-specific recovery preview", 'document.querySelector("[data-testid=recovery-point-fuel]")?.textContent.includes("118 kg ordinary propellant")');
    await click(".death-screen__respawn");
    await until("respawn consumes exactly the shared point balance", `${stock} === 0 && !document.querySelector(".death-screen")`);
    const fuel = await ev(`${G}.player().propellant`);
    const allowance = await ev(`${G}.m33.liveTuning().recoveryAllowanceKg`);
    assert.deepEqual(fuel, { ordinaryKg: 118, protectedKg: allowance });
    return { pass: true, touch, fuel, stockShot, requestShot };
  } catch (error) {
    if (touch) {
      console.log("Point tank phone diagnostic", await ev(`(() => {
        const button = document.querySelector("[data-point-fuel-open]"), r = button?.getBoundingClientRect();
        return {
          size: [innerWidth, innerHeight], focus: ${G}.m37.site.focus(), ship: ${G}.rep.ship(),
          reticle: document.querySelector(".reticle")?.getAttribute("style"),
          button: r?.toJSON(), above: r && document.elementFromPoint(r.x + r.width/2, r.y + r.height/2)?.outerHTML.slice(0, 250),
        };
      })()`));
    }
    throw error;
  } finally {
    if (touch) {
      await d.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await d.send("Emulation.clearDeviceMetricsOverride");
    }
    await ev(`${G}.fixtures.activate(${j(previous)})`);
    await d.reload();
    await ev(`${G}.fixtures.remove(${j(fixture)})`);
  }
}
