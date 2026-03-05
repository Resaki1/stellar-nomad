import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
  computedModifiersAtom,
  getMultiplier,
  getAddition,
  type ComputedModifiers,
} from "@/store/modules";

// ---------------------------------------------------------------------------
// Ship configuration — central place for all upgradable stats.
//
// Every value starts at the un-upgraded default. Module modifiers from the
// loadout system are folded in via `effectiveShipConfigAtom`.
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
  /** Extra cargo capacity from modules (added on top of base). */
  bonusCargoCapacity: number;
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
};

export const shipConfigAtom = atomWithStorage<ShipConfig>(
  "ship-config-v1",
  DEFAULT_SHIP_CONFIG
);

// ---------------------------------------------------------------------------
// Effective config: base values * equipped module modifiers
// ---------------------------------------------------------------------------

function applyModifiers(base: ShipConfig, mods: ComputedModifiers): ShipConfig {
  return {
    // Mining: timePerAsteroidMultiplier < 1 means faster mining → invert for speedMult
    miningSpeedMult:
      base.miningSpeedMult / getMultiplier(mods, "mining.timePerAsteroidMultiplier"),
    miningEfficiencyMult: base.miningEfficiencyMult,
    miningHeatCapacityS:
      base.miningHeatCapacityS / getMultiplier(mods, "mining.heatBuildUpRateMultiplier"),
    miningCooldownS: base.miningCooldownS,

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
  };
}

/**
 * Derived atom that combines base ship config with equipped module effects.
 * Consumers should prefer this over raw `shipConfigAtom`.
 */
export const effectiveShipConfigAtom = atom((get): ShipConfig => {
  const base = get(shipConfigAtom);
  const mods = get(computedModifiersAtom);
  return applyModifiers(base, mods);
});

// ---------------------------------------------------------------------------
// Convenience selectors (now from effective config)
// ---------------------------------------------------------------------------

export const miningSpeedMultAtom = atom((get) => get(effectiveShipConfigAtom).miningSpeedMult);
export const miningEfficiencyMultAtom = atom((get) => get(effectiveShipConfigAtom).miningEfficiencyMult);
export const miningHeatCapacitySAtom = atom((get) => get(effectiveShipConfigAtom).miningHeatCapacityS);
export const miningCooldownSAtom = atom((get) => get(effectiveShipConfigAtom).miningCooldownS);
