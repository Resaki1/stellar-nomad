// ---------------------------------------------------------------------------
// VARIABLE-ISP DRIVE IN ATMOSPHERE — docs/VFX_REALISM_PLAN.md §5.6.
//
// Thrust (acceleration) is held fixed; in air the drive adds reaction mass and
// lowers v_e. Reaction mass is ingested air first (a fusion-heated ram/turbojet),
// then water from the tank under a soft cap; anything still missing is
// "overdrive" (v_e above the safe curve), billed as hull heat. Vacuum returns
// fuelMult exactly 1, so every vacuum path stays bit-identical.
// ---------------------------------------------------------------------------

import type { AtmosphereModel } from "@/sim/atmosphere";
import { densityAtAltitude, pressureAtAltitude } from "@/sim/atmosphere";
import type { ResourceTuning } from "./resourceTuning";

export type AtmoFuel = {
  /** Water multiplier on vacuum propellant per m/s (≥ 1 in air, exactly 1 in vacuum). */
  fuelMult: number;
  /** v_e / v_vac. */
  powerFrac: number;
  /** Exhaust velocity at `driveRefMassKg`, km/s. */
  veKmps: number;
  /** Fraction of the reaction mass that is ingested air, 0..1. */
  airFrac: number;
  /** need / delivered (≥ 1); > 1 means the drive is running hot. */
  overdrive: number;
  /** Overdrive heat at this step's thrust, kW. */
  heatKW: number;
  /** Fade-weighted ambient density and pressure the drive sees. */
  rhoEffKgM3: number;
  pressurePa: number;
};

