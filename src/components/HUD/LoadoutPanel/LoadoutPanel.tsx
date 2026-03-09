"use client";

import { useAtomValue } from "jotai";
import { useMemo } from "react";

import { modulesAtom } from "@/store/modules";
import { getItemDef, describeEffect } from "@/data/content";

import "./LoadoutPanel.scss";

export default function LoadoutPanel({ onClose }: { onClose: () => void }) {
  const modulesState = useAtomValue(modulesAtom);

  // Owned modules with their defs
  const ownedModules = useMemo(() => {
    return modulesState.ownedModules
      .map((id) => getItemDef(id))
      .filter(Boolean) as NonNullable<ReturnType<typeof getItemDef>>[];
  }, [modulesState.ownedModules]);

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
          <div className="loadout-panel__title">Ship Modules</div>
          <button className="loadout-panel__close" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Installed modules */}
        <div className="loadout-panel__modules">
          {ownedModules.length === 0 ? (
            <div className="loadout-panel__empty">
              No modules installed. Craft modules to upgrade your ship.
            </div>
          ) : (
            ownedModules.map((def) => (
              <div key={def.id} className="loadout-panel__module">
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
