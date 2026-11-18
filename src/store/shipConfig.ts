import { atom } from "jotai";
import { savedAtom } from "@/store/savedAtom";
import { defaultShipConfig } from "@/save/defaults";
import type { ShipConfig } from "@/save/types";
import { computedModifiersAtom } from "@/store/modules";
import { timedEffectModifiersAtom } from "@/store/timedEffects";
import { applyModifiers, mergeModifiers } from "@/sim/ship/loadout";

// Base ship stats (un-upgraded defaults in save/defaults.ts). Module and timed modifiers are
// folded in by `effectiveShipConfigAtom`; research grants blueprints, not stats.
export type { ShipConfig } from "@/save/types";

export const shipConfigAtom = savedAtom("player", "shipConfig", defaultShipConfig());

/** Base config + equipped modules + active timed consumables. Prefer this over `shipConfigAtom`. */
export const effectiveShipConfigAtom = atom((get): ShipConfig =>
  applyModifiers(get(shipConfigAtom), mergeModifiers(get(computedModifiersAtom), get(timedEffectModifiersAtom))),
);

// ---------------------------------------------------------------------------
// Convenience selectors (now from effective config)
// ---------------------------------------------------------------------------

export const miningSpeedMultAtom = atom((get) => get(effectiveShipConfigAtom).miningSpeedMult);
export const miningEfficiencyMultAtom = atom((get) => get(effectiveShipConfigAtom).miningEfficiencyMult);
export const miningHeatCapacitySAtom = atom((get) => get(effectiveShipConfigAtom).miningHeatCapacityS);
export const miningCooldownSAtom = atom((get) => get(effectiveShipConfigAtom).miningCooldownS);
