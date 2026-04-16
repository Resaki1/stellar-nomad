// ---------------------------------------------------------------------------
// Timed consumable effects — temporary stat modifiers that expire after a
// duration. Written when a timed consumable is used, read by the ship config
// system to fold into effective stats.
// ---------------------------------------------------------------------------

import { atom } from "jotai";
import { type ItemEffect, type ConsumableUseEffect } from "@/data/content";
import { aggregateEffects, type ComputedModifiers } from "@/store/modules";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TimedEffect = {
  /** Unique ID (usually the consumable item ID + timestamp). */
  id: string;
  /** The stat effects to apply while active. */
  effects: ConsumableUseEffect[];
  /** Time remaining in seconds. */
  remainingS: number;
  /** Original duration in seconds (for UI progress display). */
  totalS: number;
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const activeTimedEffectsAtom = atom<TimedEffect[]>([]);

// ---------------------------------------------------------------------------
// Derived: computed modifiers from active timed effects
// ---------------------------------------------------------------------------

export const timedEffectModifiersAtom = atom((get): ComputedModifiers => {
  const effects = get(activeTimedEffectsAtom);
  if (effects.length === 0) {
    return { flags: {}, multipliers: {}, additions: {} };
  }

  const allEffects: ItemEffect[] = [];
  for (const te of effects) {
    for (const eff of te.effects) {
      allEffects.push(eff as ItemEffect);
    }
  }

  return aggregateEffects(allEffects);
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Add a new timed effect. If a timed effect from the same consumable is
 * already active, refresh its duration instead of stacking.
 */
export const addTimedEffectAtom = atom(
  null,
  (get, set, payload: { itemId: string; effects: ConsumableUseEffect[]; durationS: number }): void => {
    const current = get(activeTimedEffectsAtom);

    // Check if this consumable type already has an active effect — refresh it
    const existing = current.findIndex((te) => te.id === payload.itemId);
    if (existing >= 0) {
      const updated = [...current];
      updated[existing] = {
        ...updated[existing],
        remainingS: payload.durationS,
        totalS: payload.durationS,
      };
      set(activeTimedEffectsAtom, updated);
      return;
    }

    set(activeTimedEffectsAtom, [
      ...current,
      {
        id: payload.itemId,
        effects: payload.effects,
        remainingS: payload.durationS,
        totalS: payload.durationS,
      },
    ]);
  },
);

/**
 * Tick all active timed effects. Removes expired ones.
 * Call this from a game-loop ticker (e.g., useFrame or a dedicated interval).
 */
export const tickTimedEffectsAtom = atom(
  null,
  (get, set, deltaS: number): void => {
    const current = get(activeTimedEffectsAtom);
    if (current.length === 0) return;

    const updated = current
      .map((te) => ({ ...te, remainingS: te.remainingS - deltaS }))
      .filter((te) => te.remainingS > 0);

    // Only update if something changed
    if (updated.length !== current.length || updated.some((te, i) => te.remainingS !== current[i].remainingS)) {
      set(activeTimedEffectsAtom, updated);
    }
  },
);
