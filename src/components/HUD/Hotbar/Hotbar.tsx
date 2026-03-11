"use client";

import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useEffect, useRef, useMemo } from "react";

import { modulesAtom, useConsumableAtom, setHotbarSlotAtom } from "@/store/modules";
import { miningStateAtom } from "@/store/mining";
import { addToastAtom } from "@/store/toast";
import { getItemDef, getItemIconUrl } from "@/data/content";

import "./Hotbar.scss";

export default function Hotbar() {
  const modulesState = useAtomValue(modulesAtom);
  const miningState = useAtomValue(miningStateAtom);
  const useConsumable = useSetAtom(useConsumableAtom);
  const addToast = useSetAtom(addToastAtom);
  const store = useStore();

  // Handle key presses 0-9 for hotbar
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const key = e.key;
      if (key >= "0" && key <= "9") {
        const index = parseInt(key, 10);
        const itemId = modulesState.hotbar[index];
        if (!itemId) return;

        const def = getItemDef(itemId);
        if (!def) return;

        // Apply consumable use effects
        const ok = useConsumable(itemId);
        if (ok) {
          // Apply instant effects
          if (def.useEffects) {
            for (const eff of def.useEffects) {
              if (eff.key === "mining.currentHeat" && eff.op === "multiply") {
                // Directly modify mining state heat
                const ms = store.get(miningStateAtom);
                store.set(miningStateAtom, {
                  ...ms,
                  laserHeat: ms.laserHeat * (eff.value as number),
                  isOverheated: ms.laserHeat * (eff.value as number) < 1 ? false : ms.isOverheated,
                });
              }
            }
          }
          addToast({ message: `Used: ${def.name}`, durationMs: 2000 });
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [modulesState.hotbar, useConsumable, addToast, store]);

  // Only show hotbar if there are consumables
  const hasConsumables = useMemo(
    () => Object.values(modulesState.consumables).some((c) => c > 0),
    [modulesState.consumables],
  );

  if (!hasConsumables) return null;

  return (
    <div className="hotbar">
      {modulesState.hotbar.map((itemId, index) => {
        const def = itemId ? getItemDef(itemId) : null;
        const count = itemId ? (modulesState.consumables[itemId] ?? 0) : 0;
        const hasItem = def && count > 0;

        // Check cooldown
        let onCooldown = false;
        if (itemId && def?.cooldownS) {
          const lastUse = modulesState.consumableCooldowns[itemId] ?? 0;
          const elapsed = (performance.now() - lastUse) / 1000;
          onCooldown = elapsed < def.cooldownS;
        }

        return (
          <div
            key={index}
            className={`hotbar__slot ${hasItem ? "hotbar__slot--filled" : ""} ${
              onCooldown ? "hotbar__slot--cooldown" : ""
            }`}
          >
            <span className="hotbar__key">{index}</span>
            {hasItem && (
              <>
                <img
                  className="hotbar__icon"
                  src={getItemIconUrl(def)}
                  alt={def.name}
                />
                <span className="hotbar__count">×{count}</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
