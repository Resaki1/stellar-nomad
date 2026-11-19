// ---------------------------------------------------------------------------
// Modules / Loadout + Consumables inventory state
// ---------------------------------------------------------------------------
import { atom, type Setter } from "jotai";
import { signalAudioActionAtom } from "./audioSignals";
import { savedAtom } from "@/store/savedAtom";
import { defaultModules } from "@/save/defaults";
import { canWriteSlice } from "@/save/activeSave";
import { getItemDef, type ItemSlot } from "@/data/content";
import { moduleModifiers, type ComputedModifiers } from "@/sim/ship/loadout";
import type { OperationOutcome } from "@/sim/world/commands";
import { describeRejection, newOpId, runOperation } from "@/store/operations";
import { addToastAtom } from "@/store/toast";

export type { ModulesState } from "@/save/types";

export const modulesAtom = savedAtom("player", "modules", defaultModules());

export {
  aggregateEffects,
  mergeModifiers,
  getFlag,
  getMultiplier,
  getAddition,
  type ComputedModifiers,
} from "@/sim/ship/loadout";

/** Stat modifiers from EQUIPPED modules only. */
export const computedModifiersAtom = atom((get): ComputedModifiers => moduleModifiers(get(modulesAtom)));

// ---------------------------------------------------------------------------
// Actions: equip / unequip modules
// ---------------------------------------------------------------------------

/** Equip (or with `itemId: null` empty) a slot through the authority, which refuses a fit
 * that would leave fuel above the new tank or cargo above the new hold. */
const setSlot = (set: Setter, slot: ItemSlot, itemId: string | null): boolean => {
  const o = runOperation({ type: "module.equip", opId: newOpId(), slot, itemId });
  if (o.status === "accepted") set(signalAudioActionAtom, itemId ? "module.equip" : "module.unequip");
  else if (o.status === "rejected" && o.reason !== "already_done") {
    set(addToastAtom, { audio: "reject", message: itemId ? "Cannot equip module" : "Cannot remove module", kind: "warn", detail: describeRejection(o) });
  }
  return o.status === "accepted" || (o.status === "rejected" && o.reason === "already_done" && itemId !== null);
};

export const equipModuleAtom = atom(null, (_get, set, itemId: string): boolean => {
  const def = getItemDef(itemId);
  return !!def && def.type === "module" && setSlot(set, def.slot, itemId);
});

export const unequipSlotAtom = atom(null, (_get, set, slot: ItemSlot): void => {
  setSlot(set, slot, null);
});

// ---------------------------------------------------------------------------
// Actions: craft item
// ---------------------------------------------------------------------------

/**
 * Craft through the authority: validates knowledge, stack room and materials, then spends and
 * grants in one commit. `onSettled` receives the outcome (a rejection spent nothing).
 */
export const craftItemAtom = atom(
  null,
  (_get, set, payload: { itemId: string; onSettled?: (o: OperationOutcome) => void }): void => {
    runOperation({ type: "item.craft", opId: newOpId(), itemId: payload.itemId }, (o) => {
      if (o.status === "accepted" && o.result.type === "item.craft") {
        set(itemCraftedSignalAtom, (c) => c + 1);
        set(lastCraftedItemIdAtom, o.result.itemId);
      }
      payload.onSettled?.(o);
    });
  },
);

/**
 * Dev grant: add an item without a recipe (no cargo spend).
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
    if (!def || def.type !== "consumable" || def.deployable) return false;
    // Co-op: the count is the host's (no consume command yet), so no free use either.
    if (!canWriteSlice("player", "modules")) return false;

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
