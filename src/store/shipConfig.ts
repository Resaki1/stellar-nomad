import { atom } from "jotai";
import { savedAtom } from "@/store/savedAtom";
import { defaultShipConfig } from "@/save/defaults";
import type { ShipConfig } from "@/save/types";
import { computedModifiersAtom } from "@/store/modules";
import { completedNodeSetAtom } from "@/store/research";
import { timedEffectModifiersAtom } from "@/store/timedEffects";
import { applyModifiers, mergeModifiers, researchModifiers, type ComputedModifiers } from "@/sim/ship/loadout";

// Base ship stats (un-upgraded defaults in save/defaults.ts). Module, research and timed
// modifiers are folded in by `effectiveShipConfigAtom`.
export type { ShipConfig } from "@/save/types";

export const shipConfigAtom = savedAtom("player", "shipConfig", defaultShipConfig());

/** Passive bonuses of the WORLD's completed research, folded in exactly once below. */
export const researchModifiersAtom = atom((get): ComputedModifiers => researchModifiers(get(completedNodeSetAtom)));

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
