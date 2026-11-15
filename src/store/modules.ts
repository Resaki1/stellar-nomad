// ---------------------------------------------------------------------------
// Modules / Loadout + Consumables inventory state
// ---------------------------------------------------------------------------
import { atom } from "jotai";
import { signalAudioActionAtom } from "./audioSignals";
import { savedAtom } from "@/store/savedAtom";
import { defaultModules } from "@/save/defaults";
import {
  getItemDef,
  type ItemEffect,
  type ItemSlot,
} from "@/data/content";

export type { ModulesState } from "@/save/types";

export const modulesAtom = savedAtom("player", "modules", defaultModules());

// ---------------------------------------------------------------------------
// Derived: computed stat modifiers from EQUIPPED modules only
// ---------------------------------------------------------------------------

export type ComputedModifiers = {
  /** Boolean flags set by modules. */
  flags: Record<string, boolean>;
  /** Multiplicative modifiers (product of all multipliers per key). */
  multipliers: Record<string, number>;
  /** Additive modifiers (sum of all additions per key). */
  additions: Record<string, number>;
};

export function aggregateEffects(effects: ItemEffect[]): ComputedModifiers {
  const flags: Record<string, boolean> = {};
  const multipliers: Record<string, number> = {};
  const additions: Record<string, number> = {};

  for (const eff of effects) {
    if (eff.op === "set") {
      flags[eff.key] = eff.value as boolean;
    } else if (eff.op === "multiply") {
      multipliers[eff.key] = (multipliers[eff.key] ?? 1) * (eff.value as number);
    } else if (eff.op === "add") {
      additions[eff.key] = (additions[eff.key] ?? 0) + (eff.value as number);
    }
  }

  return { flags, multipliers, additions };
}

export function mergeModifiers(a: ComputedModifiers, b: ComputedModifiers): ComputedModifiers {
  const flags = { ...a.flags, ...b.flags };
  const multipliers = { ...a.multipliers };
  const additions = { ...a.additions };

  for (const [key, val] of Object.entries(b.multipliers)) {
    multipliers[key] = (multipliers[key] ?? 1) * val;
  }
  for (const [key, val] of Object.entries(b.additions)) {
    additions[key] = (additions[key] ?? 0) + val;
  }

  return { flags, multipliers, additions };
}

export const computedModifiersAtom = atom((get): ComputedModifiers => {
  const state = get(modulesAtom);
  const allEffects: ItemEffect[] = [];

  // Only iterate EQUIPPED modules, not all owned modules
  for (const itemId of Object.values(state.equippedModules)) {
    if (!itemId) continue;
    const def = getItemDef(itemId);
    if (!def?.effects) continue;
    allEffects.push(...def.effects);
  }

  return aggregateEffects(allEffects);
});

// ---------------------------------------------------------------------------
// Helper: query a modifier
// ---------------------------------------------------------------------------

export function getFlag(mods: ComputedModifiers, key: string): boolean {
  return mods.flags[key] ?? false;
}

export function getMultiplier(mods: ComputedModifiers, key: string): number {
  return mods.multipliers[key] ?? 1;
}

export function getAddition(mods: ComputedModifiers, key: string): number {
  return mods.additions[key] ?? 0;
}

// ---------------------------------------------------------------------------
// Actions: equip / unequip modules
// ---------------------------------------------------------------------------

/**
 * Equip a module into its slot. The module must be owned.
 * Replaces whatever is currently in that slot.
 */
export const equipModuleAtom = atom(
  null,
  (get, set, itemId: string): boolean => {
    const def = getItemDef(itemId);
    if (!def || def.type !== "module") return false;

    const state = get(modulesAtom);
    if (!state.ownedModules.includes(itemId)) return false;
    if (state.equippedModules[def.slot] === itemId) return true;

    set(modulesAtom, {
      ...state,
      equippedModules: { ...state.equippedModules, [def.slot]: itemId },
    });
    set(signalAudioActionAtom, "module.equip");
    return true;
  },
);

/**
 * Unequip whatever module is in the given slot.
 */
export const unequipSlotAtom = atom(
  null,
  (get, set, slot: ItemSlot): void => {
    const state = get(modulesAtom);
    if (!state.equippedModules[slot]) return;

    const newEquipped = { ...state.equippedModules };
    delete newEquipped[slot];

    set(modulesAtom, {
      ...state,
      equippedModules: newEquipped,
    });
    set(signalAudioActionAtom, "module.unequip");
  },
);