export function createAtmoFuel(): AtmoFuel {
  return { fuelMult: 1, powerFrac: 1, veKmps: 0, airFrac: 0, overdrive: 1, heatKW: 0, rhoEffKgM3: 0, pressurePa: 0 };
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Density the drive responds to: ρ faded to zero over the top `atmoTopFadeFrac` of the atmosphere. */
export function driveRhoEff(m: AtmosphereModel, altitudeKm: number, t: Readonly<ResourceTuning>): number {
  const fade = 1 - smoothstep((1 - t.atmoTopFadeFrac) * m.topKm, m.topKm, altitudeKm);
  return fade > 0 ? densityAtAltitude(m, altitudeKm) * fade : 0;
}

/** v_e/v_vac = min(1, (ρ_hand / min(ρ, ρ_floor))^exponent). */
export function drivePowerFrac(rhoEff: number, t: Readonly<ResourceTuning>): number {
  if (!(rhoEff > t.atmoHandoffRhoKgM3)) return 1;
  return Math.min(1, Math.pow(t.atmoHandoffRhoKgM3 / Math.min(rhoEff, t.atmoFloorRhoKgM3), t.atmoPowerExponent));
}

/**
 * Drive state for one step delivering `accelMps2` (the commanded thrust this step) for `dt`.
 * `refAccelMps2` is full main thrust, for the heat's thrust fraction.
 * `m` null (vacuum) → fuelMult 1, no heat.
 */
export function atmoFuel(
  m: AtmosphereModel | null,
  altitudeKm: number,
  airspeedMps: number,
  accelMps2: number,
  dt: number,
  t: Readonly<ResourceTuning>,
  out: AtmoFuel,
  refAccelMps2 = 120,
): AtmoFuel {
  const vVacKmps = t.driveRefMassKg / Math.max(1e-9, t.propellantKgPerMps) / 1000;
  const rho = m ? driveRhoEff(m, altitudeKm, t) : 0;
  const f = drivePowerFrac(rho, t);
  out.rhoEffKgM3 = rho;
  out.pressurePa = m && rho > 0 ? pressureAtAltitude(m, altitudeKm) * (rho / Math.max(1e-30, densityAtAltitude(m, altitudeKm))) : 0;
  out.powerFrac = f;
  out.veKmps = vVacKmps * f;
  if (f >= 1 || !(accelMps2 > 0) || !(dt > 0)) {
    out.fuelMult = 1;
    out.airFrac = 0;
    out.overdrive = 1;
    out.heatKW = 0;
    return out;
  }
  const dvMps = accelMps2 * dt;
  const k = t.propellantKgPerMps;
  // Mass-free fuel model: dv·k IS the reference-mass flow ṁ_vac·dt (v_vac = m_ref/k), so
  // the need and the air capture are both plain kg at the 20 t reference.
  const needKg = (dvMps * k) / f;
  const airKg = rho * Math.max(t.atmoIntakeM3PerS, t.atmoIntakeAreaM2 * airspeedMps) * dt;
  const base = dvMps * k;
  const mh = Math.max(0, needKg - airKg) / base;
  const floor = t.atmoBreathingFuelMult;
  const cap = Math.max(floor, t.atmoFuelMultMax);
  const M = mh <= floor || cap <= floor ? floor : floor + (cap - floor) * (1 - Math.exp(-(mh - floor) / (cap - floor)));
  const waterKg = M * base;
  const usedAir = Math.min(airKg, needKg);
  const over = needKg / Math.max(1e-30, usedAir + waterKg);
  out.fuelMult = M;
  out.airFrac = usedAir / Math.max(1e-30, usedAir + waterKg);
  out.overdrive = Math.max(1, over);
  const theta = Math.min(1, accelMps2 / Math.max(1e-6, refAccelMps2));
  out.heatKW = t.atmoOverdriveHeatKW * theta * Math.min(1, Math.max(0, Math.log2(out.overdrive) / 2));
  return out;
}

// ---------------------------------------------------------------------------
// Plume regime (VFX plan §5.6.7) — the renderer smooths these, the sim doesn't.
// 20 t reference ship, two 0.455 m nozzles (A_e 1.30 m²), M_e 3, γ 1.4.
// ---------------------------------------------------------------------------

const REF_ACCEL_MPS2 = 120;
const EXIT_AREA_M2 = 1.3;
const EXIT_MACH = 3;
/** p₀/p_e at M_e 3, γ 1.4 = (1 + 0.2·9)^3.5. p₀ is ±40 % (plan §5.6.7); p_e is not. */
const P0_OVER_PE = 36.7;
const THROAT_RADIUS_M = 0.19;
const EXIT_DIAMETER_M = 0.91;
/** Fully expanded jet Mach for the shock-cell length (Prandtl–Pack). */
const JET_MACH = 3.27;
/** Stopping column of the rarefied beam, kg/m² (order of magnitude, §5.4). */
const STOPPING_COLUMN_KGM2 = 8e-4;

export type DrivePlume = {
  powerFrac: number;
  veKmps: number;
  rhoAmb: number;
  pAmbPa: number;
  /** Nozzle exit pressure over ambient (Infinity in vacuum). */
  peOverPa: number;
  /** Ashkenas–Sherman Mach-disk distance, m. */
  machDiskM: number;
  /** Shock-cell (diamond) spacing, m. */
  cellLenM: number;
  /** Fully expanded jet diameter, m. */
  jetDiaM: number;
  /** Rarefied-beam stopping length Σ/ρ, m (Infinity in vacuum). */
  stopLenM: number;
  /** 1 = vacuum torch, 0 = gas-dynamic jet. */
  torch01: number;
  /** 1 = collisionless (ion mfp > plume). */
  rarefied01: number;
  /** 1 = fully ionised (from v_e). */
  plasma01: number;
  /** 1 = jet crushed by ambient (p_e ≪ p_a, Venus). */
  crushed01: number;
  gas: AtmosphereModel["dominantGas"] | null;
};

export function createDrivePlume(): DrivePlume {
  return { powerFrac: 1, veKmps: 0, rhoAmb: 0, pAmbPa: 0, peOverPa: Infinity, machDiskM: 0, cellLenM: 0, jetDiaM: EXIT_DIAMETER_M, stopLenM: Infinity, torch01: 1, rarefied01: 0, plasma01: 1, crushed01: 0, gas: null };
}

/** Plume regime at `throttle` (0..1) in the air at `altitudeKm` of `m` (null = vacuum). */
export function drivePlume(m: AtmosphereModel | null, altitudeKm: number, throttle: number, t: Readonly<ResourceTuning>, out: DrivePlume): DrivePlume {
  const rho = m ? driveRhoEff(m, altitudeKm, t) : 0;
  const f = drivePowerFrac(rho, t);
  out.powerFrac = f;
  out.veKmps = (t.driveRefMassKg / Math.max(1e-9, t.propellantKgPerMps) / 1000) * f;
  out.rhoAmb = rho;
  out.gas = m && rho > 0 ? m.dominantGas : null;
  const pa = m && rho > 0 ? pressureAtAltitude(m, altitudeKm) * (rho / densityAtAltitude(m, altitudeKm)) : 0;
  out.pAmbPa = pa;
  const th = Math.max(0.02, throttle);
  const pe = (t.driveRefMassKg * REF_ACCEL_MPS2 * th) / (1.4 * EXIT_MACH * EXIT_MACH * EXIT_AREA_M2);
  const ratio = pa > 0 ? pe / pa : Infinity;
  out.peOverPa = ratio;
  out.machDiskM = pa > 0 ? 1.34 * THROAT_RADIUS_M * Math.sqrt((P0_OVER_PE * pe) / pa) : Infinity;
  out.jetDiaM = EXIT_DIAMETER_M * Math.sqrt(Math.min(1e4, Math.max(0.05, ratio)));
  out.cellLenM = 1.306 * out.jetDiaM * Math.sqrt(JET_MACH * JET_MACH - 1);
  out.stopLenM = rho > 0 ? STOPPING_COLUMN_KGM2 / rho : Infinity;
  out.torch01 = smoothstep(-0.7, 0, Math.log10(Math.max(1e-9, f)));
  out.rarefied01 = rho > 0 ? 1 - smoothstep(-3.6, -2.9, Math.log10(rho)) : 1;
  out.plasma01 = smoothstep(6, 30, out.veKmps);
  out.crushed01 = 1 - smoothstep(0.15, 0.6, ratio);
  return out;
}
