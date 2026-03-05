"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo, useState } from "react";

import { unlockedItemIdsAtom } from "@/store/research";
import { cargoAtom } from "@/store/cargo";
import { removeCargoAtom } from "@/store/cargo";
import { addCraftedItemAtom, modulesAtom, setHotbarSlotAtom } from "@/store/modules";
import { addToastAtom } from "@/store/toast";
import { systemConfigAtom } from "@/store/system";
import { getResourceTypes } from "@/sim/asteroids/resources";
import {
  ITEMS,
  ALL_ITEM_SLOTS,
  SLOT_LABELS,
  type ItemDef,
  type ItemSlot,
} from "@/data/content";

import "./CraftingPanel.scss";

export default function CraftingPanel({ onClose }: { onClose: () => void }) {
  const unlockedIds = useAtomValue(unlockedItemIdsAtom);
  const cargo = useAtomValue(cargoAtom);
  const modulesState = useAtomValue(modulesAtom);
  const systemConfig = useAtomValue(systemConfigAtom);
  const removeCargo = useSetAtom(removeCargoAtom);
  const addCraftedItem = useSetAtom(addCraftedItemAtom);
  const setHotbarSlot = useSetAtom(setHotbarSlotAtom);
  const addToast = useSetAtom(addToastAtom);

  const [slotFilter, setSlotFilter] = useState<ItemSlot | "all">("all");

  const resourceMap = useMemo(() => {
    const types = getResourceTypes(systemConfig);
    const map = new Map<string, { name: string; icon: string }>();
    for (const d of types) map.set(d.id, { name: d.name, icon: d.icon ?? "" });
    return map;
  }, [systemConfig]);

  const craftableItems = useMemo(() => {
    return ITEMS.filter((item) => {
      if (!unlockedIds.has(item.id)) return false;
      if (slotFilter !== "all" && item.slot !== slotFilter) return false;
      return true;
    });
  }, [unlockedIds, slotFilter]);

  const canAfford = useCallback(
    (item: ItemDef): boolean => {
      for (const [resourceId, needed] of Object.entries(item.recipe)) {
        const have = Math.floor(cargo.items[resourceId] ?? 0);
        if (have < needed) return false;
      }
      // Check consumable stack limit
      if (item.type === "consumable") {
        const current = modulesState.consumables[item.id] ?? 0;
        if (current >= (item.stackMax ?? 99)) return false;
      }
      return true;
    },
    [cargo.items, modulesState.consumables],
  );

  const handleCraft = (item: ItemDef) => {
    if (!canAfford(item)) return;

    // Deduct resources
    for (const [resourceId, needed] of Object.entries(item.recipe)) {
      removeCargo({ resourceId, amount: needed });
    }

    // Add item
    addCraftedItem(item.id);

    // Auto-assign consumables to the first empty hotbar slot
    if (item.type === "consumable") {
      const alreadyOnHotbar = modulesState.hotbar.includes(item.id);
      if (!alreadyOnHotbar) {
        const emptyIdx = modulesState.hotbar.findIndex((s) => s === null);
        if (emptyIdx !== -1) {
          setHotbarSlot({ index: emptyIdx, itemId: item.id });
        }
      }
    }

    addToast({
      message: `Crafted: ${item.name}`,
      durationMs: 3000,
    });
  };

  return (
    <div className="crafting-panel__backdrop" onClick={onClose}>
      <div className="crafting-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="crafting-panel__header">
          <div className="crafting-panel__title">Crafting</div>
          <button className="crafting-panel__close" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Cargo summary */}
        <div className="crafting-panel__cargo-row">
          {Array.from(resourceMap.entries()).map(([id, def]) => (
            <span key={id} className="crafting-panel__cargo-item">
              {def.icon} {Math.floor(cargo.items[id] ?? 0)}
            </span>
          ))}
        </div>

        {/* Slot filter */}
        <div className="crafting-panel__filters">
          <button
            className={`crafting-panel__filter-btn ${
              slotFilter === "all" ? "crafting-panel__filter-btn--active" : ""
            }`}
            onClick={() => setSlotFilter("all")}
          >
            All
          </button>
          {ALL_ITEM_SLOTS.map((slot) => (
            <button
              key={slot}
              className={`crafting-panel__filter-btn ${
                slotFilter === slot ? "crafting-panel__filter-btn--active" : ""
              }`}
              onClick={() => setSlotFilter(slot)}
            >
              {SLOT_LABELS[slot]}
            </button>
          ))}
        </div>

        {/* Items */}
        <div className="crafting-panel__list">
          {craftableItems.length === 0 ? (
            <div className="crafting-panel__empty">
              {unlockedIds.size === 0
                ? "Complete research to unlock blueprints."
                : "No items match this filter."}
            </div>
          ) : (
            craftableItems.map((item) => {
              const affordable = canAfford(item);

              return (
                <div key={item.id} className="crafting-panel__item">
                  <div className="crafting-panel__item-header">
                    <span className="crafting-panel__item-name">
                      {item.name}
                    </span>
                    <span className="crafting-panel__item-slot">
                      {SLOT_LABELS[item.slot]}
                    </span>
                  </div>
                  <div className="crafting-panel__item-desc">{item.uiDesc}</div>

                  {/* Effects summary */}
                  {item.effects && item.effects.length > 0 && (
                    <div className="crafting-panel__item-effects">
                      {item.effects.map((eff, i) => (
                        <span key={i} className="crafting-panel__item-effect">
                          {formatEffect(eff)}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Recipe costs */}
                  <div className="crafting-panel__recipe">
                    {Object.entries(item.recipe).map(([resId, needed]) => {
                      const have = Math.floor(cargo.items[resId] ?? 0);
                      const def = resourceMap.get(resId);
                      const enough = have >= needed;
                      return (
                        <span
                          key={resId}
                          className={`crafting-panel__recipe-item ${
                            !enough
                              ? "crafting-panel__recipe-item--insufficient"
                              : ""
                          }`}
                        >
                          {def?.icon ?? ""} {have}/{needed}
                        </span>
                      );
                    })}
                  </div>

                  <div className="crafting-panel__item-actions">
                    <button
                      className="crafting-panel__craft-btn"
                      disabled={!affordable}
                      onClick={() => handleCraft(item)}
                    >
                      Craft
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function formatEffect(eff: { key: string; op: string; value: number | boolean }): string {
  const label = eff.key.split(".").pop() ?? eff.key;
  if (eff.op === "set") return `${label}: ${eff.value ? "ON" : "OFF"}`;
  if (eff.op === "multiply") {
    const pct = Math.round(((eff.value as number) - 1) * 100);
    return `${label} ${pct >= 0 ? "+" : ""}${pct}%`;
  }
  if (eff.op === "add") return `${label} +${eff.value}`;
  return `${label}: ${eff.value}`;
}
