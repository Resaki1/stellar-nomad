/**
 * Ship-resource tuning (docs/M3_GAMEPLAY_PLAN.md §5, §13.3). Defaults plus a live copy the dev
 * panel edits. Units: kg, s, kW, kJ; heat is an effective store, `heatCapacityKJ` = 100 %.
 */
import { MAX_HEAT_FRACTION, PROPELLANT_TANK_KG, RECOVERY_ALLOWANCE_KG } from "./shipResources";
import { applyDifficulty, difficultyMults, difficultyVersion } from "@/sim/difficulty";

export interface ResourceTuning {
  tankKg: number;
  recoveryAllowanceKg: number;
  /** Linear in delivered Δv (body axes, L1), not a rocket-equation claim. */
  propellantKgPerMps: number;
  /** Per rad/s of commanded angular-velocity change (L1 over body axes). */
  rotationKgPerRadps: number;
  /** A fixed step delivering less than this |Δv| is controller chatter: not charged. */
  thrustDeadbandMps: number;
  /** Angular authority left at zero propellant (attitude wheels; free). */
  exhaustedAngularScale: number;

  reactorKW: number;
  /** Control + sensing; always served first. */
  essentialKW: number;
  /** Capacitor refill draw; never throttled, so boost feel is unchanged. */
  capacitorChargeKW: number;
  miningKW: number;
  processingKW: number;
  repairKW: number;

  heatCapacityKJ: number;
  miningHeatKW: number;
  boostHeatKW: number;
  processingHeatKW: number;
  repairHeatKW: number;
  /** Rejection = base + perHeat × heat01: idle cools 100 → 0 % in 10 s, mining alone heats 0 → 100 % in 15 s. */
  radiatorBaseKW: number;
  radiatorPerHeatKW: number;
  heatWarn01: number;
  /** Processing and repair throttle linearly from here to 100 %; the mining laser trips at 100 %. */
  heatThrottle01: number;
  heatMax01: number;
  /** Above 100 % for longer than this, the hull takes damage. */
  heatDamageGraceS: number;
  /** Fraction of max hull per second while over 100 % after the grace. */
  heatDamagePerS: number;

  processingKgPerUnit: number;
  processingKgPerS: number;
  processingMaxBatchUnits: number;

  /** Transit: kg per km/s of delivered drive speed change (accelerate and brake). */
  transitKgPerKmps: number;
  /**
   * Transit: kg per km covered while the drive carries speed. The distance floor of a trip: an
   * Earth -> Moon route needs more than the base tank holds whatever the speed. Not scaled by
   * difficulty (a progression gate, not a rate).
   */
  transitKgPerKm: number;
  /** Braking fuel kept beyond the exact stop, fraction. */
  transitReserveMargin: number;
  transitSpoolHeatKW: number;
  /** Heat input at full drive acceleration or braking. */
  transitBurnHeatKW: number;
  /** A trip predicted longer than this is refused (too little fuel), s. */
  transitMaxTripS: number;

  /** Fraction of max hull per second while repairing. */
  repairPerS: number;
  /** fe_ni_metal units per 1 % of max hull. */
  repairUnitsPerPct: number;

  // ── Variable-Isp drive in atmosphere (docs/VFX_REALISM_PLAN.md §5.6.5) ──
  /** Density at/below which the torch runs at full v_e, kg/m³. */
  atmoHandoffRhoKgM3: number;
  /** Density above which v_e stops falling (the 4 km/s floor at 20 t), kg/m³. */
  atmoFloorRhoKgM3: number;
  /** v_e/v_vac = (ρ_hand/ρ)^exponent; ½ is a game choice (power ∝ 1/√ρ). */
  atmoPowerExponent: number;
  /** Static intake capture, m³/s. */
  atmoIntakeM3PerS: number;
  /** Ram capture area, m² (× airspeed). */
  atmoIntakeAreaM2: number;
  /** Fuel multiplier while air covers the need (1 = vacuum price). */
  atmoBreathingFuelMult: number;
  /** Soft cap of the water multiplier; the rest of the shortfall becomes overdrive heat. */
  atmoFuelMultMax: number;
  /** Heat at full thrust and 4× overdrive, kW. */
  atmoOverdriveHeatKW: number;
  /** Fraction of the atmosphere's height over which the drive fades to vacuum. */
  atmoTopFadeFrac: number;
  /** Reference ship mass for v_e / plume regimes, kg (the fuel model itself is mass-free). */
  driveRefMassKg: number;
}

