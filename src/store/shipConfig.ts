import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

// ---------------------------------------------------------------------------
// Ship configuration — central place for all upgradable stats.
//
// Every value starts at the un-upgraded default. Future upgrade systems will
// modify these values (e.g. via a derived atom or a setter).
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

  // ── Ship (future) ──
  /** Max hull HP. */
  maxHealth: number;
  /** Top-speed multiplier (1 = base). */
  speedMult: number;
};

const DEFAULT_SHIP_CONFIG: ShipConfig = {
  miningSpeedMult: 1,
  miningEfficiencyMult: 1,
  miningHeatCapacityS: 15,
  miningCooldownS: 10,
  maxHealth: 100,
  speedMult: 1,
};

export const shipConfigAtom = atomWithStorage<ShipConfig>(
  "ship-config-v1",
  DEFAULT_SHIP_CONFIG
);

// ---------------------------------------------------------------------------
// Convenience selectors
// ---------------------------------------------------------------------------

export const miningSpeedMultAtom = atom((get) => get(shipConfigAtom).miningSpeedMult);
export const miningEfficiencyMultAtom = atom((get) => get(shipConfigAtom).miningEfficiencyMult);
export const miningHeatCapacitySAtom = atom((get) => get(shipConfigAtom).miningHeatCapacityS);
export const miningCooldownSAtom = atom((get) => get(shipConfigAtom).miningCooldownS);
