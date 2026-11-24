/**
 * Trusted CDP controls for both placement cards in windowed and Fullscreen API modes.
 * Headless Chrome is muted by drive.mjs. CDP can deliver Escape directly to the page.
 *
 * DRIVE_PROFILE=m5placement DRIVE_CDP_PORT=9353 pnpm drive -- --no-isolate --url http://127.0.0.1:3012/ run:scripts/drive-examples/placement-controls.mjs
 */
import assert from "node:assert/strict";

const G = "__test.gameplay";
const DEPOT = "consumable_depot_kit";
const POINT = "consumable_replication_kit";
const aimDepot = '.placement-card[data-placement="depot"]';
const aimPoint = '.placement-card[data-placement="point"]';
const nameInput = selector => `${selector} input`;
const pointName = nameInput(aimPoint);
const depotName = nameInput(aimDepot);
const menu = ".settings-menu__nav";
const J = JSON.stringify;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export default async function placementControls(d) {
  const ev = js => d.evaluate(js);
  let touch = false;
  const until = async (label, js) => {
    const deadline = Date.now() + 12000;
    do {
      const value = await ev(js);
      if (value) return value;
      await wait(100);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${label}`);
  };
  const shown = selector => `!!document.querySelector(${J(selector)})?.getClientRects().length`;
  const focusName = async selector => {
    await d.press("Tab");
    assert.equal(await ev(`document.activeElement?.matches(${J(selector)})`), true);
    assert.equal(await ev("document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === document.activeElement.value.length"), true);
  };
  const defaultName = selector => ev(`document.querySelector(${J(selector)})?.value`);
  const click = async selector => {
    const point = await until(selector, `(() => {
      const el = document.querySelector(${J(selector)});
      if (!el || el.disabled) return false;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      return r.width && r.height && el.contains(document.elementFromPoint(x, y)) ? [x, y] : false;
    })()`);
    if (touch) {
      const [x, y] = point;
      await d.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await d.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else await d.click(...point);
  };
  const rightClick = async () => {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await d.send("Input.dispatchMouseEvent", { type, x: 640, y: 300, button: "right", clickCount: 1 });
    }
  };
  const canvasClick = async (withLock = false) => {
    const point = await until("game canvas receives pointer", `(() => {
      const x = Math.round(innerWidth / 2), y = Math.round(innerHeight / 2);
      return ${withLock ? "document.pointerLockElement === document.body" : "document.elementFromPoint(x, y) instanceof HTMLCanvasElement"} ? [x, y] : false;
    })()`);
    await d.click(...point);
  };
  const cancelled = `!${shown(aimDepot)} && !${shown(aimPoint)} && !${shown(menu)} && !${shown(".industry")}`;
  const fullscreen = "document.fullscreenElement === document.documentElement";
  const locked = "!!document.pointerLockElement";
  const shipAt = async (frame, pos) => {
    await ev(`${G}.rep.teleportRel(${J(frame)}, ${J(pos)}, [0,0,0,1])`);
    await until("ship pose", `(() => {
      const ship = ${G}.rep.ship();
      return ship?.frameId === ${J(frame)} && Math.hypot(...ship.posKm.map((v,i) => v - ${J(pos)}[i])) < 0.05;
    })()`);
  };
  const kits = () => ev(`${G}.player().modules.consumables`);
  const world = () => ev(`${G}.world()`);
  const depotReady = () => until("clear depot placement", shown('[data-industry-clear="true"]'));
  const pointReady = () => until("clear point placement", shown(`${aimPoint} [data-placement-ready="true"]`));
  const captures = [];
  const oldWorld = await ev("__test.save.info().id");
  const oldKeybinds = await ev('localStorage.getItem("keybinds-v3")');
  const playerId = await ev(`${G}.localId()`);
  const fixture = await ev(`${G}.fixtures.create("m5-placement-controls", { schemaVersion: 5, world: { research: { completedNodes: ["lg1_bulk_handling"] } }, players: { [${J(playerId)}]: {} } })`);
  const { identifier } = await d.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const keyboard = navigator.keyboard;
    if (!keyboard?.lock || !keyboard.unlock) return;
    const lock = keyboard.lock.bind(keyboard), unlock = keyboard.unlock.bind(keyboard);
    window.__placementKeyboard = [];
    keyboard.lock = async codes => {
      try {
        await lock(codes);
        __placementKeyboard.push(["lock", codes]);
      } catch (error) {
        __placementKeyboard.push(["rejected", error.name]);
        throw error;
      }
    };
    keyboard.unlock = () => {
      unlock();
      __placementKeyboard.push(["unlock"]);
    };
  })()` });

  try {
    // Exercise a saved Tab binding without letting it steal focus navigation in either card.
    await ev('localStorage.setItem("keybinds-v3", JSON.stringify({ toggleSettings: ["j", "tab"], placePoint: ["n"] }))');
    await ev(`${G}.fixtures.activate(${J(fixture)})`);
    await d.reload();
    await d.send("Page.bringToFront");
    await ev(`${G}.m37.comms.nameAi("Vega"); ${G}.m37.comms.dismiss()`);
    // Keep the two kits clear of Next's dev indicator at the bottom-left on narrow viewports.
    for (const item of ["consumable_hull_patch_kit", DEPOT, DEPOT, POINT]) {
      await ev('__dev.grantCargo("fe_ni_metal", 160); __dev.grantCargo("silicates", 115)');
      assert.equal(await ev(`${G}.craft(${J(item)}).status`), "accepted");
    }
    const hotbar = await ev(`${G}.player().modules.hotbar`);
    const depotSlot = hotbar.indexOf(DEPOT);
    const pointSlot = hotbar.indexOf(POINT);
    assert.ok(depotSlot >= 0 && pointSlot >= 0);
    const key = slot => d.press(String((slot + 1) % 10));
    const slotButton = slot => `.hotbar__slot:nth-child(${slot + 1})`;
    const source = (await ev(`${G}.industry.catalog().spots`)).find(s => s.id === "earth_pocket");
    assert.ok(source);
    const near = offset => source.positionKm.map((axis, i) => axis + (i === 0 ? offset : 0));
    await shipAt(source.frameId, near(2));

    await click(slotButton(depotSlot));
    await depotReady();
    assert.equal(await defaultName(depotName), "Depot 1");
    await click(slotButton(pointSlot));
    await pointReady();
    assert.equal(await ev(shown(aimDepot)), false);
    assert.equal(await defaultName(pointName), "Point 1");
    await click(slotButton(depotSlot));
    await depotReady();
    assert.equal(await ev(shown(aimPoint)), false);
    await d.press("n");
    await pointReady();
    await click(slotButton(depotSlot));
    await depotReady();
    assert.equal(await ev(`document.querySelector(${J(slotButton(depotSlot))}).classList.contains("hotbar__slot--active")`), true);
    await click(`${aimDepot} h3`);
    assert.equal((await world()).industry.depots.length, 0, "Clicking placement card chrome does not deploy");
    await click('[data-industry-action="cancel-placement"]');
    await until("windowed depot button cancel", cancelled);
    assert.equal((await kits())[DEPOT], 2);
    assert.equal((await kits())[POINT], 1);

    const [sx, sy, sz] = source.positionKm;
    await shipAt(source.frameId, [sx, sy - 29.96, sz - 0.8]);
    await key(depotSlot);
    await depotReady();
    assert.match(await ev('document.querySelector("[data-industry-clear]").textContent'), /nearby field/i);
    await key(depotSlot);
    await until("close field placement preview", cancelled);
    await shipAt(source.frameId, near(2));

    await d.send("Page.bringToFront");
    await d.press("j");
    await until("ship menu settles with a free cursor", `(() => {
      const panel = document.querySelector(${J(menu)})?.closest(".panel");
      return panel && !document.pointerLockElement &&
        panel.getAnimations().every(animation => animation.playState !== "running");
    })()`);
    await click(`${menu} .display-mode button`);
    const display = await until("fullscreen request settles",
      `${fullscreen} ? "entered" : document.querySelector(".display-mode [role=status]")?.textContent`);
    assert.equal(display, "entered", `Fullscreen entry: ${display}`);
    await d.press("j");
    await until("flight resumes in fullscreen with steering", `${fullscreen} && ${locked} && !${shown(menu)}`);

    for (const [slot, ready] of [[depotSlot, depotReady], [pointSlot, pointReady]]) {
      await key(slot);
      await ready();
      assert.match(await ev('document.querySelector(".placement-keys").textContent'), /J/);
      assert.match(await ev('document.querySelector(".placement-mouse-hint").textContent'), /Left-click to place · Right-click to cancel/);
      assert.doesNotMatch(await ev('document.querySelector(".placement-keys").textContent'), /Esc/);
      assert.equal(await ev(`[...document.querySelectorAll("[data-placement-control]")].every(button => {
        const r = button.getBoundingClientRect();
        const row = button.parentElement.getBoundingClientRect();
        return r.left >= row.left && r.right <= row.right && r.bottom <= row.bottom;
      })`), true, "Both actions fully fit in their row");
      await d.press("j");
      await until("ship-menu key cancels without unlocking", `${cancelled} && ${fullscreen} && ${locked}`);
    }

    await key(depotSlot);
    await depotReady();
    // Confirm the real feature-detected API accepted an Escape-only lock before dispatching Escape.
    const keyboard = await ev("window.__placementKeyboard ?? null");
    const supported = keyboard?.some(([action]) => action === "lock") ?? false;
    if (supported) {
      await until("Escape-only capture active", `JSON.stringify(__placementKeyboard.at(-1)) === '["lock",["Escape"]]'`);
      await d.press("Escape");
      await until("fullscreen Escape closes only placement", `${cancelled} && ${fullscreen} && ${locked}`);
      await until("Escape capture released", `__placementKeyboard.at(-1)?.[0] === "unlock"`);
    } else {
      await d.press("j");
      await until("fullscreen fallback cancels", `${cancelled} && ${fullscreen} && ${locked}`);
    }

    await key(pointSlot);
    await pointReady();
    await key(depotSlot);
    await depotReady();
    await key(pointSlot);
    await pointReady();
    await key(depotSlot);
    await depotReady();
    assert.equal(await ev(locked), true, "Switching kits preserves pointer lock");
    await focusName(depotName);
    await d.type("  Meridian Relay 7  ");
    const ghost = await until("authored depot outline", `(() => {
      const preview = ${G}.industry.depotPreview();
      return preview?.material === "Clear depot outline" && preview;
    })()`);
    assert.ok(Math.abs(ghost.sizeM[0] - 26.5) < 0.15 && Math.abs(ghost.sizeM[2] - 38.47) < 0.15,
      "Placement outline keeps the new depot's solar span and length");
    captures.push(await d.shot("m5-placement-depot-desktop"));
    await canvasClick(true);
    await until("locked canvas deploys named depot", `${cancelled} && ${fullscreen} && ${locked} && ${G}.world().industry.depots.length === 1`);
    assert.equal((await world()).industry.depots[0].name, "Meridian Relay 7");
    assert.equal((await kits())[DEPOT], 1);

    await key(depotSlot);
    await until("occupied depot placement", shown(`${aimDepot} .placement-card__status--blocked`));
    await until("blocked depot outline", `${G}.industry.depotPreview()?.material === "Blocked depot outline"`);
    await canvasClick(true);
    assert.equal((await kits())[DEPOT], 1, "A refused canvas click preserves the depot kit");
    assert.equal((await world()).industry.depots.length, 1);
    await d.press("j");
    await until("cancel blocked depot", `${cancelled} && ${fullscreen} && ${locked}`);

    await shipAt(source.frameId, near(4));
    await key(pointSlot);
    await pointReady();
    assert.equal(await ev(locked), true, "Right-click starts with steering locked");
    await rightClick();
    await until("right-click cancels and releases steering", `${cancelled} && ${fullscreen} && !${locked}`);
    await click(slotButton(depotSlot));
    await depotReady();
    await click('[data-industry-action="cancel-placement"]');
    await until("fullscreen depot button cancel", `${cancelled} && ${fullscreen}`);
    await click(slotButton(pointSlot));
    await pointReady();
    await click('[data-point-action="cancel"]');
    await until("fullscreen point button cancel", `${cancelled} && ${fullscreen}`);
    assert.equal((await kits())[DEPOT], 1);
    assert.equal((await kits())[POINT], 1);

    await shipAt(source.frameId, near(2));
    await key(pointSlot);
    await until("occupied point placement", shown(`${aimPoint} .placement-card__status--blocked`));
    assert.match(await ev(`document.querySelector(${J(`${aimPoint} [role=status]`)}).textContent`), /depot/i);
    await canvasClick();
    assert.equal((await kits())[POINT], 1, "A refused canvas click preserves the point kit");
    assert.equal((await world()).replication.points.length, 1);
    assert.equal(await ev(locked), false, "An unlocked placement click does not capture the pointer");
    assert.equal(await ev('getComputedStyle(document.querySelector(".flight-hud__hint--lock")).visibility'), "hidden");
    await rightClick();
    await until("right-click with the cursor free cancels from the canvas", `${cancelled} && ${fullscreen}`);

    await shipAt(source.frameId, near(7));
    await click(slotButton(pointSlot));
    await pointReady();
    await focusName(pointName);
    await d.press("j");
    await d.type("unction Camp");
    assert.equal(await defaultName(pointName), "junction Camp");
    captures.push(await d.shot("m5-placement-point-desktop"));
    await canvasClick();
    await until("unlocked canvas places named point", `${cancelled} && ${fullscreen} && !${locked} && ${G}.rep.points().filter(p => p.name === "junction Camp").length === 1`);
    assert.equal((await kits())[POINT] ?? 0, 0);

    await shipAt(source.frameId, near(4));
    await click(slotButton(depotSlot));
    await depotReady();
    assert.equal(await defaultName(depotName), "Depot 1");
    await d.press("Enter");
    await until("hotbar Enter deploys to flight", `${cancelled} && ${fullscreen} && ${G}.world().industry.depots.length === 2`);
    assert.equal((await world()).industry.depots[1].name, "Depot 1");
    assert.equal((await kits())[DEPOT] ?? 0, 0);

    await ev("document.exitFullscreen()");
    await until("windowed flight after fullscreen exit", `!document.fullscreenElement && !${shown(menu)}`);
    if (await ev(locked)) {
      await rightClick();
      await until("pointer free for touch", `!${locked}`);
    }

    await ev('__dev.grantCargo("fe_ni_metal", 160); __dev.grantCargo("silicates", 115)');
    assert.equal(await ev(`${G}.craft(${J(POINT)}).status`), "accepted");
    await ev('__dev.grantCargo("fe_ni_metal", 160); __dev.grantCargo("silicates", 115)');
    assert.equal(await ev(`${G}.craft(${J(DEPOT)}).status`), "accepted");
    await shipAt(source.frameId, near(10));
    await key(pointSlot);
    await pointReady();
    await d.press("Escape");
    await until("windowed point Escape", cancelled);
    await key(pointSlot);
    await pointReady();
    await focusName(pointName);
    await d.press("Tab");
    assert.equal(await ev('document.activeElement?.matches(\'[data-point-action="cancel"]\')'), true);
    await d.press("Enter");
    await until("focused Cancel button activates by keyboard", cancelled);

    await d.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await d.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 3 });
    touch = true;
    await d.reload();
    await shipAt(source.frameId, near(10));
    await until("portrait touch mode", 'innerWidth === 390 && matchMedia("(pointer: coarse)").matches');
    await until("touch steering mounted", shown(".touch-flight__stick"));
    const checkTouchTargets = async selector => {
      assert.equal(await ev(`[...document.querySelectorAll(${J(`${selector} :is(input, [data-placement-control])`)})].every(control => {
        const r = control.getBoundingClientRect();
        return r.height >= 44 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
      })`), true, `Touch controls fit ${selector}`);
      assert.equal(await ev(`getComputedStyle(document.querySelector(${J(`${selector} .placement-keys`)})).display`), "none");
      assert.equal(await ev(`(() => {
        const card = document.querySelector(${J(selector)}).getBoundingClientRect();
        return [...document.querySelectorAll(".touch-flight__stick, .touch-flight__engine, .ship-dashboard, .reticle__circle")].every(el => {
          const r = el.getBoundingClientRect();
          return card.bottom <= r.top || card.right <= r.left || card.top >= r.bottom || card.left >= r.right;
        });
      })()`), true, "Placement leaves the flight controls, dashboard and aiming reticle clear");
    };
    const touchActions = async (slot, ready, selector, cancelButton, confirmButton, name) => {
      await click(slotButton(slot));
      await ready();
      await checkTouchTargets(selector);
      await click(cancelButton);
      await until("tap cancels", cancelled);
      await click(slotButton(slot));
      await ready();
      await click(nameInput(selector));
      await d.type(name);
      assert.equal(await defaultName(nameInput(selector)), name);
      const kind = selector === aimDepot ? "depot" : "point";
      captures.push(await d.shot(`m5-placement-${kind}-portrait`));
      await d.send("Emulation.setDeviceMetricsOverride", { width: 844, height: 390, deviceScaleFactor: 1, mobile: false });
      await until("landscape touch mode", "innerWidth === 844 && innerHeight === 390");
      await checkTouchTargets(selector);
      captures.push(await d.shot(`m5-placement-${kind}-landscape`));
      await d.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
      await until("portrait touch mode restored", "innerWidth === 390 && innerHeight === 844");
      await click(confirmButton);
      await until("tap deploys", cancelled);
    };
    await touchActions(depotSlot, depotReady, aimDepot, '[data-industry-action="cancel-placement"]', '[data-industry-action="place"]', "Touch Relay");
    assert.equal((await world()).industry.depots.at(-1)?.name, "Touch Relay");
    await shipAt(source.frameId, near(13));
    const pointsBeforeTouch = (await world()).replication.points.length;
    await touchActions(pointSlot, pointReady, aimPoint, '[data-point-action="cancel"]', '[data-point-action="place"]', "Touch Camp");
    assert.equal((await world()).replication.points.length, pointsBeforeTouch + 1);
    assert.equal((await world()).replication.points.at(-1)?.name, "Touch Camp");

    return { windowed: true, fullscreen: true, escapeLock: supported, touch: true, captures };
  } finally {
    if (touch) {
      await d.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await d.send("Emulation.clearDeviceMetricsOverride");
    }
    await d.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    await ev(`(async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
      if (document.pointerLockElement) document.exitPointerLock();
      const keybinds = ${J(oldKeybinds)};
      if (keybinds === null) localStorage.removeItem("keybinds-v3");
      else localStorage.setItem("keybinds-v3", keybinds);
      ${G}.fixtures.activate(${J(oldWorld)});
    })()`);
    await d.reload();
    await ev(`${G}.fixtures.remove(${J(fixture)})`);
  }
}
