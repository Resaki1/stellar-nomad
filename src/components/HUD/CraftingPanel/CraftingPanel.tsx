"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";

import { unlockedItemIdsAtom } from "@/store/research";
import { cargoAtom } from "@/store/cargo";
import { removeCargoAtom } from "@/store/cargo";
import { addCraftedItemAtom, itemCraftedSignalAtom, lastCraftedItemIdAtom, modulesAtom, setHotbarSlotAtom } from "@/store/modules";
import { addToastAtom } from "@/store/toast";
import { systemConfigAtom } from "@/store/system";
import { getResourceTypes } from "@/sim/asteroids/resources";
import {
  ITEMS,
  ALL_ITEM_SLOTS,
  SLOT_LABELS,
  describeEffect,
  getItemIconUrl,
  type ItemDef,
  type ItemSlot,
} from "@/data/content";
import Panel from "../Shell/Panel";

import "./CraftingPanel.scss";

export default function CraftingPanel({ onClose }: { onClose: () => void }) {
  const unlockedIds = useAtomValue(unlockedItemIdsAtom);
  const cargo = useAtomValue(cargoAtom);
  const modulesState = useAtomValue(modulesAtom);
  const systemConfig = useAtomValue(systemConfigAtom);
  const removeCargo = useSetAtom(removeCargoAtom);
  const addCraftedItem = useSetAtom(addCraftedItemAtom);
  const setHotbarSlot = useSetAtom(setHotbarSlotAtom);
  const incrementCraftSignal = useSetAtom(itemCraftedSignalAtom);
  const setLastCraftedId = useSetAtom(lastCraftedItemIdAtom);
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
    }).sort((a, b) => {
      const aOwned = a.type === "module" && modulesState.ownedModules.includes(a.id) ? 1 : 0;
      const bOwned = b.type === "module" && modulesState.ownedModules.includes(b.id) ? 1 : 0;
      return aOwned - bOwned;
    });
  }, [unlockedIds, slotFilter, modulesState.ownedModules]);

  const isModuleOwned = useCallback(
    (item: ItemDef): boolean =>
      (item.type === "module" || item.type === "special") && modulesState.ownedModules.includes(item.id),
    [modulesState.ownedModules],
  );

  const isEquipped = useCallback(
    (item: ItemDef): boolean =>
      item.type === "module" && modulesState.equippedModules[item.slot] === item.id,
    [modulesState.equippedModules],
  );

  const canAfford = useCallback(
    (item: ItemDef): boolean => {
      if ((item.type === "module" || item.type === "special") && modulesState.ownedModules.includes(item.id))
        return false;

      for (const [resourceId, needed] of Object.entries(item.recipe)) {
        const have = Math.floor(cargo.items[resourceId] ?? 0);
        if (have < needed) return false;
      }
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
    if (item.type === "module" || item.type === "special") {
      setConfirmItem(item);
    } else {
      handleCraft(item);
    }
  };

  const handleCraft = (item: ItemDef) => {
    if (!canAfford(item)) return;
    setConfirmItem(null);

    for (const [resourceId, needed] of Object.entries(item.recipe)) {
      removeCargo({ resourceId, amount: needed });
    }

    const autoEquipped = addCraftedItem(item.id);

    if (item.type === "consumable") {
      const alreadyOnHotbar = modulesState.hotbar.includes(item.id);
      if (!alreadyOnHotbar) {
        const emptyIdx = modulesState.hotbar.findIndex((s) => s === null);
        if (emptyIdx !== -1) {
          setHotbarSlot({ index: emptyIdx, itemId: item.id });
        }
      }
    }

    incrementCraftSignal((c) => c + 1);
    setLastCraftedId(item.id);

    if (item.type === "module") {
      if (autoEquipped) {
        addToast({
          message: `Crafted & equipped: ${item.name}`,
          durationMs: 3000,
        });
      } else {
        addToast({
          message: `Crafted: ${item.name} (${SLOT_LABELS[item.slot]} slot in use)`,
          durationMs: 4000,
        });
      }
    } else {
      addToast({
        message: `Crafted: ${item.name}`,
        durationMs: 3000,
      });
    }
  };

  // Local Esc handler: when the confirmation dialog is open, Esc dismisses
  // it. Panel's own Esc handler is disabled while confirmItem is set so the
  // two don't both fire at once.
  useEffect(() => {
    if (!confirmItem) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setConfirmItem(null);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [confirmItem]);

  return (
    <Panel
      title="Crafting"
      tier={2}
      width={640}
      onClose={onClose}
      closeOnEsc={!confirmItem}
      closeOnBackdrop={!confirmItem}
    >
      <div className="crafting-panel">
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
              const equipped = isEquipped(item);
              const affordable = canAfford(item);

              return (
                <div key={item.id} className={`crafting-panel__item ${owned ? "crafting-panel__item--owned" : ""}`}>
                  <div className="crafting-panel__item-header">
                    <img
                      className="crafting-panel__item-icon"
                      src={getItemIconUrl(item)}
                      alt=""
                    />
                    <div className="crafting-panel__item-title">
                      <span className="crafting-panel__item-name">
                        {item.name}
                      </span>
                      <span className="crafting-panel__item-slot">
                        {SLOT_LABELS[item.slot]}
                      </span>
                    </div>
                  </div>
                  <div className="crafting-panel__item-desc">{item.uiDesc}</div>

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
                      <span className={`crafting-panel__owned-badge ${equipped ? "crafting-panel__owned-badge--equipped" : ""}`}>
                        {equipped ? "Equipped" : "Owned"}
                      </span>
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
      </div>

      {/* Confirmation dialog (fixed overlay, above the Panel) */}
      {confirmItem && (
        <div className="crafting-panel__confirm-overlay" onClick={() => setConfirmItem(null)}>
          <div className="crafting-panel__confirm" onClick={(e) => e.stopPropagation()}>
            <div className="crafting-panel__confirm-title">Confirm Craft</div>
            <div className="crafting-panel__confirm-identity">
              <img
                className="crafting-panel__confirm-icon"
                src={getItemIconUrl(confirmItem)}
                alt=""
              />
              <div className="crafting-panel__confirm-name">{confirmItem.name}</div>
            </div>
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
              {confirmItem.type === "module" && !modulesState.equippedModules[confirmItem.slot]
                ? "This module will be auto-equipped into the empty slot."
                : confirmItem.type === "module"
                  ? `This module will be added to inventory. The ${SLOT_LABELS[confirmItem.slot]} slot is currently in use — swap from the loadout panel.`
                  : "This is a one-time craft."}
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
    </Panel>
  );
}
