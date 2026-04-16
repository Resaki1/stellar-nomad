import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
  computedModifiersAtom,
  getMultiplier,
  getAddition,
  type ComputedModifiers,
  aggregateEffects,
  mergeModifiers,
} from "@/store/modules";
import { completedNodeSetAtom } from "@/store/research";
import { timedEffectModifiersAtom } from "@/store/timedEffects";
import { RESEARCH_NODES, type ItemEffect } from "@/data/content";

// ---------------------------------------------------------------------------
// Ship configuration — central place for all upgradable stats.
//
// Every value starts at the un-upgraded default. Module modifiers from the
// loadout system and research bonuses are folded in via `effectiveShipConfigAtom`.
//
// Using atomWithStorage so upgrades persist across sessions.
// ---------------------------------------------------------------------------

export type ShipConfig = {
  // ── Mining ──
  /** Multiplier on mining speed (1 = base). Higher = faster mining. */
  miningSpeedMult: number;
  /** Multiplier on mining yield (1 = base). Higher = more resources per rock. */
  miningEfficiencyMult: number;
  /** Max continuous mining time in seconds before overheat. */
  miningHeatCapacityS: number;
  /** Time in seconds for a full cooldown from 100% heat to 0%. */
  miningCooldownS: number;

  // ── Ship ──
  /** Max hull HP. */
  maxHealth: number;
  /** Top-speed multiplier (1 = base). */
  speedMult: number;
  /** Acceleration multiplier (1 = base). */
  accelerationMult: number;
  /** Deceleration multiplier (1 = base). */
  decelerationMult: number;
  /** Collision damage multiplier (1 = base). Lower = less damage. */
  collisionDamageMult: number;
  /** Extra cargo capacity from modules/research (added on top of base). */
  bonusCargoCapacity: number;

  // ── Scanner ──
  /** Target lock speed multiplier (1 = base). Lower = faster lock. */
  scannerLockSpeedMult: number;
  /** All sensor ranges multiplier (1 = base). */
  scannerRangeMult: number;

  // ── Economy ──
  /** Probability (0-1) of receiving a bonus assay sample from mining. */
  assaySampleBonusChance: number;

  // ── Survivability ──
  /** Passive hull regeneration per second. */
  hullRegenPerSecond: number;
};

const DEFAULT_SHIP_CONFIG: ShipConfig = {
  miningSpeedMult: 1,
  miningEfficiencyMult: 1,
  miningHeatCapacityS: 15,
  miningCooldownS: 10,
  maxHealth: 100,
  speedMult: 1,
  accelerationMult: 1,
  decelerationMult: 1,
  collisionDamageMult: 1,
  bonusCargoCapacity: 0,
  scannerLockSpeedMult: 1,
  scannerRangeMult: 1,
  assaySampleBonusChance: 0,
  hullRegenPerSecond: 0,
};

export const shipConfigAtom = atomWithStorage<ShipConfig>(
  "ship-config-v1",
  DEFAULT_SHIP_CONFIG
);

// ---------------------------------------------------------------------------
// Research modifiers: passive bonuses from completed research nodes
// ---------------------------------------------------------------------------

export const researchModifiersAtom = atom((get): ComputedModifiers => {
  const completed = get(completedNodeSetAtom);
  const allEffects: ItemEffect[] = [];

  for (const node of RESEARCH_NODES) {
    if (!completed.has(node.id)) continue;
    if (node.researchEffects) {
      allEffects.push(...node.researchEffects);
    }
  }

  return aggregateEffects(allEffects);
});

// ---------------------------------------------------------------------------
// Effective config: base values * equipped module modifiers * research bonuses
// ---------------------------------------------------------------------------

function applyModifiers(base: ShipConfig, mods: ComputedModifiers): ShipConfig {
  // Handle overallEfficiencyMultiplier: affects both speed and yield
  const overallMult = getMultiplier(mods, "mining.overallEfficiencyMultiplier");

  return {
    // Mining: timePerAsteroidMultiplier < 1 means faster mining → invert for speedMult
    miningSpeedMult:
      base.miningSpeedMult / getMultiplier(mods, "mining.timePerAsteroidMultiplier") * overallMult,
    miningEfficiencyMult:
      base.miningEfficiencyMult * getMultiplier(mods, "mining.yieldMultiplier") * overallMult,
    miningHeatCapacityS:
      base.miningHeatCapacityS / getMultiplier(mods, "mining.heatBuildUpRateMultiplier"),
    miningCooldownS:
      base.miningCooldownS / getMultiplier(mods, "mining.cooldownSpeedMultiplier"),

    // Ship
    maxHealth:
      base.maxHealth * getMultiplier(mods, "ship.maxHealthMultiplier"),
    speedMult:
      base.speedMult * getMultiplier(mods, "ship.maxSpeedMultiplier"),
    accelerationMult:
      base.accelerationMult * getMultiplier(mods, "ship.accelerationMultiplier"),
    decelerationMult:
      base.decelerationMult * getMultiplier(mods, "ship.decelerationMultiplier"),
    collisionDamageMult:
      base.collisionDamageMult * getMultiplier(mods, "ship.collisionDamageMultiplier"),
    bonusCargoCapacity:
      base.bonusCargoCapacity + getAddition(mods, "ship.cargoCapacity"),

    // Scanner
    scannerLockSpeedMult:
      base.scannerLockSpeedMult * getMultiplier(mods, "scanner.lockSpeedMultiplier"),
    scannerRangeMult:
      base.scannerRangeMult * getMultiplier(mods, "scanner.allRangeMultiplier"),

    // Economy
    assaySampleBonusChance:
      Math.min(1, base.assaySampleBonusChance + getAddition(mods, "mining.assaySampleBonusChance")),

    // Survivability
    hullRegenPerSecond:
      base.hullRegenPerSecond + getAddition(mods, "ship.hullRegenPerSecond"),
  };
}

/**
 * Derived atom that combines base ship config with equipped module effects,
 * research passive bonuses, AND active timed consumable effects.
 * Consumers should prefer this over raw `shipConfigAtom`.
 */
export const effectiveShipConfigAtom = atom((get): ShipConfig => {
  const base = get(shipConfigAtom);
  const moduleMods = get(computedModifiersAtom);
  const researchMods = get(researchModifiersAtom);
  const timedMods = get(timedEffectModifiersAtom);
  const combinedMods = mergeModifiers(mergeModifiers(moduleMods, researchMods), timedMods);
  return applyModifiers(base, combinedMods);
});

// ---------------------------------------------------------------------------
// Convenience selectors (now from effective config)
// ---------------------------------------------------------------------------

export const miningSpeedMultAtom = atom((get) => get(effectiveShipConfigAtom).miningSpeedMult);
export const miningEfficiencyMultAtom = atom((get) => get(effectiveShipConfigAtom).miningEfficiencyMult);
export const miningHeatCapacitySAtom = atom((get) => get(effectiveShipConfigAtom).miningHeatCapacityS);
export const miningCooldownSAtom = atom((get) => get(effectiveShipConfigAtom).miningCooldownS);
