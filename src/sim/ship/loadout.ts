/**
 * The one effective-ship-config fold (equipped modules + timed effects; M3.3 research grants
 * blueprints, never passive bonuses). Pure so the authority, the resource step and the HUD
 * use the same numbers; `equipTuning` carries the config into the resource table.
 */
import { getItemDef, type ItemEffect } from "@/data/content";
import type { ModulesState, PlayerState, ShipConfig } from "@/save/types";
import type { ResourceTuning } from "./resourceTuning";

export type ComputedModifiers = {
  flags: Record<string, boolean>;
  /** Product of all multipliers per key. */
  multipliers: Record<string, number>;
  /** Sum of all additions per key. */
  additions: Record<string, number>;
};

export function aggregateEffects(effects: readonly ItemEffect[]): ComputedModifiers {
  const flags: Record<string, boolean> = {};
  const multipliers: Record<string, number> = {};
  const additions: Record<string, number> = {};
  for (const eff of effects) {
    if (eff.op === "set") flags[eff.key] = eff.value as boolean;
    else if (eff.op === "multiply") multipliers[eff.key] = (multipliers[eff.key] ?? 1) * (eff.value as number);
    else if (eff.op === "add") additions[eff.key] = (additions[eff.key] ?? 0) + (eff.value as number);
  }
  return { flags, multipliers, additions };
}

export function mergeModifiers(a: ComputedModifiers, b: ComputedModifiers): ComputedModifiers {
  const flags = { ...a.flags, ...b.flags };
  const multipliers = { ...a.multipliers };
  const additions = { ...a.additions };
  for (const [key, val] of Object.entries(b.multipliers)) multipliers[key] = (multipliers[key] ?? 1) * val;
  for (const [key, val] of Object.entries(b.additions)) additions[key] = (additions[key] ?? 0) + val;
  return { flags, multipliers, additions };
}

export const getFlag = (mods: ComputedModifiers, key: string): boolean => mods.flags[key] ?? false;
export const getMultiplier = (mods: ComputedModifiers, key: string): number => mods.multipliers[key] ?? 1;
export const getAddition = (mods: ComputedModifiers, key: string): number => mods.additions[key] ?? 0;

/** Effects of EQUIPPED modules only. */
export function moduleModifiers(modules: ModulesState): ComputedModifiers {
  const all: ItemEffect[] = [];
  for (const itemId of Object.values(modules.equippedModules)) {
    const def = itemId ? getItemDef(itemId) : undefined;
    if (def?.effects) all.push(...def.effects);
  }
  return aggregateEffects(all);
}

export function applyModifiers(base: ShipConfig, mods: ComputedModifiers): ShipConfig {
  const overallMult = getMultiplier(mods, "mining.overallEfficiencyMultiplier");
  return {
    // timePerAsteroidMultiplier < 1 means faster mining, hence the division.
    miningSpeedMult: (base.miningSpeedMult / getMultiplier(mods, "mining.timePerAsteroidMultiplier")) * overallMult,
    miningEfficiencyMult: base.miningEfficiencyMult * getMultiplier(mods, "mining.yieldMultiplier") * overallMult,
    miningHeatCapacityS: base.miningHeatCapacityS / getMultiplier(mods, "mining.heatBuildUpRateMultiplier"),
    miningCooldownS: base.miningCooldownS / getMultiplier(mods, "mining.cooldownSpeedMultiplier"),
    maxHealth: base.maxHealth * getMultiplier(mods, "ship.maxHealthMultiplier"),
    speedMult: base.speedMult * getMultiplier(mods, "ship.maxSpeedMultiplier"),
    accelerationMult: base.accelerationMult * getMultiplier(mods, "ship.accelerationMultiplier"),
    decelerationMult: base.decelerationMult * getMultiplier(mods, "ship.decelerationMultiplier"),
    collisionDamageMult: base.collisionDamageMult * getMultiplier(mods, "ship.collisionDamageMultiplier"),
    bonusCargoCapacity: base.bonusCargoCapacity + getAddition(mods, "ship.cargoCapacity"),
    scannerLockSpeedMult: base.scannerLockSpeedMult * getMultiplier(mods, "scanner.lockSpeedMultiplier"),
    scannerRangeMult: base.scannerRangeMult * getMultiplier(mods, "scanner.allRangeMultiplier"),
    hullRegenPerSecond: base.hullRegenPerSecond + getAddition(mods, "ship.hullRegenPerSecond"),
    scannerInspectTimeMult: base.scannerInspectTimeMult * getMultiplier(mods, "scanner.inspectTimeMultiplier"),
    scannerInspectRangeMult: base.scannerInspectRangeMult * getMultiplier(mods, "scanner.inspectRangeMultiplier"),
    tankBonusKg: base.tankBonusKg + getAddition(mods, "ship.tankKg"),
    reactorBonusKW: base.reactorBonusKW + getAddition(mods, "ship.reactorKW"),
    miningPowerMult: base.miningPowerMult * getMultiplier(mods, "mining.powerMultiplier"),
    processingRateMult: base.processingRateMult * getMultiplier(mods, "processing.rateMultiplier"),
    heatCapacityMult: base.heatCapacityMult * getMultiplier(mods, "ship.heatCapacityMultiplier"),
  };
}

/**
 * Effective config without timed consumable effects (none of which change capacity or max hull).
 * `_completed` is kept for the call sites: unlocked research adds blueprints, not stats.
 */
export function persistentShipConfig(player: PlayerState, _completed?: ReadonlySet<string>): ShipConfig {
  return applyModifiers(player.shipConfig, moduleModifiers(player.modules));
}

/**
 * The resource table with equipment applied, written into `out` (no allocation). Processing
 * power and heat scale with its rate, so a faster cell costs what it delivers.
 */
export function equipTuning(base: Readonly<ResourceTuning>, cfg: Readonly<ShipConfig>, out: ResourceTuning): ResourceTuning {
  Object.assign(out, base);
  out.tankKg = Math.max(1, base.tankKg + cfg.tankBonusKg);
  out.reactorKW = Math.max(base.essentialKW, base.reactorKW + cfg.reactorBonusKW);
  out.miningKW = base.miningKW * cfg.miningPowerMult;
  out.processingKgPerS = base.processingKgPerS * cfg.processingRateMult;
  out.processingKW = base.processingKW * cfg.processingRateMult;
  out.processingHeatKW = base.processingHeatKW * cfg.processingRateMult;
  out.heatCapacityKJ = base.heatCapacityKJ * cfg.heatCapacityMult;
  return out;
}

/** Request multipliers the resource step takes from the config (M3.2's pre-M3 laser law). */
export const miningHeatMultOf = (cfg: Readonly<ShipConfig>): number => (cfg.miningHeatCapacityS > 0 ? 15 / cfg.miningHeatCapacityS : 1);
export const coolingMultOf = (cfg: Readonly<ShipConfig>): number => (cfg.miningCooldownS > 0 ? 10 / cfg.miningCooldownS : 1);

export function cargoUsedUnits(items: Readonly<Record<string, number>>): number {
  let used = 0;
  for (const k in items) {
    const v = items[k];
    if (Number.isFinite(v)) used += Math.max(0, Math.floor(v));
  }
  return used;
}