// ---------------------------------------------------------------------------
// Actions: craft item
// ---------------------------------------------------------------------------

/**
 * Add a crafted item to inventory. Does NOT deduct cargo (caller does that).
 * Returns whether the item was auto-equipped into an empty slot.
 */
export const addCraftedItemAtom = atom(
  null,
  (get, set, itemId: string): boolean => {
    const def = getItemDef(itemId);
    if (!def) return false;

    const state = get(modulesAtom);

    if (def.type === "consumable") {
      const current = state.consumables[itemId] ?? 0;
      const max = def.stackMax ?? 99;
      if (current >= max) return false;
      set(modulesAtom, {
        ...state,
        consumables: { ...state.consumables, [itemId]: current + 1 },
      });
      return false;
    } else if (def.type === "module") {
      // Module — one-time craft; skip if already owned
      if (state.ownedModules.includes(itemId)) return false;

      const slotEmpty = !state.equippedModules[def.slot];
      set(modulesAtom, {
        ...state,
        ownedModules: [...state.ownedModules, itemId],
        // Auto-equip if slot is empty
        equippedModules: slotEmpty
          ? { ...state.equippedModules, [def.slot]: itemId }
          : state.equippedModules,
      });
      return slotEmpty;
    } else {
      // Special items — just track as owned
      if (state.ownedModules.includes(itemId)) return false;
      set(modulesAtom, {
        ...state,
        ownedModules: [...state.ownedModules, itemId],
      });
      return false;
    }
  },
);

// ---------------------------------------------------------------------------
// Actions: consumable use
// ---------------------------------------------------------------------------

export const useConsumableAtom = atom(
  null,
  (get, set, itemId: string): boolean => {
    const def = getItemDef(itemId);
    if (!def || def.type !== "consumable") return false;

    const state = get(modulesAtom);
    const count = state.consumables[itemId] ?? 0;
    if (count <= 0) return false;

    // Check cooldown (guard against stale timestamps from previous sessions —
    // performance.now() resets on reload but consumableCooldowns are persisted)
    const cooldownS = def.cooldownS ?? 0;
    if (cooldownS > 0) {
      const lastUse = state.consumableCooldowns[itemId] ?? 0;
      const elapsed = performance.now() - lastUse;
      if (elapsed >= 0 && elapsed < cooldownS * 1000) return false;
    }

    // Consume
    const newConsumables = { ...state.consumables };
    newConsumables[itemId] = count - 1;
    if (newConsumables[itemId] <= 0) delete newConsumables[itemId];

    set(modulesAtom, {
      ...state,
      consumables: newConsumables,
      consumableCooldowns: {
        ...state.consumableCooldowns,
        [itemId]: performance.now(),
      },
    });

    return true;
  },
);

// ---------------------------------------------------------------------------
// Actions: hotbar management
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Craft-completed signal — incremented by CraftingPanel each time an item
// is crafted. GameCommsTriggers watches this to fire comms messages.
// ---------------------------------------------------------------------------

export const itemCraftedSignalAtom = atom(0);

/**
 * Signal: last crafted item ID.
 * GameCommsTriggers watches this to fire per-item comms messages.
 * The played-message registry prevents replays for consumables.
 */
export const lastCraftedItemIdAtom = atom<string | null>(null);

/**
 * MIME types used for drag-and-drop between LoadoutPanel and Hotbar.
 * Payload is the consumable itemId string.
 */
export const HOTBAR_DRAG_MIME = "application/x-sn-consumable";
/** Source slot index (as string) when dragging from one hotbar slot to another. */
export const HOTBAR_SOURCE_SLOT_MIME = "application/x-sn-hotbar-source";

export const setHotbarSlotAtom = atom(
  null,
  (get, set, update: { index: number; itemId: string | null }): void => {
    const state = get(modulesAtom);
    const newHotbar = [...state.hotbar];
    // Clear this item from any other slot first
    if (update.itemId) {
      for (let i = 0; i < newHotbar.length; i++) {
        if (newHotbar[i] === update.itemId) newHotbar[i] = null;
      }
    }
    newHotbar[update.index] = update.itemId;
    set(modulesAtom, { ...state, hotbar: newHotbar });
  },
);
