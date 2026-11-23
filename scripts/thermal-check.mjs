// Gates for src/sim/ship/thermal.ts (HEAT_SYSTEM_PLAN §3): drive bells and the coolant loop, driven
// through the real resource step. Plain Node, zero deps.
import { register } from "node:module";
register(new URL("./lib/ts-hooks.mjs", import.meta.url));
const rs = await import("../src/sim/ship/resourceStep.ts");
const th = await import("../src/sim/ship/thermal.ts");
const { createShipState } = await import("../src/sim/ship/shipState.ts");
const { DEFAULT_RESOURCE_TUNING: T } = await import("../src/sim/ship/resourceTuning.ts");
const atmo = await import("../src/sim/atmosphere.ts");

let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};
const DT = 1 / 120;
const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : String(x));

/** Run `seconds` with thrust/mining; returns the state plus first-crossing times. */
function run({ s, seconds, thrust = 0, mining = false, body = null, alt = 0, marks = [], down = [] }) {
  s ??= rs.createShipResourceState(T.tankKg, 0);
  const ship = createShipState();
  const req = rs.createResourceRequests();
  req.freeFlight = true; // no propellant bookkeeping needed; bells use thrustMain only… so pass thrust below
  req.atmo = body ? atmo.atmosphereModel(body) : null;
  req.altitudeKm = alt;
  req.miningBeam = mining;
  const hitUp = {}, hitDown = {};
  for (let i = 0, n = Math.round(seconds / DT); i < n; i++) {
    ship.thrustMain = thrust;
    req.freeFlight = false;
    rs.stepShipResources(s, ship, req, T, DT);
    const t = (i + 1) * DT;
    for (const m of marks) if (hitUp[m] === undefined && s.thermal.bellK >= m) hitUp[m] = t;
    for (const m of down) if (hitDown[m] === undefined && s.thermal.bellK <= m) hitDown[m] = t;
  }
  return { s, hitUp, hitDown };
}

const fresh = rs.createShipResourceState(T.tankKg, 0);
check("idle bells start at their vacuum equilibrium (~360 K, below the loop)", fresh.thermal.bellK > 300 && fresh.thermal.bellK < 420, `${f0(fresh.thermal.bellK)} K`);
check("loop at h=0 rejects 77 kW at ~519 K", Math.abs(fresh.thermal.loopK - 519) < 3, `${f0(fresh.thermal.loopK)} K`);
check("loop at h=1 ~588 K", Math.abs(th.loopTempK(1, T) - 588) < 3, `${f0(th.loopTempK(1, T))} K`);

const burn = run({ seconds: 150, thrust: 1, marks: [900, 1200, 1350] });
const eq = burn.s.thermal.bellK;
check("vacuum full thrust: bell equilibrium ≈ 1,400 K", Math.abs(eq - 1400) < 40, `${f0(eq)} K`);
check("visible glow (900 K) after 10–30 s", burn.hitUp[900] > 10 && burn.hitUp[900] < 30, `${burn.hitUp[900]?.toFixed(1)} s`);
check("1,350 K after 40–90 s", burn.hitUp[1350] > 40 && burn.hitUp[1350] < 90, `${burn.hitUp[1350]?.toFixed(1)} s`);
check("thrust alone never moves heat01 (bell conduction < base rejection)", burn.s.heat01 === 0, `heat01 ${burn.s.heat01}, bells→loop ${burn.s.thermal.bellToLoopKW.toFixed(1)} kW`);
check("bells conduct ~20–35 kW into the loop at full thrust", burn.s.thermal.bellToLoopKW > 20 && burn.s.thermal.bellToLoopKW < 35, `${burn.s.thermal.bellToLoopKW.toFixed(1)} kW`);

const cool = run({ s: burn.s, seconds: 180, thrust: 0, down: [1200, 900, 800, 700] });
check("after cutoff: 900 K within 20–50 s, Draper (800 K) within 30–80 s",
  cool.hitDown[900] > 20 && cool.hitDown[900] < 50 && cool.hitDown[800] > 30 && cool.hitDown[800] < 80,
  `1200 K ${cool.hitDown[1200]?.toFixed(1)} s, 900 K ${cool.hitDown[900]?.toFixed(1)} s, 800 K ${cool.hitDown[800]?.toFixed(1)} s, 700 K ${cool.hitDown[700]?.toFixed(1)} s`);
check("cooling rate peaks right after cutoff (|dT/dt| at 1,400 K > 20 K/s)", (() => {
  const s = run({ seconds: 150, thrust: 1 }).s; run({ s, seconds: DT, thrust: 0 }); return -s.thermal.bellRateKps > 20;
})());

const tap = run({ seconds: 3, thrust: 1 });
check("a 3 s tap never glows (< 800 K)", tap.s.thermal.bellK < 800, `${f0(tap.s.thermal.bellK)} K`);

const sl = run({ seconds: 300, thrust: 1, body: "earth", alt: 0.5 });
check("Earth sea level: bell cooler than in vacuum (air-mode jet, convection)", sl.s.thermal.bellK < eq - 200, `${f0(sl.s.thermal.bellK)} K`);

// Mining with and without thrust: the accepted balance change.
const trip = (thrust) => { let t = 0; const s = rs.createShipResourceState(T.tankKg, 0); const ship = createShipState(); const req = rs.createResourceRequests(); req.miningBeam = true;
  while (!s.miningTripped && t < 120) { ship.thrustMain = thrust; rs.stepShipResources(s, ship, req, T, DT); t += DT; } return t; };
const t0 = trip(0), t1 = trip(1);
check("mining trip time unchanged without thrust (15 s design)", Math.abs(t0 - 15) < 0.6, `${t0.toFixed(2)} s`);
check("thrust + mining trips sooner, but not drastically (10–15 s)", t1 < t0 && t1 > 10, `${t1.toFixed(2)} s`);

// Transit predictor plans from heat01 alone: hot bells must not add loop heat during a transit burn.
{
  const s = run({ seconds: 150, thrust: 1 }).s;
  const ship = createShipState(); const req = rs.createResourceRequests(); req.transitHeatKW = 95;
  const h0 = s.heat01; ship.thrustMain = 1; rs.stepShipResources(s, ship, req, T, DT);
  const expect = rs.heatAfter(h0, 95, T, 1, DT);
  check("transit: bells held out of the loop (prediction = execution)", s.thermal.sources.bells === 0 && Math.abs(s.heat01 - expect) < 1e-12, `bells ${s.thermal.sources.bells}`);
}

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
