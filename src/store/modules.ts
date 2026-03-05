// ---------------------------------------------------------------------------
// Modules / Loadout + Consumables inventory state
// ---------------------------------------------------------------------------
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
  ITEMS,
  getItemDef,
  type ItemDef,
  type ItemSlot,
  type ItemEffect,
} from "@/data/content";

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

export type ModulesState = {
  /** moduleItemId[] — all owned module items (can have duplicates from multiple crafts). */
  ownedModules: string[];
  /** slot → equipped module item ID (or null). */
  equipped: Partial<Record<ItemSlot, string>>;
  /** consumableItemId → current stack count. */
  consumables: Record<string, number>;
  /** consumableItemId → timestamp (ms) of last use for cooldown tracking. */
  consumableCooldowns: Record<string, number>;
  /** Hotbar: index 0-9 → consumable item ID (or null). */
  hotbar: (string | null)[];
};

const DEFAULT_MODULES: ModulesState = {
  ownedModules: [],
  equipped: {},
  consumables: {},
  consumableCooldowns: {},
  hotbar: Array(10).fill(null),
};

export const modulesAtom = atomWithStorage<ModulesState>(
  "modules-v1",
  DEFAULT_MODULES,
);

// ---------------------------------------------------------------------------
// Derived: computed stat modifiers from equipped modules
// ---------------------------------------------------------------------------

export type ComputedModifiers = {
  /** Boolean flags set by modules. */
  flags: Record<string, boolean>;
  /** Multiplicative modifiers (product of all multipliers per key). */
  multipliers: Record<string, number>;
  /** Additive modifiers (sum of all additions per key). */
  additions: Record<string, number>;
};

export const computedModifiersAtom = atom((get): ComputedModifiers => {
  const state = get(modulesAtom);
  const flags: Record<string, boolean> = {};
  const multipliers: Record<string, number> = {};
  const additions: Record<string, number> = {};

  for (const slot in state.equipped) {
    const itemId = state.equipped[slot as ItemSlot];
    if (!itemId) continue;
    const def = getItemDef(itemId);
    if (!def?.effects) continue;

    for (const eff of def.effects) {
      if (eff.op === "set") {
        flags[eff.key] = eff.value as boolean;
      } else if (eff.op === "multiply") {
        multipliers[eff.key] = (multipliers[eff.key] ?? 1) * (eff.value as number);
      } else if (eff.op === "add") {
        additions[eff.key] = (additions[eff.key] ?? 0) + (eff.value as number);
      }
    }
  }

  return { flags, multipliers, additions };
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
// Actions: craft item
// ---------------------------------------------------------------------------

/**
 * Add a crafted item to inventory. Does NOT deduct cargo (caller does that).
 */
export const addCraftedItemAtom = atom(
  null,
  (get, set, itemId: string): void => {
    const def = getItemDef(itemId);
    if (!def) return;

    const state = get(modulesAtom);

    if (def.type === "consumable") {
      const current = state.consumables[itemId] ?? 0;
      const max = def.stackMax ?? 99;
      if (current >= max) return;
      set(modulesAtom, {
        ...state,
        consumables: { ...state.consumables, [itemId]: current + 1 },
      });
    } else {
      // Module — add to owned, optionally auto-equip if slot free
      const newOwned = [...state.ownedModules, itemId];
      const newEquipped = { ...state.equipped };
      if (!newEquipped[def.slot]) {
        newEquipped[def.slot] = itemId;
      }
      set(modulesAtom, {
        ...state,
        ownedModules: newOwned,
        equipped: newEquipped,
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Actions: equip / unequip
// ---------------------------------------------------------------------------

export const equipModuleAtom = atom(
  null,
  (get, set, itemId: string): void => {
    const def = getItemDef(itemId);
    if (!def || def.type !== "module") return;

    const state = get(modulesAtom);
    if (!state.ownedModules.includes(itemId)) return;

    set(modulesAtom, {
      ...state,
      equipped: { ...state.equipped, [def.slot]: itemId },
    });
  },
);

export const unequipModuleAtom = atom(
  null,
  (get, set, slot: ItemSlot): void => {
    const state = get(modulesAtom);
    if (!state.equipped[slot]) return;

    const newEquipped = { ...state.equipped };
    delete newEquipped[slot];
    set(modulesAtom, { ...state, equipped: newEquipped });
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

    // Check cooldown
    const lastUse = state.consumableCooldowns[itemId] ?? 0;
    const cooldownMs = (def.cooldownS ?? 0) * 1000;
    if (performance.now() - lastUse < cooldownMs) return false;

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

// ---------------------------------------------------------------------------
// Derived: owned modules grouped by slot
// ---------------------------------------------------------------------------

export const ownedModulesBySlotAtom = atom((get) => {
  const state = get(modulesAtom);
  const map: Partial<Record<ItemSlot, ItemDef[]>> = {};

  for (const itemId of state.ownedModules) {
    const def = getItemDef(itemId);
    if (!def || def.type !== "module") continue;
    if (!map[def.slot]) map[def.slot] = [];
    // Avoid duplicates in display (player owns the blueprint, not multiple copies)
    if (!map[def.slot]!.find((d) => d.id === def.id)) {
      map[def.slot]!.push(def);
    }
  }

  return map;
});
