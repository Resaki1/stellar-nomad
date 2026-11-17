/**
 * Ship-resource tuning (docs/M3_GAMEPLAY_PLAN.md §5, §13.3). Defaults plus a live copy the dev
 * panel edits. Units: kg, s, kW, kJ; heat is an effective store, `heatCapacityKJ` = 100 %.
 */
import { PROPELLANT_TANK_KG, RECOVERY_ALLOWANCE_KG } from "./shipResources";
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
  /** Braking fuel kept beyond the exact stop, fraction. */
  transitReserveMargin: number;
  transitSpoolHeatKW: number;
  /** Heat input at full drive acceleration or braking. */
  transitBurnHeatKW: number;
  /** A trip predicted longer than this is refused (too little fuel), s. */
  transitMaxTripS: number;
  /** Routes stay outside this many body radii (the clearance waypoint's sphere). */
  transitRouteClearanceRadii: number;

  /** Fraction of max hull per second while repairing. */
  repairPerS: number;
  /** fe_ni_metal units per 1 % of max hull. */
  repairUnitsPerPct: number;
}

export const DEFAULT_RESOURCE_TUNING: Readonly<ResourceTuning> = Object.freeze({
  tankKg: PROPELLANT_TANK_KG,
  recoveryAllowanceKg: RECOVERY_ALLOWANCE_KG,
  propellantKgPerMps: 0.008,
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
  heatMax01: 1.3,
  heatDamageGraceS: 2,
  heatDamagePerS: 0.02,

  processingKgPerUnit: 20,
  processingKgPerS: 10,
  processingMaxBatchUnits: 50,

  transitKgPerKmps: 0.006,
  transitReserveMargin: 0.02,
  transitSpoolHeatKW: 120,
  transitBurnHeatKW: 95,
  transitMaxTripS: 600,
  transitRouteClearanceRadii: 2,

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
  "tankKg", "heatCapacityKJ", "processingKgPerUnit", "processingKgPerS", "heatMax01", "transitMaxTripS", "transitRouteClearanceRadii",
]);
const UNIT_RANGE: ReadonlySet<keyof ResourceTuning> = new Set<keyof ResourceTuning>(["exhaustedAngularScale", "heatWarn01", "heatThrottle01"]);
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
