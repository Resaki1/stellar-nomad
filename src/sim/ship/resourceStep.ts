/**
 * The one ship-resource step (docs/M3_GAMEPLAY_PLAN.md §5.1): propellant, reactor budget,
 * capacitor, heat, processing and repair progress, on the fixed 120 Hz step after `stepShip`.
 * Requests in, arbitrate, apply bounded work, meter what executed. Pure; no allocation.
 */
import type { FlightTuning } from "./flightTuning";
import type { ResourceTuning } from "./resourceTuning";
import type { ShipState } from "./shipState";
import type { AtmosphereModel } from "@/sim/atmosphere";
import { atmoFuel, createAtmoFuel, type AtmoFuel } from "./atmoDrive";
import { DEFAULT_RESOURCE_TUNING } from "./resourceTuning";
import { createThermal, stepBells, updateLoop, type ThermalState } from "./thermal";

export interface ProcessingRuntime {
  active: boolean;
  id: string;
  recipeId: string;
  inputId: string;
  /** Feedstock units reserved (already out of cargo). */
  units: number;
  elapsedS: number;
  /** Output already in the ordinary tank, kg. */
  committedKg: number;
}

/** Running totals; tests diff them, the HUD ignores them. */
export interface ResourceMeter {
  steps: number;
  thrustKg: number;
  rotationKg: number;
  transitKg: number;
  dvMps: number;
  processedKg: number;
  /** Full-rate mining-beam seconds granted (extraction progress). */
  miningWorkS: number;
  /** Repair percent points due; the caller turns them into `ship.repair` operations. */
  repairPctDue: number;
  /** Hull damage due from over-temperature, fraction of max hull. */
  heatDamage01: number;
  processingDone: number;
}

export interface ShipResourceState {
  /** Bells + coolant-loop temperatures and per-source heat (HEAT_SYSTEM_PLAN §3). Not saved: bells cool in ~1 min. */
  thermal: ThermalState;
  ordinaryKg: number;
  protectedKg: number;
  heat01: number;
  capacitor01: number;
  processing: ProcessingRuntime;
  /** Mining laser over-temperature trip; clears once the beam is off and heat < 100 %. */
  miningTripped: boolean;
  overTempS: number;
  repairAcc01: number;
  /** Sub-deadband Δv not yet charged, m/s; charged once it reaches the deadband. */
  dvCarryMps: number;
  meter: ResourceMeter;
  /** Last step, for HUD read models. */
  powerDemandKW: number;
  powerUsedKW: number;
  powerScale: number;
  heatScale: number;
  miningScale: number;
  processingScale: number;
  repairScale: number;
  tankFull: boolean;
  /** Variable-Isp drive state of the last step (transient: never saved). */
  drive: AtmoFuel;
}

export interface ResourceRequests {
  miningBeam: boolean;
  repair: boolean;
  /** Fraction of max hull per second the repair asks for. */
  repairPerS: number;
  /** Transit drive this step: delivered speed change (km/s, billed per `transitKgPerKmps`) and heat input (kW). */
  transitDvKmps: number;
  /** ...and the distance it carried the ship, km (billed per `transitKgPerKm`). */
  transitKm: number;
  transitHeatKW: number;
  /** Dev speed override: thrust scaled by the override is not charged. */
  freeFlight: boolean;
  /** A running transit leg's braking fuel (ordinary): manoeuvring spends around it. */
  reservedKg: number;
  /** Equipment: mining heat input and radiator multipliers (1 = starter). */
  miningHeatMult: number;
  coolingMult: number;
  /** Air the ship is in (VFX plan §5.6): null in vacuum, which keeps every charge bit-identical. */
  atmo: AtmosphereModel | null;
  altitudeKm: number;
  /** Speed relative to the co-rotating air, m/s (ram intake). */
  airspeedMps: number;
}

export function createResourceMeter(): ResourceMeter {
  return { steps: 0, thrustKg: 0, rotationKg: 0, transitKg: 0, dvMps: 0, processedKg: 0, miningWorkS: 0, repairPctDue: 0, heatDamage01: 0, processingDone: 0 };
}

