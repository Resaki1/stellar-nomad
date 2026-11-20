/**
 * M5 solo UI walkthrough. Uses trusted clicks and keys for actions. The harness prepares live
 * cargo and positions, then reads the result back from the world and the screen.
 *
 * DRIVE_PROFILE=m5ux DRIVE_CDP_PORT=9351 pnpm drive -- --url http://127.0.0.1:3012/ --no-isolate run:scripts/drive-examples/industry-ui.mjs
 * INDUSTRY_UI_TOUCH=1 runs the walkthrough at a portrait touch size and checks the landscape layout.
 * INDUSTRY_UI_TOUCH=layout runs those layout and dispatch checks without waiting for the live delivery.
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
  const layoutOnly = process.env.INDUSTRY_UI_TOUCH === "layout";
  const touch = layoutOnly || process.env.INDUSTRY_UI_TOUCH === "1";
  const capture = name => d.shot(`m5-industry-${name}${touch ? "-touch" : ""}`);
  const setSize = (width, height) => d.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const shown = selector => ev(`!!document.querySelector(${J(selector)})?.getClientRects().length`);
  const enabled = selector => ev(`document.querySelector(${J(selector)})?.disabled === false`);
  const text = selector => ev(`document.querySelector(${J(selector)})?.textContent.trim()`);
  const value = selector => ev(`document.querySelector(${J(selector)})?.value`);
  const optionIds = selector => ev(`[...document.querySelector(${J(selector)}).options].map(o => o.value)`);
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
    if (value === "") {
      const backspace = { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 };
      await d.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...backspace, commands: ["DeleteBackward"] });
      await d.send("Input.dispatchKeyEvent", { type: "keyUp", ...backspace });
    } else await d.type(String(value));
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
  const storageLayouts = [];

  try {
    await ev(`${G}.fixtures.activate(${J(fixture)})`);
    await d.reload();
    await ev(`${G}.m37.comms.nameAi("Vega"); ${G}.m37.comms.dismiss()`);
    await d.frames(30);
    const catalog = await ev(`${G}.industry.catalog()`);
    const source = catalog.sources.find(s => s.id === "earth_hydrates");
    const lunar = catalog.sources.find(s => s.id === "luna_hydrates");
    assert.ok(source && lunar);

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
    const prospect = action("track-earth_hydrates");
    const prospectId = "industry-source:earth_hydrates";
    const tracked = id => ev(`${G}.transit.state().targeted === ${J(id)}`);
    assert.ok(!(await record()).modules.ownedModules.includes("special_transit_drive"));
    await click(prospect);
    await find("hydrate site tracked", () => tracked(prospectId));
    assert.equal(await shown(".industry"), false);
    await openIndustry();
    await find("hydrate site untrack control", async () => await text(prospect) === "Untrack");
    await click(prospect);
    await find("hydrate site cleared", () => tracked(null));
    assert.equal(await text(prospect), "Track");
    await click(prospect);
    await find("hydrate site tracked again", () => tracked(prospectId));
    if (!touch) {
      await d.press("h");
      assert.equal(await ev(`!!document.querySelector(".hud--hidden")`), true);
      await openIndustry();
      await find("Industry restores hidden HUD", () => ev(`!!document.querySelector(".industry") && !document.querySelector(".hud--hidden")`));
      await closeIndustry();
    }

    for (const [id, n] of Object.entries({ fe_ni_metal: 850, silicates: 600, carbon: 40, hydrates: 10, sulfur: 10, titanium: 10, helium_3: 10 })) {
      await ev(`__dev.grantCargo(${J(id)}, ${n})`);
    }
    const place = async (name, xOffset, { near = true, checkCancel = false, region = source } = {}) => {
      const position = region.positionKm.map((axis, i) => axis + (i === 0 ? xOffset : 0));
      await teleport(region.frameId, position);
      await openIndustry();
      await find("Industry reopens", () => shown(".industry"));
      await click("[data-industry-build]");
      await click(action("craft-kit"));
      await find("kit received", async () => (await record()).modules.consumables.consumable_depot_kit > 0);
      await fill("[data-industry-name]", name);
      await click(action("aim"));
      await find("deployment clearance", () => shown('[data-industry-clear="true"]'));
      assert.equal(await ev(`document.querySelector("[data-industry-clear]").textContent.includes(${J(near ? region.name : "relay site")})`), true);
      if (checkCancel) {
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

    const works = await place("Hydrate Works", 2, { checkCancel: true });
    const depotRole = id => text(`${inPanel(id)} [data-industry-depot-role]`);
    assert.equal(await depotRole(works.id), "Storage depot", "Site proximity leaves an unequipped depot for storage");
    const moveStock = async (depot, id, amount, direction) => {
      const stored = async () => {
        const { storage } = (await state()).depots.find(d => d.id === depot.id);
        return id === "propellant" ? storage.fuelKg : storage.items[id] ?? 0;
      };
      const expected = await stored() + (direction === "deposit" ? amount : -amount);
      await click(stock(id));
      await fill("[data-industry-amount]", amount);
      await click(action(direction));
      await find(`${direction} saved`, async () => await stored() === expected);
      assert.equal(await text(".industry__feedback"), "", "Transfer amounts confirm success");
    };
    const storageLayout = () => ev(`(() => {
      const scroll = document.querySelector(".industry__storage .industry__content");
      const footer = document.querySelector(".industry__transfer");
      const panel = footer.closest(".panel").getBoundingClientRect();
      const content = scroll.getBoundingClientRect();
      const r = footer.getBoundingClientRect();
      const rename = document.querySelector(".industry__rename-trigger");
      const name = rename.getBoundingClientRect();
      const track = document.querySelector(${J(action("track-depot"))}).getBoundingClientRect();
      const buttons = [...footer.querySelectorAll("button")].map(button => button.getBoundingClientRect());
      const visibleRows = [...scroll.querySelectorAll(".industry__manifest-row")].filter(row => {
        const rect = row.getBoundingClientRect();
        return rect.top >= content.top && rect.bottom <= content.bottom;
      }).length;
      return { width: innerWidth, height: innerHeight, scrollable: scroll.scrollHeight > scroll.clientHeight,
        scrollTop: scroll.scrollTop, top: r.top, bottom: r.bottom, bottomGap: panel.bottom - r.bottom,
        visible: buttons.every(b => b.left >= panel.left && b.right <= panel.right && b.top >= panel.top && b.bottom <= panel.bottom),
        minTap: Math.min(...buttons.map(b => b.height)), visibleRows,
        renameVisible: name.top >= panel.top && name.right <= panel.right && (name.right <= track.left || name.bottom <= track.top) &&
          rename.contains(document.elementFromPoint(name.left + name.width / 2, name.top + name.height / 2)) };
    })()`);
    const assertPinnedActions = async (minRows = 0) => {
      await find("storage panel animation settled", () => ev(
        `document.querySelector(".industry").closest(".panel").getAnimations().every(animation => animation.playState === "finished")`,
      ));
      const first = await storageLayout();
      assert.ok(first.visibleRows >= minRows, JSON.stringify(first));
      await ev('document.querySelector(".industry__storage .industry__content").scrollTop = 2000');
      const last = await storageLayout();
      assert.ok(first.scrollable && last.scrollTop > first.scrollTop && first.visible && last.visible && last.bottomGap < 2, JSON.stringify(last));
      assert.equal(last.top, first.top);
      assert.equal(last.bottom, first.bottom);
      assert.ok(first.renameVisible && last.renameVisible, "Depot name stays within reach above Storage");
      if (touch) assert.ok(last.minTap >= 44);
      storageLayouts.push({ ...last, visibleRowsAtTop: first.visibleRows });
      await ev('document.querySelector(".industry__storage .industry__content").scrollTop = 0');
    };
    await assertPinnedActions();
    if (touch) {
      for (const [width, height, minRows] of [[844, 390, 2], [568, 320, 1]]) {
        await setSize(width, height);
        await wait(200);
        captures.push(await d.shot(`m5-industry-storage-${width}x${height}`));
        await assertPinnedActions(minRows);
      }
      await click(".industry__rename-trigger");
      await find("landscape depot rename dialog", () => shown(".industry__rename-form"));
      assert.equal(await value(".industry__rename-form input"), works.name);
      captures.push(await d.shot("m5-industry-rename-568x320"));
      await click('.panel__close[aria-label="Close"]');
      await find("return to landscape Storage", () => shown(".industry__storage"));
      await setSize(390, 844);
    }
    assert.match(await text(".industry__capacity"), /3,000 kg.*6,000 units/);
    await moveStock(works, "propellant", 50, "deposit");
    assert.equal((await state()).depots[0].storage.fuelKg, 50);
    await moveStock(works, "propellant", 5, "withdraw");
    assert.equal((await state()).depots[0].storage.fuelKg, 45);

    // Model a state change between the visible counts and submission. The authority must
    // refuse the stale click, keep both sides consistent, and show the reason in place.
    const beforeRefusal = await storageLayout();
    await fill("[data-industry-amount]", 45);
    const firstWithdrawal = await ev(`(() => {
      const button = document.querySelector(${J(action("withdraw"))});
      const prior = ${G}.submit({ type: "depot.transfer", depotId: ${J(works.id)},
        direction: "withdraw", kind: "fuel", itemId: "fuel", amount: 1 });
      button.click();
      return prior.status;
    })()`);
    assert.equal(firstWithdrawal, "accepted");
    await find("transfer refusal displayed", async () => (await text(".industry__feedback [role=alert]"))?.includes("The depot is short by 1 kg"));
    assert.deepEqual(await storageLayout(), beforeRefusal);
    assert.equal((await state()).depots[0].storage.fuelKg, 44);
    captures.push(await capture("refusal"));
    await moveStock(works, "propellant", 1, "deposit");

    for (const [id, amount] of Object.entries({ fe_ni_metal: 165, silicates: 110, carbon: 20 })) {
      await moveStock(works, id, amount, "deposit");
    }
    captures.push(await capture("manifest"));
    await click(tab("fabrication"));
    const fabricate = id => click(`[data-industry-recipe="${id}"] ${action("fabricate")}`);
    await fabricate("refinery");
    await find("refinery installed", async () => (await state()).depots[0].refinery);
    assert.equal(await depotRole(works.id), "Refinery");
    await fabricate("drone");
    await find("first drone built", async () => (await state()).drones.length === 1);
    await fabricate("drone");
    await find("second drone built", async () => (await state()).drones.length === 2);
    assert.equal(await enabled(`[data-industry-recipe="drone"] ${action("fabricate")}`), false);
    captures.push(await capture("fabrication"));

    await click(tab("drones"));
    const [extractor, hauler] = (await state()).drones.map(drone => `[data-industry-drone=${J(drone.id)}]`);
    await select(`${hauler} [data-industry-job-kind]`, "haul");
    assert.equal(await enabled(`${hauler} [data-industry-job-target]`), false);
    assert.equal(await enabled(`${hauler} ${action("start-job")}`), false);
    assert.match(await text(hauler), /Local routes can span up to 30(?:\.0)? km/);
    assert.match(await text(hauler), /farther within the same asteroid field/);
    const limit = `${extractor} [data-industry-job-stop]`;
    assert.deepEqual(await optionIds(`${extractor} [data-industry-job-target]`), [source.id]);
    assert.equal(await ev(`document.querySelector(${J(limit)}).value`), "");
    await fill(`${extractor} [data-industry-job-reserve]`, 50);
    await fill(limit, 400);
    await click(`${extractor} ${action("start-job")}`);
    await find("fuel shortfall displayed", () => ev(`document.querySelector('[data-industry-drone-status="needs_fuel"]')?.textContent.includes("propellant")`));
    assert.equal((await state()).drones[0].job.stopAt, 400);
    assert.equal(await depotRole(works.id), "Refinery · Hydrate extraction");
    assert.match(await text(`${extractor} .industry__route`), /Hydrate limit: 400 units/);
    await click(`${extractor} ${action("edit-job")}`);
    assert.equal(await ev(`document.querySelector(${J(limit)}).value`), "400");
    await click(`${extractor} ${action("clear-hydrate-limit")}`);
    assert.equal(await ev(`document.querySelector(${J(limit)}).value`), "");
    await click(`${extractor} ${action("start-job")}`);
    await find("extraction set to fill storage", async () => (await state()).drones[0].job.stopAt === 6000);
    assert.match(await text(`${extractor} .industry__route`), /all free cargo space/);
    await click(tab("storage"));
    // The extractor can spend the fuel immediately, before the next depot stock read.
    const expectedDepositedFuel = (await record()).depositedFuelKg + 20;
    await click(stock("propellant"));
    await fill("[data-industry-amount]", 20);
    await click(action("deposit"));
    await find("bootstrap fuel deposited", async () => (await record()).depositedFuelKg === expectedDepositedFuel);
    await find("extractor departs after bootstrap fuel", async () => (await state()).drones[0].phase === "outbound");
    await closeIndustry();

    const relay = await place("Transfer Relay", 6);
    assert.equal(await depotRole(relay.id), "Storage depot");
    for (const [id, amount] of Object.entries({ fe_ni_metal: 45, silicates: 30, carbon: 10 })) {
      await moveStock(relay, id, amount, "deposit");
    }
    await click(tab("fabrication"));
    await fabricate("drone");
    const relayDrone = await find("relay drone built", async () => (await state()).drones.find(drone => drone.homeId === relay.id));
    const relayWork = `[data-industry-drone=${J(relayDrone.id)}]`;
    await click(tab("drones"));
    assert.deepEqual(await optionIds(`${relayWork} [data-industry-job-kind]`), ["extract", "haul"]);
    await select(`${relayWork} [data-industry-job-kind]`, "haul");
    assert.deepEqual(await optionIds(`${relayWork} [data-industry-job-target]`), ["", works.id]);
    await closeIndustry();
    const farBelt = await place("Far Belt Depot", 2002, { near: false });
    await closeIndustry();
    const clearSpace = await place("Open Space Depot", -3500, { near: false });
    await closeIndustry();
    const outpost = await place("Lunar Outpost", 42, { near: false, region: lunar });
    await closeIndustry();
    await teleport(source.frameId, relay.placementPosition);
    await openIndustry();
    await click(inPanel(works.id));
    await find("remote access displayed", () => shown('[data-industry-access="remote"]'));
    assert.equal(await enabled(action("deposit-max")), false);
    const depotTarget = `depot:${works.id}`;
    await click(action("track-depot"));
    await find("depot target handed to navigation", () => tracked(depotTarget));
    await openIndustry();
    await click(inPanel(works.id));
    assert.equal(await text(action("track-depot")), "Untrack depot");
    await click(action("track-depot"));
    await find("depot tracking cleared", () => tracked(null));
    assert.equal(await text(action("track-depot")), "Track depot");
    await click(action("track-depot"));
    await find("depot tracked again", () => tracked(depotTarget));
    await find("depot POI on HUD", () => shown(`.poi-markers [data-id=${J(`depot:${works.id}`)}]`));
    await teleport(source.frameId, works.placementPosition);
    await find("depot in reticle", () => shown('[data-testid="target-card"][data-kind="depot"]'));
    if (touch) await openIndustry();
    else await d.press("g");
    await find("Interact opens the depot in local range", () => shown('[data-industry-access="available"]'));
    await click(tab("drones"));

    const haulTarget = `${hauler} [data-industry-job-target]`;
    const haulItems = `${hauler} [data-industry-job-filter]`;
    const haulLimit = `${hauler} [data-industry-job-stop]`;
    const haulReserve = `${hauler} [data-industry-job-reserve]`;
    const haulStart = `${hauler} ${action("start-job")}`;
    const cargoOrder = () => ev(`[...document.querySelectorAll(${J(`${hauler} ol li span`)})].map(el => el.textContent)`);
    await select(`${hauler} [data-industry-job-kind]`, "haul");
    assert.equal(await value(haulTarget), "");
    assert.deepEqual(await optionIds(haulTarget), ["", relay.id, farBelt.id, clearSpace.id], `Cross-body destination ${outpost.name} is unavailable`);
    const blockedOption = `${haulTarget} option[value=${J(clearSpace.id)}]`;
    assert.match(await text(blockedOption), /Outside local range or a shared field/);
    assert.equal(await enabled(blockedOption), false, "Long routes outside a shared field cannot be selected");
    assert.equal(await value(haulLimit), "");
    assert.deepEqual(await cargoOrder(), []);
    assert.equal(await enabled(haulStart), false);
    assert.match(await text(hauler), /Add at least one item/);
    if (touch) {
      const fits = await ev(`(() => {
        const [kind, target, reserve, limit] = ${J([`${hauler} [data-industry-job-kind]`, haulTarget, haulReserve, haulLimit])}
          .map(selector => document.querySelector(selector).getBoundingClientRect());
        return kind.bottom <= target.top && reserve.bottom <= limit.top;
      })()`);
      assert.equal(fits, true, "Dispatch fields stack so the longer labels fit on a portrait phone");
    }
    await ev(`document.querySelector(${J(haulItems)}).scrollIntoView({ block: "center" })`);
    captures.push(await capture("empty-delivery"));
    await select(haulTarget, farBelt.id);
    const fieldQuote = await text(`${hauler} .industry__estimate`);
    assert.match(fieldQuote, /\d+(?:h|m) (?:\d+(?:m|s) )?round trip/);
    assert.match(fieldQuote, new RegExp(`kg flight fuel \\(${catalog.tuning.droneTankKg} kg tank\\)`));
    assert.match(fieldQuote, /kg needed at depot/);
    await select(haulItems, "propellant");
    const loadedFieldQuote = await text(`${hauler} .industry__estimate`);
    assert.match(loadedFieldQuote, /kg propellant planned cargo/);
    assert.doesNotMatch(await text(hauler), /Add propellant in Storage so the drone can depart/, "A funded plan has no fuel warning");
    const launchKg = quote => Number(quote.match(/([\d.]+) kg flight fuel/)[1]);
    assert.ok(launchKg(loadedFieldQuote) > launchKg(fieldQuote), "The payload increases the funded flight fuel");
    await ev(`document.querySelector(${J(`${hauler} .industry__estimate`)}).scrollIntoView({ block: "center" })`);
    captures.push(await capture("across-field"));
    const initialReserve = await value(haulReserve);
    await fill(haulReserve, catalog.tuning.fuelCapacityKg);
    assert.equal(await enabled(haulStart), false, "A full depot reserve leaves no room for flight fuel");
    assert.match(await text(hauler), /Lower the reserve to fit the flight fuel/);
    await fill(haulReserve, initialReserve);
    await click(`${hauler} [aria-label="Remove Propellant"]`);
    await select(haulTarget, relay.id);
    assert.equal(await enabled(haulStart), false, "Destination alone is insufficient");
    await select(haulItems, "propellant");
    assert.equal(await enabled(haulStart), true);
    await select(haulItems, "hydrates");
    await click(`${hauler} [aria-label="Move Hydrates up"]`);
    assert.deepEqual(await cargoOrder(), ["Hydrates", "Propellant"]);
    await click(`${hauler} [aria-label="Move Hydrates down"]`);
    await fill(haulReserve, 12);
    await fill(haulLimit, "e");
    assert.equal(await enabled(haulStart), false, "Invalid input can't be treated as a blank limit");
    await fill(haulLimit, 80);
    for (const view of ["storage", "fabrication"]) {
      await click(tab(view));
      await click(tab("drones"));
      assert.equal(await value(haulLimit), "80");
    }
    await click(inPanel(relay.id));
    await click(tab("drones"));
    assert.equal(await value(`${relayWork} [data-industry-job-reserve]`), "0", "A different drone has its own draft");
    await click(inPanel(works.id));
    await click(tab("drones"));
    assert.equal(await value(haulLimit), "80");
    assert.equal(await value(haulTarget), relay.id);
    assert.equal(await value(haulReserve), "12");
    assert.deepEqual(await cargoOrder(), ["Propellant", "Hydrates"]);

    // A live authoritative assignment while the draft is hidden keeps the edits intact
    // and requires the player to review the current job before saving.
    await click(tab("storage"));
    const droneId = (await state()).drones[1].id;
    const changedJob = { kind: "haul", targetId: relay.id, priorities: ["hydrates"], reserveKg: 25, stopAt: 95, enabled: false };
    const configure = job => ev(`${G}.submit({ type: "drone.configure", droneId: ${J(droneId)}, job: ${J(job)} })`);
    assert.equal((await configure(changedJob)).status, "accepted");
    await click(tab("drones"));
    assert.match(await text(`${hauler} .industry__route`), /Delivery limit: 95 per item/);
    assert.equal(await value(haulLimit), "80");
    assert.equal(await enabled(haulStart), false);
    await ev(`document.querySelector(${J(`${hauler} .industry__job-review`)}).scrollIntoView({ block: "center" })`);
    captures.push(await capture("job-changed"));
    await click(`${hauler} ${action("keep-job-draft")}`);
    assert.equal(await enabled(haulStart), true);
    assert.deepEqual(await cargoOrder(), ["Propellant", "Hydrates"]);
    assert.equal((await configure({ ...changedJob, reserveKg: 26 })).status, "accepted");
    await click(`${hauler} ${action("use-current-job")}`);
    assert.equal(await shown(haulStart), false);
    await click(`${hauler} ${action("edit-job")}`);
    assert.equal(await value(haulLimit), "95", "A stored numeric cap is still editable");
    assert.equal(await value(haulReserve), "26");
    assert.deepEqual(await cargoOrder(), ["Hydrates"]);
    await select(haulItems, "propellant");
    await click(`${hauler} [aria-label="Move Propellant up"]`);
    await fill(haulReserve, 12);
    await fill(haulLimit, "");
    await ev(`document.querySelector(${J(haulStart)}).scrollIntoView({ block: "nearest" })`);
    captures.push(await capture("plan"));
    if (layoutOnly) return { pass: true, touch, captures, storageLayouts };
    await click(haulStart);
    await find("unlimited delivery saved", async () => (await state()).drones[1].job.stopAt === catalog.tuning.cargoCapacity);
    assert.match(await text(`${hauler} .industry__route`), /Uses all free space at the receiving depot/);
    await find("fuel delivery at relay", async () => (await state()).depots.find(d => d.id === relay.id).storage.fuelKg > 0, 60000);
    await click(`${hauler} ${action("stop-job")}`);
    await find("hauler stopped at depot", async () => (await state()).drones[1].status === "paused", 60000);
    assert.deepEqual((await state()).drones[1].job.priorities, ["propellant", "hydrates"]);
    await find("obsolete stop confirmation clears", () => ev(`document.querySelector(".industry__feedback").textContent === ""`), 6500);
    captures.push(await capture("route"));

    await ev("__dev.grantAllItems()");
    assert.ok((await record()).modules.ownedModules.includes("special_transit_drive"));
    await click("[data-industry-build]");
    assert.doesNotMatch(await text(".industry__build"), /Add a Transit Drive/);
    await click(prospect);
    await find("hydrate site tracked with transit drive", () => tracked(prospectId));
    await openIndustry();
    await click("[data-industry-build]");
    assert.equal(await text(prospect), "Untrack");
    await click(prospect);
    await find("hydrate site cleared with transit drive", () => tracked(null));
    await click(inPanel(relay.id));
    await click(action("track-depot"));
    const relayTarget = `depot:${relay.id}`;
    await find("depot tracked with transit drive", () => tracked(relayTarget));
    await openIndustry();
    await click(inPanel(relay.id));
    assert.equal(await text(action("track-depot")), "Untrack depot");
    await click(action("track-depot"));
    await find("depot cleared with transit drive", () => tracked(null));
    console.log("[industry-ui]", JSON.stringify({ pass: true, touch, captures, storageLayouts, fuelKg: (await state()).depots[1].storage.fuelKg }));
  } catch (error) {
    console.error(error.stack);
    throw error;
  } finally {
    if (oldWorld) {
      await ev(`${G}.fixtures.activate(${J(oldWorld)})`);
      await d.reload();
    }
    await ev(`${G}.fixtures.remove(${J(fixture)})`);
  }
}