export const DEFAULT_RESOURCE_TUNING: Readonly<ResourceTuning> = Object.freeze({
  tankKg: PROPELLANT_TANK_KG,
  recoveryAllowanceKg: RECOVERY_ALLOWANCE_KG,
  propellantKgPerMps: 0.008,
  atmoHandoffRhoKgM3: 3.1e-6,
  atmoFloorRhoKgM3: 1.225,
  atmoPowerExponent: 0.5,
  atmoIntakeM3PerS: 700,
  atmoIntakeAreaM2: 3.5,
  atmoBreathingFuelMult: 1,
  atmoFuelMultMax: 10,
  atmoOverdriveHeatKW: 150,
  atmoTopFadeFrac: 0.15,
  driveRefMassKg: 20000,
  rotationKgPerRadps: 0.02,
  thrustDeadbandMps: 0.001,
  exhaustedAngularScale: 0.25,

  reactorKW: 100,
  essentialKW: 20,
  capacitorChargeKW: 10,
  miningKW: 50,
  processingKW: 45,
  repairKW: 15,

  heatCapacityKJ: 1000,
  miningHeatKW: 171.9,
  boostHeatKW: 144.9,
  processingHeatKW: 97.1,
  repairHeatKW: 10,
  radiatorBaseKW: 77.1,
  radiatorPerHeatKW: 50,
  heatWarn01: 0.8,
  heatThrottle01: 0.9,
  heatMax01: MAX_HEAT_FRACTION,
  heatDamageGraceS: 2,
  heatDamagePerS: 0.02,

  processingKgPerUnit: 20,
  processingKgPerS: 10,
  processingMaxBatchUnits: 50,

  transitKgPerKmps: 0.003,
  transitKgPerKm: 0.0019,
  transitReserveMargin: 0.02,
  transitSpoolHeatKW: 120,
  transitBurnHeatKW: 95,
  transitMaxTripS: 600,

  repairPerS: 0.02,
  repairUnitsPerPct: 1,
});

const live: ResourceTuning = { ...DEFAULT_RESOURCE_TUNING };
let liveVersion = 0;

/** The live (dev-editable) table, before difficulty. Gameplay reads `getEffectiveTuning`. */
export function getResourceTuning(): Readonly<ResourceTuning> {
  return live;
}

const effective: ResourceTuning = { ...DEFAULT_RESOURCE_TUNING };
let effectiveLive = -1;
let effectiveDiff = -1;

/** The live table with the active world's difficulty applied (refreshed on change, no per-call allocation). */
export function getEffectiveTuning(): Readonly<ResourceTuning> {
  if (effectiveLive !== liveVersion || effectiveDiff !== difficultyVersion()) {
    applyDifficulty(live, difficultyMults(), effective);
    effectiveLive = liveVersion;
    effectiveDiff = difficultyVersion();
  }
  return effective;
}

const POSITIVE: ReadonlySet<keyof ResourceTuning> = new Set<keyof ResourceTuning>([
  "tankKg", "heatCapacityKJ", "atmoHandoffRhoKgM3", "atmoFloorRhoKgM3", "atmoBreathingFuelMult", "atmoFuelMultMax", "driveRefMassKg", "processingKgPerUnit", "processingKgPerS", "heatMax01", "transitMaxTripS",
]);
const UNIT_RANGE: ReadonlySet<keyof ResourceTuning> = new Set<keyof ResourceTuning>(["atmoTopFadeFrac", "exhaustedAngularScale", "heatWarn01", "heatThrottle01"]);
const INTEGER: ReadonlySet<keyof ResourceTuning> = new Set<keyof ResourceTuning>(["processingMaxBatchUnits", "repairUnitsPerPct"]);

/** Patch the live table; non-finite values and unknown keys are ignored, values clamped to range. */
export function setResourceTuning(patch: Partial<ResourceTuning>): void {
  for (const key of Object.keys(patch) as (keyof ResourceTuning)[]) {
    const v = patch[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_RESOURCE_TUNING, key)) continue;
    let x = Math.max(POSITIVE.has(key) ? 1e-3 : 0, v);
    if (UNIT_RANGE.has(key)) x = Math.min(1, x);
    if (INTEGER.has(key)) x = Math.max(1, Math.round(x));
    live[key] = x;
  }
  // Throttle ramp divides by (1 − heatThrottle01); keep it non-degenerate.
  if (live.heatThrottle01 > 0.999) live.heatThrottle01 = 0.999;
  if (live.heatMax01 < 1) live.heatMax01 = 1;
  liveVersion++;
}

export function resetResourceTuning(): void {
  Object.assign(live, DEFAULT_RESOURCE_TUNING);
  liveVersion++;
}
