/**
 * FIRST_EXPEDITION_PLAN WP2: contacts agree with what the pilot sees.
 *   EXP_PARTS=bank,drone pnpm drive -- --keep --no-isolate run:scripts/drive-examples/expedition-wp2.mjs
 * bank  — while yawing and pitching, Rapier's ship collider carries the drawn hull's bank/lean.
 * drone — a docked drone has a contact surface at its drawn pose: a docking-speed brush stops the
 *         ship there without damage; a head-on hit is one impact episode; the drone stays docked.
 */
import assert from "node:assert/strict";

const G = "__test.gameplay";
const P = "__phys";
const j = JSON.stringify;
const frameId = "earth";
const depotPos = [0, 10_000, 0];

export default async function expeditionWp2(d) {
  const parts = (process.env.EXP_PARTS ?? "bank,drone").split(",");
  const ev = (e) => d.evaluate(e);
  const until = async (label, expr, timeout = 15_000) => {
    const end = Date.now() + timeout;
    do {
      const r = await ev(expr);
      if (r) return r;
      await d.sleep(100);
    } while (Date.now() < end);
    throw Error(`timeout: ${label}`);
  };
  const warp = async (posKm, quat = [0, 0, 0, 1]) => {
    await ev(`${G}.rep.teleportRel(${j(frameId)}, ${j(posKm)}, ${j(quat)})`);
    await until("warp", `(() => { const s = ${G}.rep.ship(); return s && Math.hypot(...s.posKm.map((v,i)=>v-${j(posKm)}[i])) < 0.002; })()`);
    await d.frames(20);
  };

  const previous = await ev("__test.save.info().id");
  const fixture = await ev(`(async () => {
    const g = ${G}, who = g.localId(), data = JSON.parse(await g.fixtures.export(${j(previous)})).data;
    const pose = { frameId: ${j(frameId)}, positionKm: ${j(depotPos)}, quaternion: [0,0,0,1] };
    data.world.industry.depots = [{ ...pose, id: "wp2-depot", name: "Contact Post", by: who, refinery: false, refineProgressS: 0, storage: { items: {}, consumables: {}, fuelKg: 0 } }];
    data.world.industry.drones = [{ id: "wp2-drone", homeId: "wp2-depot", job: null, phase: "idle", status: "unassigned", remainingS: 0, durationS: 0, fuelKg: 0, returnS: 0, via: null, cargo: { items: {}, consumables: {}, fuelKg: 0 } }];
    data.world.replication.points = data.world.replication.points.filter(p => p.starter);
    const me = data.players[who];
    me.isDead = false;
    me.replication = { activeId: "starter" };
    return g.fixtures.create("wp2", data);
  })()`);
  await ev(`${G}.fixtures.activate(${j(fixture)})`);
  await d.reload();
  await ev(`${G}.m37.comms.nameAi("Vega"); ${G}.m37.comms.dismiss()`);
  const results = {};
  try {
    if (parts.includes("bank")) {
      await warp([0, 10_000, 0.2]); // beside the depot: the near field only steps Rapier with colliders around
      const sample = async (key) => {
        await ev(`(() => {
          const r = window.__wp2 = { maxErrDeg: 0, maxBankDeg: 0, maxLeanDeg: 0, n: 0, on: true };
          const tick = () => {
            if (!r.on) return;
            const a = ${P}.attitude(), q = a.engine;
            const hx = a.leanDeg * Math.PI / 360, hz = a.bankDeg * Math.PI / 360;
            const e = [Math.sin(hx)*Math.cos(hz), -Math.sin(hx)*Math.sin(hz), Math.cos(hx)*Math.sin(hz), Math.cos(hx)*Math.cos(hz)];
            const dot = Math.abs(q[0]*e[0]+q[1]*e[1]+q[2]*e[2]+q[3]*e[3]);
            r.maxErrDeg = Math.max(r.maxErrDeg, 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI);
            r.maxBankDeg = Math.max(r.maxBankDeg, Math.abs(a.bankDeg));
            r.maxLeanDeg = Math.max(r.maxLeanDeg, Math.abs(a.leanDeg));
            r.n++;
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        })()`);
        await d.hold(key, 1200);
        await d.frames(30);
        return ev(`(() => { window.__wp2.on = false; return window.__wp2; })()`);
      };
      const yaw = await sample("ArrowLeft");
      const pitch = await sample("ArrowUp");
      // Rapier's attitude is f32: allow its rounding, nothing else.
      results.bank = { yaw, pitch };
      console.log(j({ bank: results.bank }));
      assert.ok(yaw.maxBankDeg > 15, `yaw banks the hull (${yaw.maxBankDeg}°)`);
      assert.ok(pitch.maxLeanDeg > 3, `pitch leans the hull (${pitch.maxLeanDeg}°)`);
      assert.ok(yaw.maxErrDeg < 0.05 && pitch.maxErrDeg < 0.05, `collider attitude = drawn attitude (${yaw.maxErrDeg}°, ${pitch.maxErrDeg}°)`);
    }

    if (parts.includes("drone")) {
      await warp([0, 10_000, -0.15], [0, 0, 0, 1]);
      const [drone] = await until("drone collider near the depot", `${P}.tagged("drone")`);
      const dronePos = drone.relKm;
      // Approach along -X from the open side (the drone docks 8 m off the depot's axis), nose first.
      const beside = (m) => [dronePos[0] + m / 1000, dronePos[1], dronePos[2]];
      const noseWest = [0, -Math.SQRT1_2, 0, Math.SQRT1_2];
      const run = async (name, startM, speedMps) => {
        await warp(beside(startM), noseWest);
        const id = (await until("drone collider", `${P}.tagged("drone")`))[0].id;
        await ev(`${P}.impacts.clear(); ${P}.drainContacts(); true`);
        const hp0 = await ev(`${P}.game.health().health`);
        await ev(`${P}.m5.coast([${-speedMps / 1000}, 0, 0])`);
        const end = Date.now() + ((startM / speedMps) + 4) * 1000;
        let minGapM = Infinity, contacts = 0;
        while (Date.now() < end) {
          await d.sleep(150);
          const s = await ev(`(() => { const s = ${G}.rep.ship(); const all = ${P}.drainContacts(); (window.__wp2ids ??= new Set()); all.forEach(c => window.__wp2ids.add(c.colliderId)); const c = all.filter(c => c.colliderId === ${id}).length; return { p: s.posKm, c }; })()`);
          contacts += s.c;
          minGapM = Math.min(minGapM, (s.p[0] - dronePos[0]) * 1000);
        }
        const r = {
          name, speedMps, id, seen: await ev(`(() => { const r = [...(window.__wp2ids ?? [])]; window.__wp2ids = new Set(); return r; })()`), tags: await ev(`${P}.stats().collidersByTag`), contacts, minCentreGapM: +minGapM.toFixed(2),
          impacts: (await ev(`${P}.impacts.log()`)).filter(i => i.colliderId === id).length,
          hullLoss: +(hp0 - await ev(`${P}.game.health().health`)).toFixed(3),
          droneMovedM: +(Math.hypot(...(await ev(`${P}.tagged("drone")`))[0]?.relKm.map((v, i) => v - dronePos[i]) ?? [NaN]) * 1000).toFixed(3),
        };
        await ev(`${P}.m5.coast([0,0,0])`);
        console.log(j({ drone: r }));
        return r;
      };
      const brush = await run("brush", 12, 1.5);
      const headOn = await run("headOn", 40, 12);
      results.drone = { brush, headOn };
      assert.ok(brush.contacts > 0, "a docking-speed approach touches the drone");
      assert.ok(brush.minCentreGapM > 1, `the ship stops at the drone's hull, not its centre (${brush.minCentreGapM} m)`);
      assert.equal(brush.hullLoss, 0, "a docking-speed brush is free");
      assert.ok(headOn.contacts > 0 && headOn.impacts === 1, `head-on: one impact episode (${headOn.impacts})`);
      assert.ok(brush.droneMovedM < 0.01 && headOn.droneMovedM < 0.01, "the docked drone keeps its berth");
    }
  } finally {
    await ev(`${G}.fixtures.activate(${j(previous)})`);
  }
  return results;
}
