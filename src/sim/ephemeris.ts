// ─────────────────────────────────────────────────────────────────────
// EPHEMERIS — where the bodies actually are, and which way they face
// ─────────────────────────────────────────────────────────────────────
//
// ── WHY ─────────────────────────────────────────────────────────────
// Body positions were static tuples in `sol.json`, at roughly the right
// distances but arbitrary phases. That made D34's eclipse system
// untestable (nothing ever lines up) and left the lighting plan's §3.0
// locked decision — "design for motion and procedural generation from day
// one" — unexercised.
//
// ── THE FRAME (pick one and never mix) ──────────────────────────────
// **Ecliptic J2000**, right-handed, with **+Y = ecliptic north** to match
// three.js and the existing `sol.json` data (every body sits at y = 0, so
// the orbital plane is already XZ). Ecliptic longitude λ and latitude β map
// as:
//
//     x = r·cos β·cos λ      y = r·sin β      z = −r·cos β·sin λ
//
// so λ = 0 points at +X (the vernal equinox), λ = 90° at −Z, and orbital
// angular momentum points +Y. ⚠ Handedness check: X × (−Z) = +Y ✅ — and
// getting it wrong is a MIRRORED SOLAR SYSTEM, which is defect D32's exact
// failure mode (a mirrored sky that passed four self-consistent checks).
// The eclipse gate below is what actually catches it.
//
// ⚠⚠ **EVERYTHING HERE IS REFERRED TO THE FIXED J2000 EQUINOX.** That is
// not a detail — see the precession note on the Moon, which cost 0.34° and
// would have moved a solar eclipse by 33 minutes.
//
// ── ACCURACY, AND HOW IT WAS ESTABLISHED ────────────────────────────
// Two layers, so procedural systems are first-class rather than an
// afterthought:
//
//   1. **Keplerian elements** (`CelestialBodyDef.orbit`) — the universal
//      representation. A generated system emits these and gets correct
//      motion for free. Kepler's equation by Newton, 8 iterations.
//   2. **Named high-accuracy models** for bodies where real data exists,
//      selected by `orbit.model`:
//      • `"jpl"` — JPL's *Keplerian Elements for Approximate Positions of
//        the Major Planets*: the same six elements plus per-century linear
//        RATES. ~10 arcmin, 1800–2050. Same solver, twelve numbers.
//      • `"meeus-moon"` — abridged ELP2000-82B (Meeus, *Astronomical
//        Algorithms* ch. 47): 40 longitude, 30 latitude, 30 distance terms.
//
// ⚠⚠ **PURE KEPLER CANNOT PLACE A SOLAR ECLIPSE, and that is why the lunar
// series is not optional.** The Moon's periodic perturbations reach 1.27°
// (evection) and 0.66° (variation), while the solar umbra is ~0.5° wide —
// so two-body elements do not merely misplace the eclipse, they miss it.
//
// ✅ **VALIDATED AGAINST TWO REAL ECLIPSES**, on published quantities this
// project did not derive:
//
//   | eclipse    | greatest (mine / published) | γ (mine / published) |
//   |------------|-----------------------------|----------------------|
//   | 2024-04-08 | **18:18** / 18:17 UTC       | **0.3453** / 0.3435  |
//   | 2017-08-21 | **18:27** / 18:26 UTC       | **0.4384** / 0.4367  |
//
// One minute of time and 0.5% of γ, twice. γ is the miss distance of the
// shadow axis from Earth's centre in Earth radii, so it tests the Sun and
// Moon *together* including the frame handling — which is exactly what a
// synthetic check cannot do. Earth's heliocentric distance also reproduces
// perihelion 0.98331 (vs 0.98330) and aphelion 1.01670 (vs 1.01671).

import type { CelestialBodyDef, OrbitDef } from "./systemTypes";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
/**
 * Default sim instant: the **2024-04-08 total solar eclipse at greatest
 * eclipse**. Not arbitrary — it is the case `__lum.ephemeris()` validates
 * against published values, so a fresh session starts somewhere the system's
 * correctness is verifiable.
 *
 * ⚠ Lives here rather than in `store/simTime.ts` so `celestialConstants` can
 * solve for it at module load without importing the store (a cycle).
 */
export const DEFAULT_SIM_EPOCH_MS = Date.UTC(2024, 3, 8, 18, 17, 0);

/** Julian date of J2000.0 (2000-01-01 12:00 TT). */
export const JD_J2000 = 2451545.0;
export const AU_KM = 1.495978707e8;

