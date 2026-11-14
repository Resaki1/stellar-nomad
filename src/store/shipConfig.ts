import { atom } from "jotai";
import { savedAtom } from "@/store/savedAtom";
import { defaultShipConfig } from "@/save/defaults";
import type { ShipConfig } from "@/save/types";
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

// Base ship stats (un-upgraded defaults in save/defaults.ts). Module, research and timed
// modifiers are folded in by `effectiveShipConfigAtom`.
export type { ShipConfig } from "@/save/types";

export const shipConfigAtom = savedAtom("player", "shipConfig", defaultShipConfig());

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