export function createProcessingRuntime(): ProcessingRuntime {
  return { active: false, id: "", recipeId: "", inputId: "", units: 0, elapsedS: 0, committedKg: 0 };
}

export function createShipResourceState(ordinaryKg: number, protectedKg: number): ShipResourceState {
  return {
    thermal: createThermal(DEFAULT_RESOURCE_TUNING),
    drive: createAtmoFuel(),
    ordinaryKg,
    protectedKg,
    heat01: 0,
    capacitor01: 1,
    processing: createProcessingRuntime(),
    miningTripped: false,
    overTempS: 0,
    repairAcc01: 0,
    dvCarryMps: 0,
    meter: createResourceMeter(),
    powerDemandKW: 0,
    powerUsedKW: 0,
    powerScale: 1,
    heatScale: 1,
    miningScale: 0,
    processingScale: 0,
    repairScale: 0,
    tankFull: false,
  };
}

export function createResourceRequests(): ResourceRequests {
  return { miningBeam: false, repair: false, repairPerS: 0, transitDvKmps: 0, transitKm: 0, transitHeatKW: 0, freeFlight: false, reservedKg: 0, miningHeatMult: 1, coolingMult: 1, atmo: null, altitudeKm: 0, airspeedMps: 0 };
}

const EPS_KG = 1e-9;

/** Spend ordinary first, then the protected allowance. Returns kg actually spent. */
export function spendPropellant(s: ShipResourceState, kg: number): number {
  if (!(kg > 0)) return 0;
  const fromOrdinary = Math.min(kg, s.ordinaryKg);
  s.ordinaryKg -= fromOrdinary;
  const fromProtected = Math.min(kg - fromOrdinary, s.protectedKg);
  s.protectedKg -= fromProtected;
  if (s.ordinaryKg < EPS_KG) s.ordinaryKg = 0;
  if (s.protectedKg < EPS_KG) s.protectedKg = 0;
  return fromOrdinary + fromProtected;
}

/** Manoeuvring spend: ordinary above `reservedKg`, then protected, then (sub-deadband carry only) the reserve. */
function spendManoeuvre(s: ShipResourceState, kg: number, reservedKg: number): number {
  if (!(reservedKg > 0) || !(kg > 0)) return spendPropellant(s, kg);
  const fromFree = Math.min(kg, Math.max(0, s.ordinaryKg - reservedKg));
  s.ordinaryKg -= fromFree;
  const fromProtected = Math.min(kg - fromFree, s.protectedKg);
  s.protectedKg -= fromProtected;
  if (s.protectedKg < EPS_KG) s.protectedKg = 0;
  return fromFree + fromProtected + spendPropellant(s, kg - fromFree - fromProtected);
}

/** Units whose conversion has not started; the only part a cancel or death can return. */
export function unconvertedUnits(units: number, committedKg: number, kgPerUnit: number): number {
  const started = Math.ceil(committedKg / kgPerUnit - 1e-9);
  return Math.max(0, units - Math.max(0, started));
}

/** Most propellant one step can deliver (every axis at its limit, boosted, plus rotation), kg. */
export function worstStepKg(ft: Readonly<FlightTuning>, t: Readonly<ResourceTuning>, accelerationMult: number, decelerationMult: number, dt: number, fuelMult = 1): number {
  const fwd = Math.max(ft.mainThrustMps2 * ft.boostThrustMult * accelerationMult, ft.retroThrustMps2 * decelerationMult);
  const side = Math.max(ft.strafeThrustMps2 * accelerationMult, ft.gripMps2 * decelerationMult);
  const dw = 3 * ft.angularAccelDegS2 * (Math.PI / 180) * dt;
  return (fwd + 2 * side) * dt * t.propellantKgPerMps * fuelMult + dw * t.rotationKgPerRadps;
}

/**
 * Thrust gate for the coming step: 1 while the worst-case step is affordable, then the
 * affordable fraction, so the meter never charges more than the tank holds. `reservedKg`
 * (a running transit leg's braking fuel) is not available to manoeuvring.
 */
