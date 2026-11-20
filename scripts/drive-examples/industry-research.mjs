/** Unlock depot construction through the same controls a replicant sees in a fresh world. */
import assert from "node:assert/strict";

export default async function industryResearch(d) {
  const ev = d.evaluate;
  const G = "__test.gameplay";
  const fixture = await ev(`${G}.fixtures.create("industry-research", "new", {seed: 1})`);
  const original = await ev("__test.save.info().id");
  const gate = '[data-required-research="lg1_bulk_handling"]';
  const kit = '[data-industry-action="craft-kit"]';
  const evalEl = (selector, expr) => ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return ${expr}; })()`);
  const click = async selector => {
    const xy = await evalEl(selector, `(() => {
      el.scrollIntoView({block: "center"});
      const r = el.getBoundingClientRect(), x = r.left+r.width/2, y = r.top+r.height/2;
      return el.contains(document.elementFromPoint(x,y)) && [x,y];
    })()`);
    assert.ok(xy, selector);
    await d.click(...xy);
    await d.frames(3);
  };
  try {
    await ev(`${G}.fixtures.activate(${JSON.stringify(fixture)})`);
    await d.reload();
    await ev(`${G}.m37.comms.nameAi("Vega"); ${G}.m37.comms.dismiss(); __dev.grantCargo("fe_ni_metal",190); __dev.grantCargo("silicates",100)`);
    await d.frames(20);
    await d.press("b");
    await d.frames(4);
    assert.equal(await evalEl(kit, "el.disabled"), true);
    await click(gate + " summary");
    assert.equal(await evalEl(gate + " button", "el.disabled"), true);
    const sizes = [[390,844],[844,390],[1280,720]];
    for (const [width,height] of sizes) {
      await d.send("Emulation.setDeviceMetricsOverride", {width,height,deviceScaleFactor:1,mobile:false});
      await d.frames(5);
      assert.equal(await evalEl(gate, "el.scrollWidth <= el.clientWidth + 1"), true, `card fits ${width}`);
      assert.equal(await evalEl(gate + " .rp-card__chips", "el.scrollHeight <= el.clientHeight + 1"), true);
      await d.shot(`industry-research-${width}`);
    }
    for (const trialId of ["first_batch","first_fabrication"]) {
      assert.equal((await ev(`${G}.settled({type:"trial.record",trialId:${JSON.stringify(trialId)}})`)).status, "accepted");
    }
    await d.frames(8);
    assert.equal(await evalEl(gate + " button", "el.disabled"), false);
    await click(gate + " button");
    assert.equal(await evalEl(gate, "!el"), true);
    assert.equal(await evalEl(kit, "el.disabled"), false);
    await click(kit);
    assert.equal(await ev(`${G}.player().modules.consumables.consumable_depot_kit`), 1);
    console.log("[industry-research]", JSON.stringify({pass:true, sizes}));
  } finally {
    if (original) {
      await ev(`${G}.fixtures.activate(${JSON.stringify(original)})`);
      await d.reload();
    }
    await ev(`${G}.fixtures.remove(${JSON.stringify(fixture)})`);
  }
}
