"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useMemo } from "react";

import {
  modulesAtom,
  ownedModulesBySlotAtom,
  equipModuleAtom,
  unequipModuleAtom,
  computedModifiersAtom,
} from "@/store/modules";
import { ALL_ITEM_SLOTS, SLOT_LABELS, getItemDef, type ItemSlot } from "@/data/content";

import "./LoadoutPanel.scss";

export default function LoadoutPanel({ onClose }: { onClose: () => void }) {
  const modulesState = useAtomValue(modulesAtom);
  const ownedBySlot = useAtomValue(ownedModulesBySlotAtom);
  const modifiers = useAtomValue(computedModifiersAtom);
  const equipModule = useSetAtom(equipModuleAtom);
  const unequipModule = useSetAtom(unequipModuleAtom);

  const slotsWithContent = useMemo(() => {
    return ALL_ITEM_SLOTS.filter((slot) => {
      const equipped = modulesState.equipped[slot];
      const owned = ownedBySlot[slot];
      return equipped || (owned && owned.length > 0);
    });
  }, [modulesState.equipped, ownedBySlot]);

  // Active modifier summary
  const modSummary = useMemo(() => {
    const lines: string[] = [];

    for (const [key, val] of Object.entries(modifiers.flags)) {
      if (val) lines.push(`${key.split(".").pop()}: ON`);
    }
    for (const [key, val] of Object.entries(modifiers.multipliers)) {
      if (val !== 1) {
        const pct = Math.round((val - 1) * 100);
        lines.push(`${key.split(".").pop()} ${pct >= 0 ? "+" : ""}${pct}%`);
      }
    }
    for (const [key, val] of Object.entries(modifiers.additions)) {
      if (val !== 0) {
        lines.push(`${key.split(".").pop()} +${val}`);
      }
    }

    return lines;
  }, [modifiers]);

  // Consumable summary
  const consumables = useMemo(() => {
    return Object.entries(modulesState.consumables)
      .filter(([, count]) => count > 0)
      .map(([id, count]) => {
        const def = getItemDef(id);
        return { id, name: def?.name ?? id, count, stackMax: def?.stackMax ?? 99 };
      });
  }, [modulesState.consumables]);

  return (
    <div className="loadout-panel__backdrop" onClick={onClose}>
      <div className="loadout-panel" onClick={(e) => e.stopPropagation()}>
        <div className="loadout-panel__header">
          <div className="loadout-panel__title">Loadout</div>
          <button className="loadout-panel__close" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Modifier summary */}
        {modSummary.length > 0 && (
          <div className="loadout-panel__mods">
            <div className="loadout-panel__mods-title">Active Effects</div>
            <div className="loadout-panel__mods-list">
              {modSummary.map((line, i) => (
                <span key={i} className="loadout-panel__mod-tag">
                  {line}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Slots */}
        <div className="loadout-panel__slots">
          {slotsWithContent.length === 0 ? (
            <div className="loadout-panel__empty">
              No modules. Craft modules to equip them here.
            </div>
          ) : (
            slotsWithContent.map((slot) => {
              const equippedId = modulesState.equipped[slot] ?? null;
              const equippedDef = equippedId ? getItemDef(equippedId) : null;
              const owned = ownedBySlot[slot] ?? [];

              return (
                <div key={slot} className="loadout-panel__slot">
                  <div className="loadout-panel__slot-label">
                    {SLOT_LABELS[slot]}
                  </div>

                  {equippedDef ? (
                    <div className="loadout-panel__equipped">
                      <span className="loadout-panel__equipped-name">
                        {equippedDef.name}
                      </span>
                      <button
                        className="loadout-panel__unequip-btn"
                        onClick={() => unequipModule(slot)}
                      >
                        Unequip
                      </button>
                    </div>
                  ) : (
                    <div className="loadout-panel__empty-slot">— empty —</div>
                  )}

                  {/* Owned alternatives */}
                  {owned
                    .filter((d) => d.id !== equippedId)
                    .map((d) => (
                      <div key={d.id} className="loadout-panel__alt">
                        <span className="loadout-panel__alt-name">
                          {d.name}
                        </span>
                        <button
                          className="loadout-panel__equip-btn"
                          onClick={() => equipModule(d.id)}
                        >
                          Equip
                        </button>
                      </div>
                    ))}
                </div>
              );
            })
          )}
        </div>

        {/* Consumables */}
        {consumables.length > 0 && (
          <>
            <div className="loadout-panel__section-title">Consumables</div>
            <div className="loadout-panel__consumables">
              {consumables.map((c) => (
                <div key={c.id} className="loadout-panel__consumable">
                  <span className="loadout-panel__consumable-name">
                    {c.name}
                  </span>
                  <span className="loadout-panel__consumable-count">
                    {c.count}/{c.stackMax}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Hotbar info */}
        <div className="loadout-panel__hotbar-info">
          Consumables can be used via hotbar keys 0–9
        </div>
      </div>
    </div>
  );
}
