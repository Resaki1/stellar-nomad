// Run with drive:coop at --size 390x844. Only the host profile loads the game.
export default async function touchFlight({ host, sleep }) {
  await host.send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
  await host.send("Page.addScriptToEvaluateOnNewDocument", {source: `
    Object.defineProperty(document,"pointerLockElement",{value:undefined});
    Object.defineProperty(document,"exitPointerLock",{value:undefined});`});
  await host.load(); await host.ready();
  const previous = await host.evaluate("__test.coop.worldId()");
  const fixture = await host.evaluate('__test.gameplay.fixtures.create("touch-flight","new")');
  const touch = (type, touchPoints) => host.send("Input.dispatchTouchEvent", {type,touchPoints});
  const point = (sel, id, offset = 0) => host.evaluate(`(() => {
    const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return {id:${id}, x:r.left+r.width/2+${offset}, y:r.top+r.height/2};
  })()`);
  const tap = async sel => { const p = await point(sel,1); await touch("touchStart",[p]); await touch("touchEnd",[]); await sleep(150); };
  try {
    await host.evaluate(`__test.gameplay.fixtures.activate(${JSON.stringify(fixture)})`);
    await host.load(); await host.evaluate('__test.ready()');
    const C = "__test.gameplay.m37.comms";
    await host.evaluate(`${C}.reset(); ${C}.enqueue("opening_001")`);
    for (let i=0; i<14 && !await host.evaluate('!!document.querySelector("#ai-name-input")'); i++) {
      if (await host.evaluate('!!document.querySelector(".comms-overlay")')) await tap(".comms-overlay");
      await sleep(200);
    }
    await tap("#ai-name-input"); await host.send("Input.insertText",{text:"Kepler"}); await tap(".ai-name-overlay__confirm");
    await tap('.hud__panel-btn[title^="Research"]');
    const panel = await host.evaluate('document.querySelector("#panel-title")?.textContent');
    if (!panel?.includes("Research")) throw Error("Research failed to open");
    await tap(".panel__close");
    const stick = await point(".touch-flight__stick",1,22);
    const thrust = await point('[aria-label="Thrust"]',2);
    await touch("touchStart",[stick]); await touch("touchStart",[stick,thrust]); await sleep(650);
    const held = await host.evaluate('__test.flight.input()');
    await touch("touchCancel",[]); await sleep(100);
    const released = await host.evaluate('__test.flight.input()');
    await tap('[aria-label="Brake"]');
    const stopped = await host.evaluate('__test.flight.input()');
    return {pass: held.stickYaw > 0.4 && held.held.accelerate && held.throttle > 0 && released.stickYaw === 0 &&
      !released.held.accelerate && stopped.brakeLatched && stopped.throttle === 0, throttle:held.throttle, yaw:held.stickYaw, panel, brakeLatched:stopped.brakeLatched};
  } finally {
    await host.evaluate(`__test.gameplay.fixtures.activate(${JSON.stringify(previous)})`);
    await host.load(); await host.ready();
    await host.evaluate(`__test.gameplay.fixtures.remove(${JSON.stringify(fixture)})`);
  }
}
