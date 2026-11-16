/**
 * The one effective-ship-config fold (equipped modules + completed research + timed effects).
 * Pure so the world authority validates capacity and hull with the same numbers the HUD shows.
 */
import { RESEARCH_NODES, getItemDef, type ItemEffect } from "@/data/content";
import type { ModulesState, PlayerState, ShipConfig } from "@/save/types";

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

/** Passive bonuses of completed (world-shared) research. Unknown ids contribute nothing. */
export function researchModifiers(completed: ReadonlySet<string>): ComputedModifiers {
  const all: ItemEffect[] = [];
  for (const node of RESEARCH_NODES) if (completed.has(node.id) && node.researchEffects) all.push(...node.researchEffects);
  return aggregateEffects(all);
}

export function unlockedItemIds(completed: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const node of RESEARCH_NODES) {
    if (!completed.has(node.id)) continue;
    for (const id of node.unlocks.items ?? []) out.add(id);
  }
  return out;
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
    assaySampleBonusChance: Math.min(1, base.assaySampleBonusChance + getAddition(mods, "mining.assaySampleBonusChance")),
    hullRegenPerSecond: base.hullRegenPerSecond + getAddition(mods, "ship.hullRegenPerSecond"),
  };
}

/** Effective config without timed consumable effects (none of which change capacity or max hull). */
export function persistentShipConfig(player: PlayerState, completed: ReadonlySet<string>): ShipConfig {
  return applyModifiers(player.shipConfig, mergeModifiers(moduleModifiers(player.modules), researchModifiers(completed)));
}

export function cargoUsedUnits(items: Readonly<Record<string, number>>): number {
  let used = 0;
  for (const k in items) {
    const v = items[k];
    if (Number.isFinite(v)) used += Math.max(0, Math.floor(v));
  }
  return used;
}