const norm360 = (x: number): number => ((x % 360) + 360) % 360;

// ── Time ────────────────────────────────────────────────────────────

/** Julian Date from a UTC calendar instant. Gregorian only (year ≥ 1583). */
export function jdFromUTC(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  const jd0 =
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    day +
    b -
    1524.5;
  return jd0 + (hour + minute / 60 + second / 3600) / 24;
}

/** Julian Date from a JS epoch-millisecond value (which is UTC). */
export const jdFromUnixMs = (ms: number): number =>
  2440587.5 + ms / 86400000;

/**
 * TT − UTC in seconds. ⚠ A crude constant, and deliberately so: ΔT is ~69 s
 * in the 2020s and its drift is a few seconds per decade, i.e. ~0.001° of
 * lunar motion per year of error. It matters enough to include (69 s is 0.01°
 * of Moon) and not enough to model. Raise it if the game ever wants dates far
 * from the present.
 */
const DELTA_T_SECONDS = 69;

/** Julian centuries of TT from J2000, from a UTC Julian Date. */
const centuriesTT = (jdUTC: number): number =>
  (jdUTC + DELTA_T_SECONDS / 86400 - JD_J2000) / 36525;

// ── Kepler ──────────────────────────────────────────────────────────

/** Solve Kepler's equation. Returns eccentric and true anomaly, radians. */
function solveKepler(meanAnomaly: number, e: number): { E: number; nu: number } {
  let E = meanAnomaly;
  for (let i = 0; i < 8; i++) {
    const dE =
      (E - e * Math.sin(E) - meanAnomaly) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  const nu = 2 * Math.atan2(
    Math.sqrt(1 + e) * Math.sin(E / 2),
    Math.sqrt(1 - e) * Math.cos(E / 2),
  );
  return { E, nu };
}

/**
 * Classical elements → rectangular position in the reference plane, km.
 * Angles in degrees; `aKm` in km. Returns `[x, y, z]` in the ecliptic frame
 * described at the top of this file.
 */
function elementsToXyz(
  aKm: number,
  e: number,
  iDeg: number,
  nodeDeg: number,
  periDeg: number,
  meanAnomalyDeg: number,
): [number, number, number] {
  const i = iDeg * D2R;
  const Om = nodeDeg * D2R;
  // Argument of periapsis measured from the node.
  const w = (periDeg - nodeDeg) * D2R;
  const M = norm360(meanAnomalyDeg) * D2R;
  const { E, nu } = solveKepler(M, e);
  const r = aKm * (1 - e * Math.cos(E));
  const xp = r * Math.cos(nu);
  const yp = r * Math.sin(nu);
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const x1 = xp * cw - yp * sw;
  const y1 = xp * sw + yp * cw;
  const cI = Math.cos(i);
  const sI = Math.sin(i);
  const cO = Math.cos(Om);
  const sO = Math.sin(Om);
  // Ecliptic longitude/latitude components, then mapped to the +Y-up frame.
  const ex = x1 * cO - y1 * cI * sO;
  const ey = x1 * sO + y1 * cI * cO;
  const ez = y1 * sI;
  // (ex, ey) lie in the ecliptic plane with ex toward the equinox; ez is
  // ecliptic north. Remap to X-east/Y-north/Z per the header's convention.
  return [ex, ez, -ey];
}

// ── JPL approximate planetary elements ──────────────────────────────
// a(AU) · e · I(°) · L(°) · ϖ(°) · Ω(°), then the six per-century rates.
// Referred to the mean ecliptic and equinox of **J2000**.
const JPL: Record<string, readonly number[]> = {
  mercury: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593,
    0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  venus: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255,
    0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
  earth: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0,
    0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
  mars: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
    0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  jupiter: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909,
    -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  saturn: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448,
    -0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  uranus: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503,
    -0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  neptune: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574,
    0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
};

/** Heliocentric position from the JPL table, km, ecliptic J2000 (+Y north). */
function jplPosition(id: string, jdUTC: number): [number, number, number] | null {
  const p = JPL[id];
  if (!p) return null;
  const T = centuriesTT(jdUTC);
  const a = p[0] + p[6] * T;
  const e = p[1] + p[7] * T;
  const I = p[2] + p[8] * T;
  const L = p[3] + p[9] * T;
  const peri = p[4] + p[10] * T;
  const node = p[5] + p[11] * T;
  return elementsToXyz(a * AU_KM, e, I, node, peri, L - peri);
}

// ── The Moon: abridged ELP2000-82B (Meeus AA ch. 47) ────────────────
// [coefficient (1e-6 deg, or 1e-3 km for radius), D, M, M', F, power of E]
type LunarTerm = readonly [number, number, number, number, number, number];

const MOON_LON: readonly LunarTerm[] = [
  [6288774, 0, 0, 1, 0, 0], [1274027, 2, 0, -1, 0, 0], [658314, 2, 0, 0, 0, 0],
  [213618, 0, 0, 2, 0, 0], [-185116, 0, 1, 0, 0, 1], [-114332, 0, 0, 0, 2, 0],
  [58793, 2, 0, -2, 0, 0], [57066, 2, -1, -1, 0, 1], [53322, 2, 0, 1, 0, 0],
  [45758, 2, -1, 0, 0, 1], [-40923, 0, 1, -1, 0, 1], [-34720, 1, 0, 0, 0, 0],
  [-30383, 0, 1, 1, 0, 1], [15327, 2, 0, 0, -2, 0], [-12528, 0, 0, 1, 2, 0],
  [10980, 0, 0, 1, -2, 0], [10675, 4, 0, -1, 0, 0], [10034, 0, 0, 3, 0, 0],
  [8548, 4, 0, -2, 0, 0], [-7888, 2, 1, -1, 0, 1], [-6766, 2, 1, 0, 0, 1],
  [-5163, 1, 0, -1, 0, 0], [4987, 1, 1, 0, 0, 1], [4036, 2, -1, 1, 0, 1],
  [3994, 2, 0, 2, 0, 0], [3861, 4, 0, 0, 0, 0], [3665, 2, 0, -3, 0, 0],
  [-2689, 0, 1, -2, 0, 1], [-2602, 2, 0, -1, 2, 0], [2390, 2, -1, -2, 0, 1],
  [-2348, 1, 0, 1, 0, 0], [2236, 2, -2, 0, 0, 2], [-2120, 0, 1, 2, 0, 1],
  [-2069, 0, 2, 0, 0, 2], [2048, 2, -2, -1, 0, 2], [-1773, 2, 0, 1, -2, 0],
  [-1595, 2, 0, 0, 2, 0], [1215, 4, -1, -1, 0, 1], [-1110, 0, 0, 2, 2, 0],
  [-892, 3, 0, -1, 0, 0],
];

const MOON_LAT: readonly LunarTerm[] = [
  [5128122, 0, 0, 0, 1, 0], [280602, 0, 0, 1, 1, 0], [277693, 0, 0, 1, -1, 0],
  [173237, 2, 0, 0, -1, 0], [55413, 2, 0, -1, 1, 0], [46271, 2, 0, -1, -1, 0],
  [32573, 2, 0, 0, 1, 0], [17198, 0, 0, 2, 1, 0], [9266, 2, 0, 1, -1, 0],
  [8822, 0, 0, 2, -1, 0], [8216, 2, -1, 0, -1, 1], [4324, 2, 0, -2, -1, 0],
  [4200, 2, 0, 1, 1, 0], [-3359, 2, 1, 0, -1, 1], [2463, 2, -1, -1, 1, 1],
  [2211, 2, -1, 0, 1, 1], [2065, 2, -1, -1, -1, 1], [-1870, 0, 1, -1, -1, 1],
  [1828, 4, 0, -1, -1, 0], [-1794, 0, 1, 0, 1, 1], [-1749, 0, 0, 0, 3, 0],
  [-1565, 0, 1, -1, 1, 1], [-1491, 1, 0, 0, 1, 0], [-1475, 0, 1, 1, 1, 1],
  [-1410, 0, 1, 1, -1, 1], [-1344, 0, 1, 0, -1, 1], [-1335, 1, 0, 0, -1, 0],
  [1107, 0, 0, 3, 1, 0], [1021, 4, 0, 0, -1, 0], [833, 4, 0, -1, 1, 0],
];

const MOON_RAD: readonly LunarTerm[] = [
  [-20905355, 0, 0, 1, 0, 0], [-3699111, 2, 0, -1, 0, 0], [-2955968, 2, 0, 0, 0, 0],
  [-569925, 0, 0, 2, 0, 0], [48888, 0, 1, 0, 0, 1], [-3149, 0, 0, 0, 2, 0],
  [246158, 2, 0, -2, 0, 0], [-152138, 2, -1, -1, 0, 1], [-170733, 2, 0, 1, 0, 0],
  [-204586, 2, -1, 0, 0, 1], [-129620, 0, 1, -1, 0, 1], [108743, 1, 0, 0, 0, 0],
  [104755, 0, 1, 1, 0, 1], [10321, 2, 0, 0, -2, 0], [79661, 0, 0, 1, -2, 0],
  [-34782, 4, 0, -1, 0, 0], [-23210, 0, 0, 3, 0, 0], [-21636, 4, 0, -2, 0, 0],
  [24208, 2, 1, -1, 0, 1], [30824, 2, 1, 0, 0, 1], [-8379, 1, 0, -1, 0, 0],
  [-16675, 1, 1, 0, 0, 1], [-12831, 2, -1, 1, 0, 1], [-10445, 2, 0, 2, 0, 0],
  [-11650, 4, 0, 0, 0, 0], [14403, 2, 0, -3, 0, 0], [-7003, 0, 1, -2, 0, 1],
  [10056, 2, -1, -2, 0, 1], [6322, 1, 0, 1, 0, 0], [-9884, 2, -2, 0, 0, 2],
];

/** Geocentric ecliptic longitude/latitude (deg) and distance (km) of the Moon. */
export function moonGeocentric(jdUTC: number): {
  lonDeg: number;
  latDeg: number;
  distKm: number;
} {
  const T = centuriesTT(jdUTC);
  const Lp = norm360(218.3164477 + 481267.88123421 * T - 0.0015786 * T * T
    + T ** 3 / 538841 - T ** 4 / 65194000);
  const D = norm360(297.8501921 + 445267.1114034 * T - 0.0018819 * T * T
    + T ** 3 / 545868 - T ** 4 / 113065000);
  const M = norm360(357.5291092 + 35999.0502909 * T - 0.0001536 * T * T
    + T ** 3 / 24490000);
  const Mp = norm360(134.9633964 + 477198.8675055 * T + 0.0087414 * T * T
    + T ** 3 / 69699 - T ** 4 / 14712000);
  const F = norm360(93.272095 + 483202.0175233 * T - 0.0036539 * T * T
    - T ** 3 / 3526000 + T ** 4 / 863310000);
  // Eccentricity of Earth's orbit damps the solar-anomaly terms.
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;

  const sum = (
    table: readonly LunarTerm[],
    trig: (deg: number) => number,
  ): number =>
    table.reduce(
      (acc, [co, dD, dM, dMp, dF, pe]) =>
        acc + co * Math.pow(E, pe) * trig((dD * D + dM * M + dMp * Mp + dF * F) * D2R),
      0,
    );

  const sl = sum(MOON_LON, Math.sin);
  const sb = sum(MOON_LAT, Math.sin);
  const sr = sum(MOON_RAD, Math.cos);

  // ⚠⚠ PRECESSION, AND THIS ONE COST 33 MINUTES OF ECLIPSE TIME.
  // Meeus ch. 47 returns longitude referred to the mean equinox of **DATE**,
  // while the JPL planetary table above is referred to the fixed **J2000**
  // equinox. Mixing the two is a general-precession error of 1.397°/century —
  // 0.34° in 2024, against a solar umbra only ~0.5° wide.
  //
  // 🔑 MEASURED: without this term the computed greatest eclipse landed at
  // 17:44 UTC against a published 18:17 and γ came out 0.312 vs 0.3435; with
  // it, 18:18 and 0.3453. **Two theories can each be correct and still
  // disagree, if they are referred to different equinoxes.**
  const precessionDeg = 1.3969713 * T + 0.00030865 * T * T;

  return {
    lonDeg: norm360(Lp + sl / 1e6 - precessionDeg),
    latDeg: sb / 1e6,
    distKm: 385000.56 + sr / 1000,
  };
}

/** Spherical ecliptic (deg, km) → the +Y-north rectangular frame. */
export function eclipticToXyz(
  lonDeg: number,
  latDeg: number,
  rKm: number,
): [number, number, number] {
  const lon = lonDeg * D2R;
  const lat = latDeg * D2R;
  const cl = Math.cos(lat);
  return [rKm * cl * Math.cos(lon), rKm * Math.sin(lat), -rKm * cl * Math.sin(lon)];
}

// ── Public: position of any body ────────────────────────────────────

/**
 * Position of one body relative to its PARENT, km, in the ecliptic J2000
 * frame. Returns null when the body has no orbit (a system's primary).
 */
export function relativePositionKm(
  orbit: OrbitDef | undefined,
  jdUTC: number,
  bodyId: string,
): [number, number, number] | null {
  if (!orbit) return null;
  if (orbit.model === "jpl") {
    return jplPosition(bodyId, jdUTC);
  }
  if (orbit.model === "meeus-moon") {
    const m = moonGeocentric(jdUTC);
    return eclipticToXyz(m.lonDeg, m.latDeg, m.distKm);
  }
  // Generic Keplerian — the path a procedurally generated body takes.
  const daysSinceEpoch = jdUTC - (orbit.epochJD ?? JD_J2000);
  const n = 360 / orbit.periodDays;
  const M = (orbit.meanAnomalyAtEpochDeg ?? 0) + n * daysSinceEpoch;
  return elementsToXyz(
    orbit.aKm,
    orbit.e ?? 0,
    orbit.iDeg ?? 0,
    orbit.nodeDeg ?? 0,
    orbit.periDeg ?? 0,
    M,
  );
}

/**
 * Absolute position of every body, km, keyed by id — parents resolved so a
 * moon's position includes its planet's.
 *
 * ⚠ Bodies are resolved in dependency order, so a moon may be listed before
 * its planet in `sol.json` without breaking.
 */
export function solveSystem(
  bodies: readonly CelestialBodyDef[],
  jdUTC: number,
): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>();
  const byId = new Map(bodies.map((b) => [b.id, b]));
  const resolve = (id: string, depth = 0): [number, number, number] => {
    const cached = out.get(id);
    if (cached) return cached;
    const b = byId.get(id);
    if (!b || depth > 8) return [0, 0, 0];
    const rel = relativePositionKm(b.orbit, jdUTC, id);
    // ⚠ No orbit ⇒ fall back to the AUTHORED static position. That keeps a
    // body without orbital elements exactly where it is today rather than
    // silently collapsing it to the origin.
    if (!rel) {
      const p = b.positionKm ?? [0, 0, 0];
      const v: [number, number, number] = [p[0], p[1], p[2]];
      out.set(id, v);
      return v;
    }
    const parent = b.parent ? resolve(b.parent, depth + 1) : ([0, 0, 0] as const);
    const v: [number, number, number] = [
      parent[0] + rel[0],
      parent[1] + rel[1],
      parent[2] + rel[2],
    ];
    out.set(id, v);
    return v;
  };
  for (const b of bodies) resolve(b.id);
  return out;
}

