// Rename two pre-existing structures using normal controls, then reload their world.
import assert from "node:assert/strict";

export default async function structureNames(page) {
  const ev = js => page.evaluate(js);
  const G = "__test.gameplay";
  const j = JSON.stringify;
  const previous = await ev("__test.save.info().id");
  const fixture = await ev(`(async () => {
    const g = ${G};
    const data = JSON.parse(await g.fixtures.export(${j(previous)})).data;
    const origin = g.industry.catalog().spots[0];
    const pose = { frameId: origin.frameId, positionKm: origin.positionKm, quaternion: [0,0,0,1] };
    data.world.industry.depots = [{ ...pose, id: "naming-test", name: "Depot 1", by: g.localId() }];
    data.world.industry.drones = [];
    data.world.replication.points.push({ ...pose, id: "point-test", name: "Point 1", by: g.localId(), starter: false,
      positionKm: pose.positionKm.map((n,i) => n + (i === 0 ? 2 : 0)), createdAt: Date.now() });
    return g.fixtures.create("structure-names", data);
  })()`);
  const until = async (expr, msg) => {
    for (let i = 0; i < 100; i++) {
      const result = await ev(expr);
      if (result) return result;
      await page.sleep(100);
    }
    throw new Error(msg ?? expr);
  };
  const click = async selector => {
    const xy = await until(`(() => {
      const b = document.querySelector(${j(selector)});
      if (!b || b.disabled) return false;
      b.scrollIntoView({ block: "nearest" });
      const r = b.getBoundingClientRect(), x = r.left+r.width/2, y = r.top+r.height/2;
      return b.contains(document.elementFromPoint(x,y)) ? [x,y] : false;
    })()`, selector);
    await page.click(...xy);
  };
  const edit = async (trigger, name, cancel = false) => {
    await click(trigger);
    await until('document.activeElement?.matches(".industry__rename-form input")');
    // Keyboard users can cycle through the modal without activating flight or the HUD.
    await page.type(name);
    for (let i = 0; i < 4; i++) {
      await page.press("Tab");
      assert.ok(await ev('!!document.activeElement?.closest(".panel[role=dialog]")'), "focus stayed in the rename dialog");
    }
    await until('document.activeElement?.matches(".industry__rename-form input")');
    await page.press(cancel ? "Escape" : "Enter");
    await until('!document.querySelector(".industry__rename-form") && !!document.querySelector(".industry__roster")');
  };
  try {
    await ev(`${G}.fixtures.activate(${j(fixture)})`);
    await page.reload();
    await ev(`${G}.m37.comms.nameAi("Vega"); ${G}.m37.comms.dismiss()`);
    const src = await ev(`${G}.industry.catalog().spots[0]`);
    // Offset the ship sideways to keep the depot name outside the reticle exclusion zone.
    const at = src.positionKm.map((n,i) => n + [0.07,0,-0.32][i]);
    await ev(`${G}.rep.teleportRel(${j(src.frameId)}, ${j(at)}, [0,0,0,1])`);
    const marker = '.mk[data-id="depot:naming-test"]';
    const gap = await until(`(() => {
      const m = document.querySelector(${j(marker)});
      const label = m?.querySelector(".mk__name");
      if (!m || m.classList.contains("mk--hidden") || !label || label.style.display === "none" || getComputedStyle(label).visibility === "hidden") return null;
      const box = (m.querySelector(m.classList.contains("mk--bracket") ? ".mk__brackets" : ".mk__glyph")).getBoundingClientRect();
      return { px: label.getBoundingClientRect().top - box.bottom };
    })()`, "visible depot marker and name");
    assert.ok(gap.px >= 0 && gap.px <= 12, `label-to-marker gap ${gap.px}px`);
    await page.press("b");
    await click('[data-industry-depot="naming-test"]');
    await edit('[aria-label="Rename depot Depot 1"]', "Discard", true);
    await edit('[aria-label="Rename depot Depot 1"]', "Kiln");
    await click("[data-industry-points]");
    await edit('[aria-label="Rename replication point Point 1"]', "Lunar refuge");
    await page.press("Escape");
    await until(`document.querySelector(${j(marker + " .mk__name")})?.textContent === "Kiln"`);
    await page.reload();
    assert.equal(await ev(`${G}.world().industry.depots.find(d => d.id === "naming-test").name`), "Kiln");
    assert.equal(await ev(`${G}.rep.points().find(p => p.id === "point-test").name`), "Lunar refuge");
    return { pass: true, depotMarkerGapPx: gap.px };
  } finally {
    await ev(`${G}.fixtures.activate(${j(previous)})`);
    await page.reload();
    await ev(`${G}.fixtures.remove(${j(fixture)})`);
  }
}
