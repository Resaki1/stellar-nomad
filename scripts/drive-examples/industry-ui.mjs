/**
 * M5 solo UI walkthrough. Uses trusted clicks and keys for actions. The harness prepares live
 * cargo and positions, then reads the result back from the world and the screen.
 *
 * DRIVE_PROFILE=m5ux DRIVE_CDP_PORT=9351 pnpm drive -- --url http://127.0.0.1:3012/ --no-isolate run:scripts/drive-examples/industry-ui.mjs
 * INDUSTRY_UI_TOUCH=1 runs the walkthrough at a portrait touch size and checks the landscape layout.
 */
import assert from "node:assert/strict";

const G = "__test.gameplay";
const J = JSON.stringify;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const action = name => `[data-industry-action="${name}"]`;
const tab = name => `[data-industry-tab="${name}"]`;
const stock = name => `[data-industry-stock="${name}"]`;

export default async function industryUi(d) {
  const ev = src => d.evaluate(src);
  const touch = process.env.INDUSTRY_UI_TOUCH === "1";
  const capture = name => d.shot(`m5-industry-${name}${touch ? "-touch" : ""}`);
  const setSize = (width, height) => d.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const shown = selector => ev(`!!document.querySelector(${J(selector)})?.getClientRects().length`);
  const enabled = selector => ev(`document.querySelector(${J(selector)})?.disabled === false`);
  const state = () => ev(`${G}.world().industry`);
  const record = () => ev(`${G}.player()`);
  const find = async (label, check, limit = 12000) => {
    const deadline = Date.now() + limit;
    let result;
    while (Date.now() < deadline && !(result = await check())) await wait(120);
    assert.ok(result, `Timed out waiting for ${label}`);
    return result;
  };
  const click = async selector => {
    const xy = await find(selector, () => ev(`(() => {
      const el = document.querySelector(${J(selector)});
      if (!el || el.disabled) return false;
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      return r.width && r.height && el.contains(document.elementFromPoint(x, y)) ? [x, y] : false;
    })()`));
    if (touch) {
      const [x, y] = xy;
      await d.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await d.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else await d.click(...xy);
  };
  const fill = async (selector, value) => {
    await click(selector);
    await d.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, commands: ["SelectAll"] });
    await d.type(String(value));
    assert.equal(await ev(`document.querySelector(${J(selector)}).value`), String(value));
  };
  const select = async (selector, value) => {
    // Native picker popups aren’t exposed to CDP on every desktop platform. Drive the
    // actual select and its React change handler with the selected option value.
    assert.equal(await ev(`(() => {
      const el = document.querySelector(${J(selector)});
      if (!el || el.disabled || ![...el.options].some(option => option.value === ${J(value)})) return false;
      el.value = ${J(value)};
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`), true);
  };
  const teleport = async (frame, position) => {
    await ev(`${G}.rep.teleportRel(${J(frame)}, ${J(position)}, [0,0,0,1])`);
    await find("ship warp", () => ev(`(() => {
      const ship = ${G}.rep.ship();
      return ship?.frameId === ${J(frame)} && Math.hypot(...ship.posKm.map((x,i) => x - ${J(position)}[i])) < 0.05;
    })()`));
  };
  const inPanel = id => `.industry [data-industry-depot=${J(id)}]`;
  const oldWorld = await ev("__test.save.info().id");
  const playerId = await ev(`${G}.localId()`);
  const fixture = await ev(`${G}.fixtures.create("m5-industry-ui", { schemaVersion: 5, world: {}, players: { [${J(playerId)}]: {} } })`);
  const openIndustry = () => touch ? click('.hud__panel-btn[aria-label="Industry"]') : d.press("b");
  const closeIndustry = () => touch ? click('.panel__close[aria-label="Close"]') : d.press("Escape");
  const captures = [];

  try {
    await ev(`${G}.fixtures.activate(${J(fixture)})`);
    await d.reload();
    await ev(`${G}.m37.comms.nameAi("Vega"); ${G}.m37.comms.dismiss()`);
    await d.frames(30);
    const catalog = await ev(`${G}.industry.catalog()`);
    const source = catalog.sources.find(s => s.id === "earth_hydrates");
    assert.ok(source);

    if (touch) {
      await setSize(390, 844);
      await d.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 3 });
    }

    // Settings → Industry is a real menu path and exits the paused settings layer.
    if (touch) await click(".settings__open-button");
    else await d.press("o");
    await click('[data-ship-panel="industry"]');
    await find("Industry dialog", () => shown(".industry"));
    assert.equal(await shown(".settings-menu__panels"), false);
    assert.equal(await enabled(action("craft-kit")), false, "Missing materials prevent craft");
    assert.equal(await enabled(action("aim")), false, "No kit prevents placement");
    captures.push(await capture("build"));
    await d.press("Tab");
    assert.equal(await ev(`document.activeElement.closest(".panel") !== null`), true, "Tab stays in Industry");

    if (touch) {
      for (const [width, height] of [[390, 844], [844, 390]]) {
        await setSize(width, height);
        await wait(200);
        const layout = await ev(`(() => {
          const shell = document.querySelector(".industry").closest(".panel");
          const body = shell.querySelector(".industry__content");
          const r = shell.getBoundingClientRect();
          const action = document.querySelector(${J(action("track-earth_hydrates"))}).getBoundingClientRect();
          const close = shell.querySelector(".panel__close").getBoundingClientRect();
          return { fit: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
            scroll: body.scrollWidth <= body.clientWidth, tap: action.height >= 44 && close.width >= 44 && close.height >= 44 };
        })()`);
        assert.deepEqual(layout, { fit: true, scroll: true, tap: true });
        captures.push(await d.shot(`m5-industry-build-${width}x${height}`));
      }
      await setSize(390, 844);
    }

    await fill("[data-industry-name]", "Hydrate Works");
    await d.press("b");
    assert.equal(await shown(".industry"), true, "Industry hotkey doesn't close a focused name field");
    await click(action("track-earth_hydrates"));
    await find("prospect pinned", () => ev(`${G}.transit.state().targeted === "industry-source:earth_hydrates"`));
    assert.equal(await shown(".industry"), false);
    if (!touch) {
      await d.press("h");
      assert.equal(await ev(`!!document.querySelector(".hud--hidden")`), true);
      await openIndustry();
      await find("Industry restores hidden HUD", () => ev(`!!document.querySelector(".industry") && !document.querySelector(".hud--hidden")`));
      await closeIndustry();
    }

    for (const [id, n] of Object.entries({ fe_ni_metal: 480, silicates: 360, carbon: 40, hydrates: 10 })) {
      await ev(`__dev.grantCargo(${J(id)}, ${n})`);
    }
    const place = async (name, xOffset, isSource) => {
      const position = source.positionKm.map((axis, i) => axis + (i === 0 ? xOffset : 0));
      await teleport(source.frameId, position);
      await openIndustry();
      await find("Industry reopens", () => shown(".industry"));
      await click("[data-industry-build]");
      await click(action("craft-kit"));
      await find("kit received", async () => (await record()).modules.consumables.consumable_depot_kit > 0);
      await fill("[data-industry-name]", name);
      await click(action("aim"));
      await find("deployment clearance", () => shown('[data-industry-clear="true"]'));
      assert.equal(await ev(`document.querySelector("[data-industry-clear]").textContent.includes(${J(isSource ? source.name : "relay site")})`), true);
      if (isSource) {
        captures.push(await capture("placement"));
        if (touch) await click(action("cancel-placement"));
        else await d.press("Escape");
        await find("placement cancelled", () => shown(".industry"));
        assert.equal(await ev(`document.querySelector("[data-industry-name]").value`), name);
        assert.equal((await state()).depots.length, 0);
        await click(action("aim"));
        await find("deployment clearance after cancel", () => shown('[data-industry-clear="true"]'));
      }
      if (touch) await click(action("place"));
      else await d.press("Enter");
      const depot = await find("depot placed", async () => (await state()).depots.find(depot => depot.name === name));
      await find("placed depot opens nearby", () => shown('[data-industry-access="available"]'));
      return { ...depot, placementPosition: position };
    };

    const works = await place("Hydrate Works", 2, true);
    const moveStock = async (id, amount, direction) => {
      await click(stock(id));
      await fill("[data-industry-amount]", amount);
      await click(action(direction));
      await find(`${direction} confirmed`, () => ev(`document.querySelector(".industry__feedback")?.textContent.includes(${J(direction === "deposit" ? "Deposited" : "Withdrawn")})`));
    };
    await moveStock("propellant", 50, "deposit");
    assert.equal((await state()).depots[0].storage.fuelKg, 50);
    await moveStock("propellant", 5, "withdraw");
    assert.equal((await state()).depots[0].storage.fuelKg, 45);
    for (const [id, amount] of Object.entries({ fe_ni_metal: 165, silicates: 110, carbon: 20 })) {
      await moveStock(id, amount, "deposit");
    }
    captures.push(await capture("manifest"));
    await click(tab("fabrication"));
    const fabricate = id => click(`[data-industry-recipe="${id}"] ${action("fabricate")}`);
    await fabricate("refinery");
    await find("refinery installed", async () => (await state()).depots[0].refinery);
    await fabricate("drone");
    await find("first drone built", async () => (await state()).drones.length === 1);
    await fabricate("drone");
    await find("second drone built", async () => (await state()).drones.length === 2);
    assert.equal(await enabled(`[data-industry-recipe="drone"] ${action("fabricate")}`), false);
    captures.push(await capture("fabrication"));

    await click(tab("drones"));
    const [extractor, hauler] = (await state()).drones.map(drone => `[data-industry-drone=${J(drone.id)}]`);
    await select(`${extractor} [data-industry-job-target]`, source.id);
    await fill(`${extractor} [data-industry-job-reserve]`, 50);
    await fill(`${extractor} [data-industry-job-stop]`, 20);
    await click(`${extractor} ${action("start-job")}`);
    await find("fuel shortfall displayed", () => ev(`document.querySelector('[data-industry-drone-status="needs_fuel"]')?.textContent.includes("Deposit")`));
    await click(tab("storage"));
    await moveStock("propellant", 20, "deposit");
    await find("extractor departs after bootstrap fuel", async () => (await state()).drones[0].phase === "outbound");
    await closeIndustry();

    const relay = await place("Transfer Relay", 42, false);
    await click(inPanel(works.id));
    await find("remote access displayed", () => shown('[data-industry-access="remote"]'));
    assert.equal(await enabled(action("deposit-max")), false);
    await click(action("track-depot"));
    await find("depot target handed to navigation", () => ev(`${G}.transit.state().targeted === ${J(`depot:${works.id}`)}`));
    await find("depot POI on HUD", () => shown(`.poi-markers [data-id=${J(`depot:${works.id}`)}]`));
    await teleport(source.frameId, works.placementPosition);
    await find("depot in reticle", () => shown('[data-testid="target-card"][data-kind="depot"]'));
    if (touch) await openIndustry();
    else await d.press("g");
    await find("Interact opens the depot in local range", () => shown('[data-industry-access="available"]'));
    await click(tab("drones"));

    await select(`${hauler} [data-industry-job-kind]`, "haul");
    await select(`${hauler} [data-industry-job-target]`, relay.id);
    await select(`${hauler} [data-industry-job-filter]`, "hydrates");
    await click(`${hauler} [aria-label="Move Hydrates up"]`);
    await click(`${hauler} [aria-label="Move Hydrates down"]`);
    await fill(`${hauler} [data-industry-job-reserve]`, 12);
    await fill(`${hauler} [data-industry-job-stop]`, 80);
    await ev(`document.querySelector(${J(`${hauler} ${action("start-job")}`)}).scrollIntoView({ block: "nearest" })`);
    captures.push(await capture("plan"));
    await click(`${hauler} ${action("start-job")}`);
    await find("fuel delivery at relay", async () => (await state()).depots.find(d => d.id === relay.id).storage.fuelKg > 0, 60000);
    await click(`${hauler} ${action("stop-job")}`);
    await find("hauler stopped at depot", async () => (await state()).drones[1].status === "paused", 60000);
    assert.deepEqual((await state()).drones[1].job.priorities, ["propellant", "hydrates"]);
    await find("obsolete stop confirmation clears", () => ev(`document.querySelector(".industry__feedback").textContent === ""`), 6500);
    captures.push(await capture("route"));
    console.log("[industry-ui]", JSON.stringify({ pass: true, touch, captures, fuelKg: (await state()).depots[1].storage.fuelKg }));
  } finally {
    if (oldWorld) {
      await ev(`${G}.fixtures.activate(${J(oldWorld)})`);
      await d.reload();
    }
    await ev(`${G}.fixtures.remove(${J(fixture)})`);
  }
}
