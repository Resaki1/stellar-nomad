// Gates for src/audio/engineAcoustics.ts (AUDIO_PLAN §6.10): the drive heard from inside.
// Exterior jet noise: silent in vacuum and the collisionless beam, ordered by impedance across
// bodies, on the wind bed's scale; shock-cell pitch/gate vs the visible diamonds; pump law.
// Plain Node, zero deps.
import { register } from "node:module";
register(new URL("./lib/ts-hooks.mjs", import.meta.url));
const ea = await import("../src/audio/engineAcoustics.ts");
const wind = await import("../src/audio/wind.ts");
const atmo = await import("../src/sim/atmosphere.ts");
const drive = await import("../src/sim/ship/atmoDrive.ts");
const { DEFAULT_RESOURCE_TUNING: T } = await import("../src/sim/ship/resourceTuning.ts");

let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : String(x));
function at(id, alt, thr = 1) {
  const m = id ? atmo.atmosphereModel(id) : null;
  const pl = drive.drivePlume(m, alt, thr, T, drive.createDrivePlume());
  const spl = ea.jetIncidentSplDb(m, pl, thr);
  return { m, pl, spl, game: wind.windLevelDb(spl + ea.JET_ACOUSTIC_COUPLING_DB), hz: ea.shockCellHz(m, pl), w: m ? ea.shockCellWeight(pl) * ea.shockBandWeight(ea.shockCellHz(m, pl)) : 0 };
}

const rows = [["vacuum", null, 0], ["earth", "earth", 0], ["earth", "earth", 5], ["earth", "earth", 15], ["earth", "earth", 30],
  ["earth", "earth", 45], ["earth", "earth", 60], ["earth", "earth", 80], ["earth", "earth", 90], ["mars", "mars", 0], ["venus", "venus", 0], ["jupiter", "jupiter", 0]];
console.log("body      alt  v_e km/s  p_e/p_a   inc dB  game dB  shock Hz  shock w");
const R = {};
for (const [name, id, alt] of rows) {
  const r = at(id, alt);
  R[`${name}${alt}`] = r;
  console.log(`${name.padEnd(8)} ${String(alt).padStart(4)} ${f1(r.pl.veKmps).padStart(9)} ${f1(r.pl.peOverPa).padStart(8)} ${f1(r.spl).padStart(8)} ${f1(r.game).padStart(8)} ${f1(r.hz).padStart(9)} ${r.w.toFixed(2).padStart(8)}`);
}

check("vacuum: no exterior jet noise", R.vacuum0.spl === -Infinity && R.vacuum0.game <= -wind.WIND_RANGE_DB);
check("Earth 90 km beam (collisionless): silent", R.earth90.game <= -wind.WIND_RANGE_DB + 0.5, `game ${f1(R.earth90.game)} dB`);
check("Earth SL incident ≈ 140–155 dB (wind bed at Mach 1.2 ≈ 148)", R.earth0.spl > 140 && R.earth0.spl < 155, `${f1(R.earth0.spl)} dB`);
check("Earth roar falls monotonically with altitude 0→60 km",
  [0, 5, 15, 30, 45, 60].every((a, i, arr) => i === 0 || R[`earth${a}`].game <= R[`earth${arr[i - 1]}`].game + 1e-9));
check("Venus louder than Earth louder than Mars at the surface",
  R.venus0.spl > R.earth0.spl && R.earth0.spl > R.mars0.spl, `${f1(R.venus0.spl)} > ${f1(R.earth0.spl)} > ${f1(R.mars0.spl)}`);
check("Mars ≥ 10 dB quieter than Earth (thin CO₂ couples poorly)", R.earth0.spl - R.mars0.spl >= 10, `Δ ${f1(R.earth0.spl - R.mars0.spl)} dB`);
check("game level stays inside the bed's range", Object.values(R).every((r) => r.game <= 0 && r.game >= -wind.WIND_RANGE_DB));
check("shock noise weak near ideal expansion (SL, p_e/p_a 1.4), full at 15 km (8.6)", R.earth0.w < 0.05 && R.earth15.w > 0.9,
  `SL w ${R.earth0.w.toFixed(3)}, 15 km w ${R.earth15.w.toFixed(2)}`);
check("Jupiter 185 Hz shock is outside the loop's ±1 oct window → faded, not mis-pitched", R.jupiter0.w === 0, `w ${R.jupiter0.w}`);
check("no incident level above the ½·p_amb linear-acoustics ceiling",
  Object.values(R).every((r) => !(r.pl.pAmbPa > 0) || !Number.isFinite(r.spl) || r.spl <= 20 * Math.log10(0.5 * r.pl.pAmbPa / 20e-6) + 1e-9));
check("Earth 60 km roar ≥ 25 dB below sea level (plume widens, thin air)", R.earth0.spl - R.earth60.spl >= 25, `Δ ${f1(R.earth0.spl - R.earth60.spl)} dB`);
check("shock pitch drops with altitude (cells grow)", R.earth15.hz < R.earth0.hz, `${f1(R.earth0.hz)} → ${f1(R.earth15.hz)} Hz`);
check("no shock cells at 60 km (p_e/p_a ≫ 300) or on Venus (crushed)", R.earth60.w < 0.05 && R.venus0.w < 0.05,
  `60 km w ${R.earth60.w.toFixed(2)}, Venus w ${R.venus0.w.toFixed(2)}`);
const lowThr = at("earth", 0, 0.3);
check("roar scales with throttle (−3..−8 dB at 30 %)", R.earth0.spl - lowThr.spl > 3 && R.earth0.spl - lowThr.spl < 8, `Δ ${f1(R.earth0.spl - lowThr.spl)} dB`);

const p0 = ea.pumpVoice(0, 1), pv = ea.pumpVoice(1, 1), pa = ea.pumpVoice(1, 1 / R.earth0.pl.powerFrac), ph = ea.pumpVoice(0.5, 1);
const p40 = ea.pumpVoice(1, 1 / R.earth45.pl.powerFrac);
check("pump silent at zero throttle", p0.level === 0);
check("pump: vacuum full throttle at base pitch, quiet", pv.cents === 0 && pv.level > 0.3 && pv.level < 0.4, `${pv.level.toFixed(2)}`);
check("pump: sea-level reaction flow (~630×) = +1 oct, +3 dB", Math.abs(pa.cents - 1200) < 1e-6 && Math.abs(pa.level - 0.5) < 1e-9);
check("pump: 45 km between vacuum and sea level", p40.cents > 300 && p40.cents < 1200, `${f1(p40.cents)} cents`);
check("pump: half throttle is lower", ph.cents < 0, `${f1(ph.cents)} cents`);

const hot = ea.thermalTickRates(1400, -31, 0), warm = ea.thermalTickRates(900, -5.3, 0), idle = ea.thermalTickRates(365, -0.01, 0);
check("bell pings densest right after cutoff, sparse when warm, none at idle", hot.bell > 3 && warm.bell > 0.3 && warm.bell < 1 && idle.bell === 0,
  `${hot.bell.toFixed(2)} / ${warm.bell.toFixed(2)} / ${idle.bell}/s`);
check("bell pings on heat-up too (|dT/dt|, both signs)", ea.thermalTickRates(900, 25, 0).bell > 2);
check("loop ticks follow the loop's |dT/dt|", ea.thermalTickRates(365, 0, -6).loop > 1 && ea.thermalTickRates(365, 0, 0).loop === 0);
check("coolant bed silent at idle, rises with heat01", ea.coolantVoice(0).level === 0 && ea.coolantVoice(1).level === 1 && ea.coolantVoice(0.5).cents === 250);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
