// Gates for src/sim/atmosphere.ts (VFX_REALISM_PLAN §6, §5.6): co-rotation speed, sign and
// axes checked against the RENDERED surface (bodyOrientation's meridian, finite-differenced),
// body pick, and the variable-Isp fuel law when present. Plain Node, zero deps.
import { register } from "node:module";
register(new URL("./lib/ts-hooks.mjs", import.meta.url));
const atmo = await import("../src/sim/atmosphere.ts");
const eph = await import("../src/sim/ephemeris.ts");
const cc = await import("../src/sim/celestialConstants.ts");

let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};
const bodies = cc.allBodyDefs();
const body = (id) => bodies.find((b) => b.id === id);
const jd = cc.solvedEphemerisJD();

/** Surface point velocity (m/s) at radius rKm along unit dir u, by differencing the meridian frame. */
function surfaceVel(b, u, rKm) {
  const o0 = eph.bodyOrientation(b, jd, eph.createBodyOrientation());
  const o1 = eph.bodyOrientation(b, jd + 1 / 86400, eph.createBodyOrientation());
  // Express u in body-fixed coords at jd (pole, meridian, pole×meridian), then rebuild at jd+1s.
  const basis = (o) => {
    const p = o.pole, m = o.meridian;
    const e = [p[1] * m[2] - p[2] * m[1], p[2] * m[0] - p[0] * m[2], p[0] * m[1] - p[1] * m[0]];
    return [m, e, p];
  };
  const [m0, e0, p0] = basis(o0), [m1, e1, p1] = basis(o1);
  const dot = (a, c) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
  const c = [dot(u, m0), dot(u, e0), dot(u, p0)];
  const u1 = [0, 1, 2].map((i) => c[0] * m1[i] + c[1] * e1[i] + c[2] * p1[i]);
  return u1.map((x, i) => (x - u[i]) * rKm * 1000);
}

for (const [id, expect, tol] of [["earth", 465.1, 2], ["mars", 241, 3], ["venus", 1.8, 0.3], ["jupiter", 12290, 100]]) {
  const b = body(id);
  if (!b?.atmosphere) { check(`${id} has atmosphere`, false); continue; }
  const o = eph.bodyOrientation(b, jd, eph.createBodyOrientation());
  const u = o.meridian; // equatorial direction
  const rKm = b.radiusKm + 1;
  const a = atmo.ambientAt(b.positionKm[0] + u[0] * rKm, b.positionKm[1] + u[1] * rKm, b.positionKm[2] + u[2] * rKm, atmo.createAmbient());
  const sv = surfaceVel(b, u, rKm);
  const air = [a.airVelX, a.airVelY, a.airVelZ];
  const speed = Math.hypot(...air);
  const err = Math.hypot(air[0] - sv[0], air[1] - sv[1], air[2] - sv[2]);
  check(`${id} pick`, a.bodyId === id, `got ${a.bodyId}`);
  check(`${id} equator co-rotation ${expect}±${tol} m/s`, Math.abs(speed - expect) < tol, speed.toFixed(2));
  check(`${id} co-moving airspeed < 1 m/s (matches rendered surface)`, err < Math.max(1, speed * 1e-3), `|v_air − v_surface| = ${err.toFixed(3)}`);
  check(`${id} inertially stationary airspeed`, Math.abs(atmo.airspeedMps(a, 0, 0, 0) - speed) < 1e-6);
  const pole = o.pole;
  const ap = atmo.ambientAt(b.positionKm[0] + pole[0] * rKm, b.positionKm[1] + pole[1] * rKm, b.positionKm[2] + pole[2] * rKm, atmo.createAmbient());
  check(`${id} pole airspeed ~0`, Math.hypot(ap.airVelX, ap.airVelY, ap.airVelZ) < 1e-6 * speed + 0.01);
}
// Body pick: 1 km above the Moon is vacuum, not Earth.
{
  const m = body("moon") ?? bodies.find((b) => /moon|luna/i.test(b.id));
  const p = m.positionKm;
  const a = atmo.ambientAt(p[0] + m.radiusKm + 1, p[1], p[2], atmo.createAmbient());
  check("moon surface is vacuum", a.bodyId === null, String(a.bodyId));
}
// Earth density and the top fade.
{
  const e = atmo.atmosphereModel("earth");
  check("earth ρ0 ≈ 1.2", Math.abs(e.surfaceDensityKgM3 - 1.22) < 0.05, e.surfaceDensityKgM3.toFixed(3));
  check("earth top ~100 km", e.topKm > 95 && e.topKm < 115, e.topKm.toFixed(1));
  check("top weight 0 at top", atmo.atmosphereTopWeight(e, e.topKm) === 0);
}