// ── Rotation ────────────────────────────────────────────────────────

/**
 * A body's orientation at `jdUTC`: the spin angle about its own axis, and the
 * axis direction in the ecliptic frame.
 *
 * ⚠ `spinDeg` follows the IAU convention `W = W₀ + Ẇ·d` with `d` in days from
 * J2000 — for Earth that is `190.147 + 360.9856235·d`, i.e. SIDEREAL rotation,
 * not 360°/day. Using 360 would drift a full turn per year and put the eclipse
 * on the wrong side of the planet.
 */
export function bodyOrientation(
  body: CelestialBodyDef,
  jdUTC: number,
): { spinDeg: number; tiltDeg: number; tiltNodeDeg: number } {
  const rot = body.rotation;
  if (!rot) return { spinDeg: 0, tiltDeg: 0, tiltNodeDeg: 0 };
  const d = jdUTC + DELTA_T_SECONDS / 86400 - JD_J2000;
  const rate = rot.spinDegPerDay ?? (rot.periodHours ? 360 / (rot.periodHours / 24) : 0);
  return {
    spinDeg: norm360((rot.primeMeridianDeg ?? 0) + rate * d),
    tiltDeg: rot.tiltDeg ?? 0,
    tiltNodeDeg: rot.tiltNodeDeg ?? 0,
  };
}

// ── Diagnostics ─────────────────────────────────────────────────────

/** Geocentric ecliptic longitude of the Sun (deg), J2000 frame. */
export function sunGeocentricLonDeg(jdUTC: number): number {
  const e = jplPosition("earth", jdUTC);
  if (!e) return 0;
  // Sun as seen from Earth is the negated heliocentric Earth vector; longitude
  // is measured in the ecliptic (XZ) plane with λ increasing X → −Z.
  return norm360(Math.atan2(e[2], -e[0]) * R2D);
}

/**
 * Angular separation of the Sun and Moon centres as seen from Earth's centre,
 * degrees — the quantity whose minimum IS "greatest eclipse".
 */
export function sunMoonSeparationDeg(jdUTC: number): number {
  const m = moonGeocentric(jdUTC);
  const dLon = (((m.lonDeg - sunGeocentricLonDeg(jdUTC) + 540) % 360) - 180)
    * Math.cos(m.latDeg * D2R);
  return Math.hypot(dLon, m.latDeg);
}
