/**
 * Per-world difficulty (M3.7): simple multipliers on rates, never on stored quantities, so
 * switching or migrating a world changes no fuel, cargo or hull already held. Death and
 * recovery follow the same model on every setting. Values are tuning defaults (plan §13.7).
 */
import type { Difficulty } from "@/save/types";
import type { ResourceTuning } from "@/sim/ship/resourceTuning";

export interface DifficultyMultipliers {
  /** Manoeuvring and transit propellant per Δv. */
  fuelUse: number;
  /** Heat input of mining, boost, processing, repair and transit. */
  heat: number;
  /** Collision damage. */
  collisionDamage: number;
  /** Protected recovery allowance. */
  allowance: number;
  /** Mining yield. */
  yield: number;
}

export const DIFFICULTY_TABLE: Readonly<Record<Difficulty, Readonly<DifficultyMultipliers>>> = Object.freeze({
  explorer: Object.freeze({ fuelUse: 0.75, heat: 0.85, collisionDamage: 0.5, allowance: 1.5, yield: 1.25 }),
  standard: Object.freeze({ fuelUse: 1, heat: 1, collisionDamage: 1, allowance: 1, yield: 1 }),
  hard: Object.freeze({ fuelUse: 1.25, heat: 1.15, collisionDamage: 1.5, allowance: 0.75, yield: 1 }),
});

export const DIFFICULTY_LABELS: Readonly<Record<Difficulty, string>> = { explorer: "Explorer", standard: "Standard", hard: "Hard" };

let current: Difficulty = "standard";
let version = 0;

/** Set by the save layer when a world becomes active (and by test harnesses). */
export function setDifficulty(d: Difficulty): void {
  if (d === current) return;
  current = d;
  version++;
}

export const getDifficulty = (): Difficulty => current;
export const difficultyMults = (): Readonly<DifficultyMultipliers> => DIFFICULTY_TABLE[current];
/** Bumps on every change, so cached tables can refresh. */
export const difficultyVersion = (): number => version;

/** `base` with the difficulty's rate multipliers applied, into `out` (no allocation). */
export function applyDifficulty(base: Readonly<ResourceTuning>, m: Readonly<DifficultyMultipliers>, out: ResourceTuning): ResourceTuning {
  if (out !== base) Object.assign(out, base);
  out.propellantKgPerMps = base.propellantKgPerMps * m.fuelUse;
  out.rotationKgPerRadps = base.rotationKgPerRadps * m.fuelUse;
  out.transitKgPerKmps = base.transitKgPerKmps * m.fuelUse;
  out.miningHeatKW = base.miningHeatKW * m.heat;
  out.boostHeatKW = base.boostHeatKW * m.heat;
  out.processingHeatKW = base.processingHeatKW * m.heat;
  out.repairHeatKW = base.repairHeatKW * m.heat;
  out.transitSpoolHeatKW = base.transitSpoolHeatKW * m.heat;
  out.transitBurnHeatKW = base.transitBurnHeatKW * m.heat;
  out.recoveryAllowanceKg = base.recoveryAllowanceKg * m.allowance;
  return out;
}