const drive = await import("../src/sim/ship/atmoDrive.ts").catch(() => null);
if (drive) {
  const { DEFAULT_RESOURCE_TUNING } = await import("../src/sim/ship/resourceTuning.ts");
  const t = DEFAULT_RESOURCE_TUNING;
  const e = atmo.atmosphereModel("earth");
  const at = (h) => drive.atmoFuel(e, h, 0, 120, 1 / 60, t, drive.createAtmoFuel());
  check("vacuum fuel mult is exactly 1", drive.atmoFuel(null, 0, 0, 120, 1 / 60, t, drive.createAtmoFuel()).fuelMult === 1);
  check("earth sea level breathes (mult 1)", Math.abs(at(0).fuelMult - 1) < 1e-9, at(0).fuelMult.toFixed(3));
  check("earth 20 km at cap 10", Math.abs(at(20).fuelMult - 10) < 0.05, at(20).fuelMult.toFixed(3));
  check("earth 90 km ≈ 2.77", Math.abs(at(90).fuelMult - 2.77) < 0.15, at(90).fuelMult.toFixed(3));
  check("earth ≥ top is 1", at(e.topKm + 1).fuelMult === 1);
  check("earth sea-level v_e ≈ 4 km/s", Math.abs(at(0).veKmps - 4) < 0.6, at(0).veKmps.toFixed(2));
  const mars = atmo.atmosphereModel("mars");
  const m = drive.atmoFuel(mars, 0, 0, 120, 1 / 60, t, drive.createAtmoFuel());
  check("mars surface at cap", Math.abs(m.fuelMult - 10) < 0.05, m.fuelMult.toFixed(3));
  const j = drive.atmoFuel(atmo.atmosphereModel("jupiter"), 0, 400, 120, 1 / 60, t, drive.createAtmoFuel());
  check("jupiter at 400 m/s breathes", j.fuelMult < 1.05, j.fuelMult.toFixed(3));
  const pl = (id, h, th = 1) => drive.drivePlume(atmo.atmosphereModel(id), h, th, t, drive.createDrivePlume());
  const sl = pl("earth", 0), h15 = pl("earth", 15), h80 = pl("earth", 80);
  console.log("plume", JSON.stringify({ sl: [sl.peOverPa, sl.cellLenM, sl.machDiskM], h15: [h15.peOverPa, h15.machDiskM], h80: [h80.rarefied01, h80.stopLenM, h80.torch01] }));
  check("earth SL: shock cells, no Mach disk", sl.peOverPa > 0.5 && sl.peOverPa < 3 && sl.cellLenM > 2.5 && sl.cellLenM < 6);
  check("earth 15 km: Mach disk 3–9 m", h15.machDiskM > 2.5 && h15.machDiskM < 10, h15.machDiskM.toFixed(2));
  check("earth 80 km rarefied streak", h80.rarefied01 > 0.9 && h80.torch01 < 0.5);
  check("vacuum is torch", drive.drivePlume(null, 0, 1, t, drive.createDrivePlume()).torch01 === 1);
  check("venus crushed", pl("venus", 0).crushed01 > 0.9);
}
console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
