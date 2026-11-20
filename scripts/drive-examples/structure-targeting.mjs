/**
 * Real R3F dwell timing for structure interactions and transit gaze.
 * DRIVE_PROFILE=m5targeting DRIVE_CDP_PORT=9353 pnpm drive -- --perf --no-isolate --url http://127.0.0.1:3012/ run:scripts/drive-examples/structure-targeting.mjs
 */
import assert from "node:assert/strict";

const G = "__test.gameplay";
const j = JSON.stringify;
const structures = [
  { kind: "depot", ref: "dwell-depot", name: "Dwell Depot", pos: [0, 10_000, 0] },
  { kind: "point", ref: "dwell-point", name: "Dwell Point", pos: [3, 10_000, 0] },
];
const frameId = "earth";
const menu = ".industry";

export default async function structureTargeting(d) {
  const ev = js => d.evaluate(js);
  const previous = await ev("__test.save.info().id");
  const fixture = await ev(`(async () => {
    const g = ${G}, by = g.localId();
    const data = JSON.parse(await g.fixtures.export(${j(previous)})).data;
    const records = ${j(structures)}.map(s => ({
      id: s.ref, name: s.name, by, frameId: ${j(frameId)}, positionKm: s.pos, quaternion: [0,0,0,1], createdAt: Date.now()
    }));
    data.world.industry.depots = [records[0]];
    data.world.industry.drones = [];
    data.world.replication.points = [...data.world.replication.points.filter(p => p.starter), records[1]];
    data.players[by].replication.activeId = "starter";
    return g.fixtures.create("structure-targeting", data);
  })()`);
  const click = async selector => {
    const xy = await until(selector, `(() => {
      const node = document.querySelector(${j(selector)});
      if (!node || node.disabled) return false;
      const rect = node.getBoundingClientRect(), x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2;
      return node.contains(document.elementFromPoint(x, y)) ? [x, y] : false;
    })()`);
    await d.click(...xy);
  };

  const until = (description, expression) => ev(`(async () => {
    const deadline = performance.now() + 6000;
    do {
      const value = (${expression});
      if (value) return value;
      await new Promise(requestAnimationFrame);
    } while (performance.now() < deadline);
    throw Error(${j(description)});
  })()`);
  const aimCommand = ({ pos }, far, atTarget) => {
    const distance = far ? 8 : 1.2;
    const [x, y, z] = pos;
    return `${G}.rep.teleportRel(${j(frameId)}, ${j([x, y, z - distance])}, ${atTarget ? "[0,0,0,1]" : "[0,1,0,0]"})`;
  };
  const aim = (structure, far, atTarget) => ev(aimCommand(structure, far, atTarget));
  const sample = structure => `(() => {
    const g = ${G}, near = g.m37.site.focus(), transit = g.transit.state(), id = ${j(`${structure.kind}:${structure.ref}`)};
    const card = document.querySelector(".target-card");
    return {
      closeCandidate: near.target?.id === id, closeProgress: near.progress, closeLock: near.target?.id === id && near.focused,
      waypointCandidate: transit.gazeActive && g.rep.pois(id).some(p => p.id === id && p.focused),
      waypointProgress: transit.gazeProgress, waypointLock: transit.targeted === id,
      card: card?.dataset.kind ?? "", cardName: card?.querySelector(".target-card__name")?.textContent ?? "",
    };
  })()`;
  const past = (s, expr) => `(() => { const state = ${sample(s)}; return ${expr}; })()`;
  const canSeeCard = s => `state.card === ${j(s.kind)} && state.cardName === ${j(s.name)}`;
  const timedLock = async (s, far) => {
    const fields = far ? ["waypointCandidate", "waypointLock"] : ["closeCandidate", "closeLock"];
    return ev(`(async () => {
      const [candidate, locked] = ${j(fields)};
      let start;
      const deadline = performance.now() + 7000;
      ${aimCommand(s, far, true)};
      do {
        await new Promise(requestAnimationFrame);
        const state = ${sample(s)}, now = performance.now();
        if (start === undefined && state[candidate]) start = now;
        if (state[locked] && start !== undefined) return Math.round(now - start);
      } while (performance.now() < deadline);
      throw Error(${j(`Targeting timing for ${s.kind} (${far ? "waypoint" : "interaction"})`)});
    })()`);
  };

  try {
    await ev(`${G}.fixtures.activate(${j(fixture)})`);
    await d.reload();
    await ev(`${G}.m37.comms.nameAi("Vega"); ${G}.m37.comms.dismiss()`);
    const times = {};

    for (const s of structures) {
      await aim(s, false, true);
      await until("local acquisition in progress", past(s, "state.closeCandidate && state.closeProgress >= 0.28 && state.closeProgress < 0.7"));
      assert.equal(await ev(past(s, canSeeCard(s))), false);
      await d.press("g");
      assert.equal(await ev(`!!document.querySelector(${j(menu)})`), false, "A partial depot lock cannot open Industry");
      assert.equal(await ev(`${G}.rep.activeId()`), "starter", "A partial point lock cannot activate it");

      await aim(s, false, false);
      await until("local aim loss clears progress", past(s, "!state.closeCandidate && state.closeProgress === 0"));
      const ms = await timedLock(s, false);
      assert.ok(ms >= 980 && ms <= 1250, `${s.kind} local lock took ${ms} ms`);
      await until("local card is shown after lock", past(s, canSeeCard(s)));
      assert.equal(await ev(past(s, "state.waypointLock")), false, "A nearby structure stays on the interaction path");

      await aim(s, false, false);
      await until("look away hides the local action", past(s, "!state.closeLock && state.card === ''"));
      await d.press("g");
      assert.equal(await ev(`!!document.querySelector(${j(menu)})`), false);
      assert.equal(await ev(`${G}.rep.activeId()`), "starter");

      await aim(s, false, true);
      await until("local action available after a fresh lock", past(s, canSeeCard(s)));
      await d.press("g");
      if (s.kind === "depot") {
        await until("locked depot opens Industry", `!!document.querySelector(${j(menu)})`);
        await d.press("Escape");
        await until("back to flight", `!document.querySelector(${j(menu)})`);
      } else {
        assert.equal(await ev(`${G}.rep.activeId()`), s.ref);
      }
      times[s.kind] = { interactionMs: ms };
    }

    await ev(`${G}.res.equip("special_transit_drive", "special")`);
    for (const s of structures) {
      await aim(s, true, true);
      await until("transit gaze acquisition in progress", past(s, "state.waypointCandidate && state.waypointProgress >= 0.28 && state.waypointProgress < 0.7"));
      assert.equal(await ev(past(s, "state.waypointLock || state.closeLock")), false);
      await aim(s, true, false);
      await until("waypoint aim loss clears progress", past(s, "!state.waypointCandidate && !state.waypointLock"));
      if (s.kind === "depot") await ev(`${G}.transit.targetProbe("earth", [100, 10_000, 0])`);
      const ms = await timedLock(s, true);
      assert.ok(ms >= 980 && ms <= 1250, `${s.kind} waypoint lock took ${ms} ms`);
      assert.equal(await ev(past(s, "state.closeLock")), false);
      await aim(s, true, false);
      await until("look-away releases the automatic waypoint", past(s, "!state.waypointLock"));
      times[s.kind].waypointMs = ms;
    }

    const depot = structures[0];
    const depotButton = `[data-industry-depot=${j(depot.ref)}]`;
    const trackButton = '[data-industry-action="track-depot"]';
    await aim(depot, true, true);
    await until("depot centered before opening Industry", past(depot, "state.waypointCandidate"));
    await d.press("b");
    await click(depotButton);
    await click(trackButton);
    await until("explicit tracking closes Industry and sets a waypoint", past(depot, `state.waypointLock && !document.querySelector(${j(menu)})`));
    await aim(depot, true, false);
    await d.sleep(500);
    assert.equal(await ev(past(depot, "state.waypointLock")), true, "Manual tracking survives aim loss");

    await aim(depot, true, true);
    await d.frames(3);
    await d.press("b");
    await click(depotButton);
    await click(trackButton);
    await until("explicit untrack clears the waypoint", past(depot, "!state.waypointLock"));
    await d.press("Escape");
    await until("back to flight", `!document.querySelector(${j(menu)})`);
    await d.sleep(1300);
    assert.equal(await ev(past(depot, "state.waypointCandidate || state.waypointLock")), false, "The centered untracked depot stays clear");
    await aim(depot, true, false);
    await d.frames(3);
    await aim(depot, true, true);
    await until("deliberate re-aim starts a new dwell", past(depot, "state.waypointCandidate && !state.waypointLock"));

    return times;
  } finally {
    await ev(`${G}.fixtures.activate(${j(previous)})`);
    await d.reload();
    await ev(`${G}.fixtures.remove(${j(fixture)})`);
  }
}