export function propellantGate(s: ShipResourceState, worstStepKg: number, t: Readonly<ResourceTuning>, out: { thrust: number; angular: number }, reservedKg = 0): void {
  const total = Math.max(0, s.ordinaryKg - reservedKg) + s.protectedKg;
  out.thrust = total <= 0 ? 0 : worstStepKg > total ? total / worstStepKg : 1;
  out.angular = total <= 0 ? t.exhaustedAngularScale : 1;
}

/** Discretionary-load throttle: 1 up to `heatThrottle01`, linear to 0 at 100 %. */
export function throttleScale(h: number, t: Readonly<ResourceTuning>): number {
  return h <= t.heatThrottle01 ? 1 : Math.max(0, (1 - h) / (1 - t.heatThrottle01));
}

/** The thermal store after one step with `qKW` input (rejection only while warm or loaded). */
export function heatAfter(h: number, qKW: number, t: Readonly<ResourceTuning>, coolingMult: number, dt: number): number {
  const rejKW = h > 0 || qKW > 0 ? (t.radiatorBaseKW + t.radiatorPerHeatKW * h) * coolingMult : 0;
  return Math.min(t.heatMax01, Math.max(0, h + ((qKW - rejKW) / t.heatCapacityKJ) * dt));
}

/** One fixed step. Call after `stepShip` with the same dt. */
export function stepShipResources(
  s: ShipResourceState,
  ship: Readonly<ShipState>,
  req: Readonly<ResourceRequests>,
  t: Readonly<ResourceTuning>,
  dt: number,
): void {
  const m = s.meter;
  m.steps++;

  // Transit first: its braking fuel is reserved, so it can always be paid (ordinary, then protected).
  if ((req.transitDvKmps > 0 || req.transitKm > 0) && !req.freeFlight) {
    m.transitKg += spendPropellant(s, req.transitDvKmps * t.transitKgPerKmps + req.transitKm * t.transitKgPerKm);
  }

  // ── Propellant: delivered control work only (coasting, contacts, frames cost nothing) ──
  if (!req.freeFlight) {
    const dvMps = (Math.abs(ship.ctlDvF) + Math.abs(ship.ctlDvR) + Math.abs(ship.ctlDvU)) * 1000 + s.dvCarryMps;
    if (dvMps >= t.thrustDeadbandMps) {
      s.dvCarryMps = 0;
      m.dvMps += dvMps;
      const mult = req.atmo ? atmoFuel(req.atmo, req.altitudeKm, req.airspeedMps, dvMps / dt, dt, t, s.drive).fuelMult : 1;
      m.thrustKg += spendManoeuvre(s, dvMps * t.propellantKgPerMps * mult, req.reservedKg);
    } else {
      s.dvCarryMps = dvMps;
    }
  }
  if (req.freeFlight || !req.atmo || s.dvCarryMps > 0) {
    // Coasting / vacuum / free flight: report the drive's state, charge and heat nothing.
    atmoFuel(req.atmo, req.altitudeKm, req.airspeedMps, 0, dt, t, s.drive);
  }
  if (!req.freeFlight) {
    if (ship.ctlDwRadps > 1e-6) m.rotationKg += spendManoeuvre(s, ship.ctlDwRadps * t.rotationKgPerRadps, req.reservedKg);
  }

  // ── Capacitor: stepShip owns the M1 boost store; refill draws reactor power ──
  const capCharging = ship.boostCharge > s.capacitor01;
  s.capacitor01 = ship.boostCharge;

  // ── Reactor budget: essential first, then capacitor, then discretionary pro rata ──
  const p = s.processing;
  const totalKg = p.units * t.processingKgPerUnit;
  const room = t.tankKg - s.ordinaryKg;
  s.tankFull = p.active && room <= EPS_KG;
  const canProcess = p.active && !s.tankFull && p.committedKg < totalKg;
  const wantRepair = req.repair && req.repairPerS > 0;
  const demand = (req.miningBeam && !s.miningTripped ? t.miningKW : 0) + (canProcess ? t.processingKW : 0) + (wantRepair ? t.repairKW : 0);
  const avail = Math.max(0, t.reactorKW - t.essentialKW - (capCharging ? t.capacitorChargeKW : 0));
  const powerScale = demand > avail ? avail / demand : 1;
  const h = s.heat01;
  const heatScale = throttleScale(h, t);
  s.miningScale = req.miningBeam && !s.miningTripped ? powerScale : 0;
  s.processingScale = canProcess ? powerScale * heatScale : 0;
  s.repairScale = wantRepair ? powerScale * heatScale : 0;
  s.powerScale = powerScale;
  s.heatScale = heatScale;
  s.powerDemandKW = t.essentialKW + (capCharging ? t.capacitorChargeKW : 0) + demand;
  s.powerUsedKW = t.essentialKW + (capCharging ? t.capacitorChargeKW : 0) + demand * powerScale;

  // ── Heat: one store; rejection = base + perHeat × heat (only while above ambient) ──
  // Module multipliers act on mining's NET rise and idle cooling only, so trip = 15 s / heatMult
  // and cool = 10 s / coolingMult as before M3; at 1/1 this is plain miningHeatKW input.
  const rej0 = t.radiatorBaseKW + t.radiatorPerHeatKW * h;
  const miningQ = Math.max(0, req.miningHeatMult * (t.miningHeatKW - rej0) + req.coolingMult * rej0);
  // Drive bells (HEAT_SYSTEM_PLAN §3): plasma load, shed mostly by glowing; the excess they
  // conduct joins the loop. Only the excess: the loop law already covers passive losses, so an
  // idle ship (bells colder than the loop) behaves exactly as before.
  const th = s.thermal;
  const bellsRaw = stepBells(th, req.freeFlight ? 0 : ship.thrustMain, s.drive.veKmps,
    s.drive.rhoEffKgM3, req.airspeedMps, req.atmo ? req.atmo.surfaceTemperatureK : 0, th.loopK, dt);
  // ⚠ Held out while the transit drive heats the loop: its predictor (transitDrive rolloutLeg) plans
  // from heat01 alone, and prediction must equal execution (review F1, 2026-11-23).
  const bellsKW = req.transitHeatKW > 0 || !Number.isFinite(bellsRaw) ? 0 : Math.max(0, bellsRaw);
  const src = th.sources;
  src.mining = miningQ * s.miningScale;
  src.boost = ship.boosting ? t.boostHeatKW : 0;
  src.processing = t.processingHeatKW * s.processingScale;
  src.repair = t.repairHeatKW * s.repairScale;
  src.transit = req.transitHeatKW;
  src.overdrive = s.drive.heatKW;
  src.bells = bellsKW;
  th.bellToLoopKW = bellsKW;
  const qKW = src.mining + src.boost + src.processing + src.repair + src.transit + src.overdrive + src.bells;
  s.heat01 = heatAfter(h, qKW, t, req.coolingMult, dt);
  updateLoop(th, s.heat01, t, dt);
  if (s.miningScale > 0 && s.heat01 >= 1) s.miningTripped = true;
  else if (s.miningTripped && !req.miningBeam && s.heat01 < 1) s.miningTripped = false;
  if (s.heat01 > 1) {
    s.overTempS += dt;
    if (s.overTempS > t.heatDamageGraceS) m.heatDamage01 += t.heatDamagePerS * dt;
  } else {
    s.overTempS = 0;
  }

  // ── Work granted this step ──
  m.miningWorkS += s.miningScale * dt;
  if (s.processingScale > 0) {
    const kg = Math.min(t.processingKgPerS * s.processingScale * dt, totalKg - p.committedKg, room);
    s.ordinaryKg += kg;
    p.committedKg += kg;
    p.elapsedS += dt;
    m.processedKg += kg;
    if (p.committedKg >= totalKg - 1e-6) {
      p.committedKg = totalKg;
      p.active = false;
      m.processingDone++;
    }
  }
  if (s.repairScale > 0) {
    s.repairAcc01 += req.repairPerS * s.repairScale * dt;
    while (s.repairAcc01 >= 0.01) {
      s.repairAcc01 -= 0.01;
      m.repairPctDue++;
    }
  }
}
