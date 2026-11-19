import { atom } from "jotai";
import { savedAtom } from "@/store/savedAtom";
import { defaultCargo } from "@/save/defaults";
import { canWriteSlice } from "@/save/activeSave";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { signalAudioActionAtom } from "./audioSignals";

export type { CargoState } from "@/save/types";

export const cargoAtom = savedAtom("player", "cargo", defaultCargo());

export const cargoCapacityUnitsAtom = atom((get) => {
  const base = get(cargoAtom).capacityUnits;
  const bonus = get(effectiveShipConfigAtom).bonusCargoCapacity;
  return base + bonus;
});

export const cargoUsedUnitsAtom = atom((get) => {
  const { items } = get(cargoAtom);
  let used = 0;
  for (const k in items) {
    const v = items[k];
    if (!Number.isFinite(v)) continue;
    used += Math.max(0, Math.floor(v));
  }
  return used;
});

export const cargoRemainingUnitsAtom = atom((get) => {
  const remaining = get(cargoCapacityUnitsAtom) - get(cargoUsedUnitsAtom);
  return Math.max(0, remaining);
});

export const cargoFillFractionAtom = atom((get) => {
  const cap = get(cargoCapacityUnitsAtom);
  if (cap <= 0) return 1;
  return Math.min(1, Math.max(0, get(cargoUsedUnitsAtom) / cap));
});

export const isCargoFullAtom = atom((get) => get(cargoRemainingUnitsAtom) <= 0);

export const addCargoAtom = atom(
  null,
  (get, set, update: { resourceId: string; amount: number }): void => {
    const resourceId = update.resourceId;
    const rawAmount = update.amount;

    const amount = Math.max(0, Math.floor(rawAmount));
    if (!resourceId || amount <= 0) return;
    if (!canWriteSlice("player", "cargo")) return;

    const remaining = get(cargoRemainingUnitsAtom);
    if (remaining <= 0) return;

    const granted = Math.min(amount, remaining);

    const state = get(cargoAtom);
    const prev = Math.max(0, Math.floor(state.items[resourceId] ?? 0));

    set(cargoAtom, {
      ...state,
      items: {
        ...state.items,
        [resourceId]: prev + granted,
      },
    });
    set(signalAudioActionAtom, "loot.acquire");
  }
);

/**
 * Remove a specific amount of a resource from cargo.
 * Pass `Infinity` or omit amount to remove all of that resource.
 */
export const removeCargoAtom = atom(
  null,
  (get, set, update: { resourceId: string; amount?: number }): void => {
    const { resourceId, amount } = update;
    if (!resourceId || !canWriteSlice("player", "cargo")) return;

    const state = get(cargoAtom);
    const current = Math.max(0, Math.floor(state.items[resourceId] ?? 0));
    if (current <= 0) return;

    const toRemove =
      amount === undefined || !Number.isFinite(amount)
        ? current
        : Math.max(0, Math.floor(amount));

    const remaining = current - toRemove;

    const newItems = { ...state.items };
    if (remaining <= 0) {
      delete newItems[resourceId];
    } else {
      newItems[resourceId] = remaining;
    }

    set(cargoAtom, { ...state, items: newItems });
  }
);

export const clearCargoAtom = atom(null, (get, set) => {
  const state = get(cargoAtom);
  set(cargoAtom, { ...state, items: {} });
});

export const setCargoCapacityAtom = atom(null, (get, set, capacityUnits: number) => {
  const cap = Math.max(0, Math.floor(capacityUnits));
  const state = get(cargoAtom);
  set(cargoAtom, { ...state, capacityUnits: cap });
});
