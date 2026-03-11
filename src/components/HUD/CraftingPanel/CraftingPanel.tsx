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
  describeEffect,
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
  const [confirmItem, setConfirmItem] = useState<ItemDef | null>(null);

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

  const isModuleOwned = useCallback(
    (item: ItemDef): boolean =>
      item.type === "module" && modulesState.ownedModules.includes(item.id),
    [modulesState.ownedModules],
  );

  const canAfford = useCallback(
    (item: ItemDef): boolean => {
      // Modules are one-time crafts
      if (item.type === "module" && modulesState.ownedModules.includes(item.id))
        return false;

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
    [cargo.items, modulesState.consumables, modulesState.ownedModules],
  );

  const requestCraft = (item: ItemDef) => {
    if (!canAfford(item)) return;
    // Modules: show confirmation; consumables: craft immediately
    if (item.type === "module") {
      setConfirmItem(item);
    } else {
      handleCraft(item);
    }
  };

  const handleCraft = (item: ItemDef) => {
    if (!canAfford(item)) return;
    setConfirmItem(null);

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
              {def.icon && <img className="crafting-panel__resource-icon" src={def.icon} alt="" />}
              {Math.floor(cargo.items[id] ?? 0)}
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
              const owned = isModuleOwned(item);
              const affordable = canAfford(item);

              return (
                <div key={item.id} className={`crafting-panel__item ${owned ? "crafting-panel__item--owned" : ""}`}>
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
                          {describeEffect(eff)}
                        </span>
                      ))}
                    </div>
                  )}

                  {item.useEffects && item.useEffects.length > 0 && (
                    <div className="crafting-panel__item-effects">
                      {item.useEffects.map((eff, i) => (
                        <span key={i} className="crafting-panel__item-effect">
                          {describeEffect(eff)}
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
                          {def?.icon && <img className="crafting-panel__resource-icon" src={def.icon} alt="" />}
                          {have}/{needed}
                        </span>
                      );
                    })}
                  </div>

                  <div className="crafting-panel__item-actions">
                    {owned ? (
                      <span className="crafting-panel__owned-badge">✓ Owned</span>
                    ) : (
                      <button
                        className="crafting-panel__craft-btn"
                        disabled={!affordable}
                        onClick={() => requestCraft(item)}
                      >
                        Craft
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Confirmation dialog for modules */}
        {confirmItem && (
          <div className="crafting-panel__confirm-overlay" onClick={() => setConfirmItem(null)}>
            <div className="crafting-panel__confirm" onClick={(e) => e.stopPropagation()}>
              <div className="crafting-panel__confirm-title">Confirm Craft</div>
              <div className="crafting-panel__confirm-name">{confirmItem.name}</div>
              <div className="crafting-panel__confirm-desc">{confirmItem.uiDesc}</div>
              {confirmItem.effects && confirmItem.effects.length > 0 && (
                <div className="crafting-panel__confirm-effects">
                  {confirmItem.effects.map((eff, i) => (
                    <span key={i} className="crafting-panel__item-effect">
                      {describeEffect(eff)}
                    </span>
                  ))}
                </div>
              )}
              <div className="crafting-panel__confirm-note">
                This is a one-time upgrade and cannot be undone.
              </div>
              <div className="crafting-panel__confirm-actions">
                <button
                  className="crafting-panel__confirm-cancel"
                  onClick={() => setConfirmItem(null)}
                >
                  Cancel
                </button>
                <button
                  className="crafting-panel__craft-btn"
                  onClick={() => handleCraft(confirmItem)}
                >
                  Craft
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
