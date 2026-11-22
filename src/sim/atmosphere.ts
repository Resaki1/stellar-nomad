// ---------------------------------------------------------------------------
// SIM-SIDE ATMOSPHERE — docs/VFX_REALISM_PLAN.md §5.6.6 (V1) and §6 (A1/A3).
//
// The one headless model of "what air is the ship in": per-body thermodynamics
// (molar mass, γ, isothermal hydrostatic density), the body pick, and the
// co-rotating air velocity. Audio (wind, propagation), the drive's fuel law and
// the exhaust all read THIS, so they cannot disagree about where the air is.
//
// ⚠ The renderer's `deriveAtmosphere` uses an OPTICAL scale height (oblate,
// spin-corrected gravity, column temperature). This model uses the honest
// hydrostatic H = RT/(Mg) at the mean radius — the value the wind audio was
// tuned on. `topKm` is 12.5 H of this model: where ρ has fallen to ~4e-6 ρ₀.
// ---------------------------------------------------------------------------

import { allBodyDefs, solvedEphemerisJD } from "@/sim/celestialConstants";
import { bodyOrientation, createBodyOrientation } from "@/sim/ephemeris";
import type { AtmosphereGasId, CelestialBodyDef } from "@/sim/systemTypes";

const R_GAS = 8.314462618;
const G_GRAV = 6.6743e-11;
const D2R = Math.PI / 180;

/** Atmosphere top, in scale heights (matches the renderer's TOP_SCALE_HEIGHTS). */
export const TOP_SCALE_HEIGHTS = 12.5;

/**
 * Molar mass (kg/mol) and heat-capacity ratio γ per gas — the single source of
 * truth; the renderer's `GASES` table and the acoustic model both read it.
 * γ are room-temperature values (few-% error for Venus/Titan, ~1% in c).
 */
export const GAS_PROPS: Record<AtmosphereGasId, { molarKgPerMol: number; gamma: number }> = {
  n2: { molarKgPerMol: 0.028014, gamma: 1.4 },
  o2: { molarKgPerMol: 0.031999, gamma: 1.4 },
  co2: { molarKgPerMol: 0.04401, gamma: 1.29 },
  ar: { molarKgPerMol: 0.039948, gamma: 1.667 },
  ch4: { molarKgPerMol: 0.016043, gamma: 1.32 },
  h2: { molarKgPerMol: 0.002016, gamma: 1.41 },
  he: { molarKgPerMol: 0.004003, gamma: 1.667 },
  h2o: { molarKgPerMol: 0.018015, gamma: 1.33 },
  so2: { molarKgPerMol: 0.064066, gamma: 1.29 },
};

export type AtmosphereModel = {
  bodyId: string;
  radiusKm: number;
  /** Mean molar mass of the mixture, kg/mol. */
  molarKgPerMol: number;
  /** Mixture heat-capacity ratio (via Cp, never a mole-average of γ). */
  gamma: number;
  surfaceTemperatureK: number;
  surfacePressurePa: number;
  surfaceDensityKgM3: number;
  surfaceSpeedOfSoundMps: number;
  /** Hydrostatic density e-folding height, km. */
  scaleHeightKm: number;
  /** Altitude above which the air is treated as gone, km. */
  topKm: number;
  dominantGas: AtmosphereGasId;
  dominantFraction: number;
};

/** γ_mix = Cp_mix/(Cp_mix − R); the mole-averaged γ shortcut is wrong (0.9% on H₂/He). */
function mixtureGamma(composition: Partial<Record<AtmosphereGasId, number>>, total: number): number {
  let cpMix = 0;
  for (const [gas, frac] of Object.entries(composition)) {
    const g = frac ? GAS_PROPS[gas as AtmosphereGasId]?.gamma : undefined;
    if (!g) continue;
    cpMix += (frac! / total) * ((g * R_GAS) / (g - 1));
  }
  return cpMix <= R_GAS ? 1.4 : cpMix / (cpMix - R_GAS);
}

function derive(body: CelestialBodyDef): AtmosphereModel | null {
  const atm = body.atmosphere;
  if (!atm) return null;
  let total = 0;
  let molar = 0;
  let dominantGas: AtmosphereGasId = "n2";
  let dominantFraction = 0;
  for (const [gas, frac] of Object.entries(atm.composition)) {
    if (!frac) continue;
    total += frac;
    molar += frac * (GAS_PROPS[gas as AtmosphereGasId]?.molarKgPerMol ?? 0);
    if (frac > dominantFraction) {
      dominantFraction = frac;
      dominantGas = gas as AtmosphereGasId;
    }
  }
  if (total <= 0 || molar <= 0) return null;
  molar /= total;
  const gamma = mixtureGamma(atm.composition, total);
  const T = atm.surfaceTemperatureK;
  const p = atm.surfacePressureBar * 1e5;
  const g = body.massKg && body.radiusKm ? (G_GRAV * body.massKg) / (body.radiusKm * 1000) ** 2 : 9.81;
  const scaleHeightKm = (R_GAS * T) / (molar * g) / 1000;
  return {
    bodyId: body.id,
    radiusKm: body.radiusKm,
    molarKgPerMol: molar,
    gamma,
    surfaceTemperatureK: T,
    surfacePressurePa: p,
    surfaceDensityKgM3: (p * molar) / (R_GAS * T),
    surfaceSpeedOfSoundMps: Math.sqrt((gamma * R_GAS * T) / molar),
    scaleHeightKm,
    topKm: TOP_SCALE_HEIGHTS * scaleHeightKm,
    dominantGas,
    dominantFraction: dominantFraction / total,
  };
}

let _cache: Map<string, AtmosphereModel | null> | null = null;
let _withAir: { body: CelestialBodyDef; model: AtmosphereModel }[] = [];

