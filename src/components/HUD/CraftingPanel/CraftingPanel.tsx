"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";

import { unlockedItemIdsAtom } from "@/store/research";
import { cargoAtom } from "@/store/cargo";
import { craftItemAtom, modulesAtom } from "@/store/modules";
import { describeRejection } from "@/store/operations";
import { addToastAtom } from "@/store/toast";
import {
  ITEMS,
  CRAFT_CATEGORIES,
  CRAFT_CATEGORY_LABELS,
  MATERIAL_NAMES,
  craftCategory,
  describeEffect,
  isDrawback,
  getItemIconUrl,
  type CraftCategory,
  type ItemDef,
} from "@/data/content";
import { KeyChip, ResourceIcon } from "../shared/Chips";
import Panel from "../Shell/Panel";
import ShipWorkshop from "./ShipWorkshop";

import "./CraftingPanel.scss";

/** Effect chips (module effects, then use effects), minus what `uiDesc` already states. */
function EffectChips({ item, className }: { item: ItemDef; className: string }) {
  const effs = [...(item.effects ?? []), ...(item.useEffects ?? [])].filter((e) => !item.descStates?.includes(e.key));
  if (effs.length === 0) return null;
  return (
    <div className={className}>
      {effs.map((eff, i) => (
        <span key={i} className={`crafting-panel__item-effect ${isDrawback(eff) ? "crafting-panel__item-effect--drawback" : ""}`}>
          {describeEffect(eff)}
        </span>
      ))}
    </div>
  );
}

export default function CraftingPanel({ onClose }: { onClose: () => void }) {
  const unlockedIds = useAtomValue(unlockedItemIdsAtom);
  const cargo = useAtomValue(cargoAtom);
  const modulesState = useAtomValue(modulesAtom);
  const craftItem = useSetAtom(craftItemAtom);
  const addToast = useSetAtom(addToastAtom);

  const [filter, setFilter] = useState<CraftCategory | "all">("all");
  const [confirmItem, setConfirmItem] = useState<ItemDef | null>(null);

  // Only categories with an unlocked blueprint (the workshop is always there).
  const categories = useMemo(() => CRAFT_CATEGORIES.filter((c) => c === "processing" || ITEMS.some((i) => unlockedIds.has(i.id) && craftCategory(i) === c)), [unlockedIds]);

  const craftableItems = useMemo(() => {
    if (filter === "processing") return [];
    return ITEMS.filter((item) => {
      if (!unlockedIds.has(item.id)) return false;
      if (filter !== "all" && craftCategory(item) !== filter) return false;
      return true;
    }).sort((a, b) => {
      const aOwned = a.type === "module" && modulesState.ownedModules.includes(a.id) ? 1 : 0;
      const bOwned = b.type === "module" && modulesState.ownedModules.includes(b.id) ? 1 : 0;
      return aOwned - bOwned;
    });
  }, [unlockedIds, filter, modulesState.ownedModules]);

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
    // Unaffordable crafts still go to the authority: its rejection explains what is missing.
    if (canAfford(item) && (item.type === "module" || item.type === "special")) {
      setConfirmItem(item);
    } else {
      handleCraft(item);
    }
  };

  const handleCraft = (item: ItemDef) => {
    setConfirmItem(null);
    craftItem({
      itemId: item.id,
      onSettled: (o) => {
        if (o.status === "rejected") {
          addToast({ audio: "reject", kind: "warn", message: "Cannot craft", detail: describeRejection(o) });
          return;
        }
        if (o.status !== "accepted" || o.result.type !== "item.craft") return;
        addToast({ audio: "silent", kind: "success", message: o.result.autoEquipped ? "Crafted · Equipped" : "Crafted", values: [{ id: item.id }], detail: item.name });
      },
    });
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
      fixedHeight
      onClose={onClose}
      closeOnEsc={!confirmItem}
      closeOnBackdrop={!confirmItem}
    >
      <div className="crafting-panel">
        <div className="crafting-panel__filters" role="tablist">
          {(["all", ...categories] as const).map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={filter === c}
              data-category={c}
              className={`crafting-panel__filter-btn ${filter === c ? "crafting-panel__filter-btn--active" : ""}`}
              onClick={() => setFilter(c)}
            >
              {c === "all" ? "All" : CRAFT_CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>

        <div className="crafting-panel__cargo-row">
          {Object.keys(MATERIAL_NAMES).filter((id) => (cargo.items[id] ?? 0) >= 1).map((id) => (
            <ResourceIcon key={id} id={id} amount={Math.floor(cargo.items[id] ?? 0)} />
          ))}
        </div>

        {(filter === "all" || filter === "processing") && <ShipWorkshop />}

        {/* Items */}
        <div className="crafting-panel__list">
          {filter === "processing" ? null : craftableItems.length === 0 ? (
            <div className="crafting-panel__empty">
              Nothing unlocked here yet
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
                        {CRAFT_CATEGORY_LABELS[craftCategory(item)]}
                      </span>
                    </div>
                  </div>
                  <div className="crafting-panel__item-desc">{item.uiDesc}</div>

                  <EffectChips item={item} className="crafting-panel__item-effects" />

                  <div className="crafting-panel__recipe">
                    {Object.entries(item.recipe).map(([resId, needed]) => (
                      <ResourceIcon key={resId} id={resId} amount={needed} have={owned ? undefined : Math.floor(cargo.items[resId] ?? 0)} />
                    ))}
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
            <EffectChips item={confirmItem} className="crafting-panel__confirm-effects" />
            {confirmItem.type === "module" && (
              <div className="crafting-panel__confirm-note">
                {!modulesState.equippedModules[confirmItem.slot] ? "Equips automatically" : <>Slot in use: equip in Loadout <KeyChip action="toggleLoadout" /></>}
              </div>
            )}
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
