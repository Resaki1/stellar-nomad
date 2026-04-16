"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useMemo } from "react";

import { modulesAtom, equipModuleAtom, unequipSlotAtom } from "@/store/modules";
import {
  getItemDef,
  getItemIconUrl,
  describeEffect,
  ALL_ITEM_SLOTS,
  SLOT_LABELS,
  type ItemSlot,
  type ItemDef,
} from "@/data/content";

import "./LoadoutPanel.scss";

export default function LoadoutPanel({ onClose }: { onClose: () => void }) {
  const modulesState = useAtomValue(modulesAtom);
  const equipModule = useSetAtom(equipModuleAtom);
  const unequipSlot = useSetAtom(unequipSlotAtom);

  // Group owned modules by slot, with equipped state
  const slotData = useMemo(() => {
    const result: {
      slot: ItemSlot;
      label: string;
      equippedId: string | undefined;
      equippedDef: ItemDef | undefined;
      alternatives: { id: string; def: ItemDef }[];
    }[] = [];

    for (const slot of ALL_ITEM_SLOTS) {
      // Skip utility — only has one module and consumables live elsewhere
      const modulesInSlot = modulesState.ownedModules
        .map((id) => ({ id, def: getItemDef(id) }))
        .filter((m): m is { id: string; def: ItemDef } =>
          !!m.def && m.def.type === "module" && m.def.slot === slot
        );

      if (modulesInSlot.length === 0) continue;

      const equippedId = modulesState.equippedModules[slot];
      const equippedDef = equippedId ? getItemDef(equippedId) : undefined;
      const alternatives = modulesInSlot.filter((m) => m.id !== equippedId);

      result.push({
        slot,
        label: SLOT_LABELS[slot],
        equippedId,
        equippedDef: equippedDef as ItemDef | undefined,
        alternatives,
      });
    }

    return result;
  }, [modulesState.ownedModules, modulesState.equippedModules]);

  // Consumable summary
  const consumables = useMemo(() => {
    return Object.entries(modulesState.consumables)
      .filter(([, count]) => count > 0)
      .map(([id, count]) => {
        const def = getItemDef(id);
        return { id, name: def?.name ?? id, count, stackMax: def?.stackMax ?? 99, iconUrl: def ? getItemIconUrl(def) : "" };
      });
  }, [modulesState.consumables]);

  const hasModules = slotData.length > 0;

  return (
    <div className="loadout-panel__backdrop" onClick={onClose}>
      <div className="loadout-panel" onClick={(e) => e.stopPropagation()}>
        <div className="loadout-panel__header">
          <div className="loadout-panel__title">Ship Loadout</div>
          <button className="loadout-panel__close" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Equipped modules by slot */}
        <div className="loadout-panel__modules">
          {!hasModules ? (
            <div className="loadout-panel__empty">
              No modules owned. Craft modules to upgrade your ship.
            </div>
          ) : (
            slotData.map(({ slot, label, equippedId, equippedDef, alternatives }) => (
              <div key={slot} className="loadout-panel__slot-group">
                <div className="loadout-panel__slot-label">{label}</div>

                {/* Currently equipped */}
                {equippedDef ? (
                  <div className="loadout-panel__module loadout-panel__module--equipped">
                    <img
                      className="loadout-panel__module-icon"
                      src={getItemIconUrl(equippedDef)}
                      alt=""
                    />
                    <div className="loadout-panel__module-info">
                      <div className="loadout-panel__module-name">
                        {equippedDef.name}
                        <span className="loadout-panel__equipped-tag">Equipped</span>
                      </div>
                      {equippedDef.effects && equippedDef.effects.length > 0 && (
                        <div className="loadout-panel__module-effects">
                          {equippedDef.effects.map((eff, i) => (
                            <span key={i} className="loadout-panel__effect-tag">
                              {describeEffect(eff)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      className="loadout-panel__unequip-btn"
                      onClick={() => unequipSlot(slot)}
                      title="Unequip"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <div className="loadout-panel__module loadout-panel__module--empty">
                    <span className="loadout-panel__empty-slot">No module equipped</span>
                  </div>
                )}

                {/* Alternative modules (owned but not equipped) */}
                {alternatives.map(({ id, def }) => (
                  <div key={id} className="loadout-panel__module loadout-panel__module--alt">
                    <img
                      className="loadout-panel__module-icon"
                      src={getItemIconUrl(def)}
                      alt=""
                    />
                    <div className="loadout-panel__module-info">
                      <div className="loadout-panel__module-name">{def.name}</div>
                      {def.effects && def.effects.length > 0 && (
                        <div className="loadout-panel__module-effects">
                          {def.effects.map((eff, i) => (
                            <span key={i} className="loadout-panel__effect-tag">
                              {describeEffect(eff)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      className="loadout-panel__equip-btn"
                      onClick={() => equipModule(id)}
                    >
                      Equip
                    </button>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

        {/* Consumables */}
        {consumables.length > 0 && (
          <>
            <div className="loadout-panel__section-title">Consumables</div>
            <div className="loadout-panel__consumables">
              {consumables.map((c) => (
                <div key={c.id} className="loadout-panel__consumable">
                  {c.iconUrl && (
                    <img className="loadout-panel__consumable-icon" src={c.iconUrl} alt="" />
                  )}
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
          Consumables can be used via hotbar keys 0-9
        </div>
      </div>
    </div>
  );
}