function ensure(): Map<string, AtmosphereModel | null> {
  if (_cache) return _cache;
  _cache = new Map();
  _withAir = [];
  for (const b of allBodyDefs()) {
    const m = derive(b);
    _cache.set(b.id, m);
    if (m) _withAir.push({ body: b, model: m });
  }
  return _cache;
}

/** A body's atmosphere model, or null if it is airless / unknown. */
export function atmosphereModel(bodyId: string): AtmosphereModel | null {
  return ensure().get(bodyId) ?? null;
}

/** Every body with an atmosphere. */
export function allAtmosphereModels(): AtmosphereModel[] {
  ensure();
  return _withAir.map((e) => e.model);
}

/** Isothermal ρ(h) = ρ₀·e^(−h/H), kg/m³. Negative h clamps to the reference surface. */
export function densityAtAltitude(m: AtmosphereModel, altitudeKm: number): number {
  return m.surfaceDensityKgM3 * Math.exp(-Math.max(0, altitudeKm) / m.scaleHeightKm);
}

/** Isothermal p(h), Pa. */
export function pressureAtAltitude(m: AtmosphereModel, altitudeKm: number): number {
  return m.surfacePressurePa * Math.exp(-Math.max(0, altitudeKm) / m.scaleHeightKm);
}

/** 1 below 0.9·top, smoothly 0 at the top: the blend for co-rotation and any "air present" weight. */
export function atmosphereTopWeight(m: AtmosphereModel, altitudeKm: number): number {
  const t = (altitudeKm - 0.9 * m.topKm) / (0.1 * m.topKm);
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  return 1 - t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Ambient air at a point (A1/A3)
// ---------------------------------------------------------------------------

export type Ambient = {
  /** Body whose atmosphere contains the point, or null in vacuum. */
  bodyId: string | null;
  model: AtmosphereModel | null;
  altitudeKm: number;
  rhoKgM3: number;
  pressurePa: number;
  /** atmosphereTopWeight at this altitude (0 in vacuum). */
  topWeight: number;
  /** Co-rotating air velocity at the point, m/s, in the game (system) axes. */
  airVelX: number;
  airVelY: number;
  airVelZ: number;
};

export function createAmbient(): Ambient {
  return { bodyId: null, model: null, altitudeKm: 0, rhoKgM3: 0, pressurePa: 0, topWeight: 0, airVelX: 0, airVelY: 0, airVelZ: 0 };
}

const _orient = createBodyOrientation();

function vacuum(out: Ambient): Ambient {
  out.bodyId = null;
  out.model = null;
  out.altitudeKm = 0;
  out.rhoKgM3 = 0;
  out.pressurePa = 0;
  out.topWeight = 0;
  out.airVelX = 0; out.airVelY = 0; out.airVelZ = 0;
  return out;
}

/** Signed sidereal spin rate, rad/s (negative = retrograde, Venus/Uranus). */
function spinRadPerSec(body: CelestialBodyDef): number {
  const rot = body.rotation;
  if (!rot) return 0;
  const degPerDay = rot.spinDegPerDay ?? (rot.periodHours ? 360 / (rot.periodHours / 24) : 0);
  return (degPerDay * D2R) / 86400;
}

/**
 * The air at absolute system-frame km (x, y, z). Picks the nearest body whose
 * atmosphere top contains the point — never an airless body (the old
 * nearest-registered pick chose the Moon over Earth). Allocation-free.
 *
 * Air velocity is rigid co-rotation ω × r with ω = pole·rate from
 * `bodyOrientation` (whose meridian obeys dm/dW = pole × m, so this sign is
 * the rendered surface's), faded to zero over the top 10 % of the atmosphere.
 */
export function ambientAt(x: number, y: number, z: number, out: Ambient): Ambient {
  ensure();
  let best: (typeof _withAir)[number] | null = null;
  let bestAlt = Infinity;
  let rx = 0, ry = 0, rz = 0;
  for (const e of _withAir) {
    const p = e.body.positionKm;
    if (!p) continue;
    const dx = x - p[0], dy = y - p[1], dz = z - p[2];
    const alt = Math.sqrt(dx * dx + dy * dy + dz * dz) - e.model.radiusKm;
    if (alt < e.model.topKm && alt < bestAlt) {
      best = e;
      bestAlt = alt;
      rx = dx; ry = dy; rz = dz;
    }
  }
  if (!best) return vacuum(out);
  const m = best.model;
  out.bodyId = m.bodyId;
  out.model = m;
  out.altitudeKm = bestAlt;
  out.rhoKgM3 = densityAtAltitude(m, bestAlt);
  out.pressurePa = pressureAtAltitude(m, bestAlt);
  out.topWeight = atmosphereTopWeight(m, bestAlt);

  const w = spinRadPerSec(best.body) * out.topWeight;
  if (w === 0) {
    out.airVelX = 0; out.airVelY = 0; out.airVelZ = 0;
    return out;
  }
  const pole = bodyOrientation(best.body, solvedEphemerisJD(), _orient).pole;
  // ω × r, r in km → m/s.
  const k = w * 1000;
  out.airVelX = k * (pole[1] * rz - pole[2] * ry);
  out.airVelY = k * (pole[2] * rx - pole[0] * rz);
  out.airVelZ = k * (pole[0] * ry - pole[1] * rx);
  return out;
}

/** |v_ship − v_air|, m/s. `vel*` in m/s, same axes. */
export function airspeedMps(a: Ambient, velX: number, velY: number, velZ: number): number {
  if (!a.bodyId) return Math.sqrt(velX * velX + velY * velY + velZ * velZ);
  const dx = velX - a.airVelX, dy = velY - a.airVelY, dz = velZ - a.airVelZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
