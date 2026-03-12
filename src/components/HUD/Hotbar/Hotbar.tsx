"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { modulesAtom, useConsumableAtom } from "@/store/modules";
import { heatSinkBuffer } from "@/store/mining";
import { addToastAtom } from "@/store/toast";
import { getItemDef, getItemIconUrl } from "@/data/content";

import "./Hotbar.scss";

export default function Hotbar() {
  const modulesState = useAtomValue(modulesAtom);
  const useConsumable = useSetAtom(useConsumableAtom);
  const addToast = useSetAtom(addToastAtom);

  // Tick counter to force re-render while any cooldown is active
  const [, setTick] = useState(0);
  const rafRef = useRef<number | null>(null);

  // Track whether any cooldown is active to drive the rAF loop
  const hasActiveCooldown = useMemo(() => {
    const now = performance.now();
    for (const itemId of modulesState.hotbar) {
      if (!itemId) continue;
      const def = getItemDef(itemId);
      if (!def?.cooldownS) continue;
      const lastUse = modulesState.consumableCooldowns[itemId] ?? 0;
      if ((now - lastUse) / 1000 < def.cooldownS) return true;
    }
    return false;
  }, [modulesState.hotbar, modulesState.consumableCooldowns]);

  // Re-render at ~10 fps while a cooldown is active so the timer updates
  useEffect(() => {
    if (!hasActiveCooldown) return;
    let active = true;
    const loop = () => {
      if (!active) return;
      setTick((t) => t + 1);
      rafRef.current = window.setTimeout(() => {
        if (active) requestAnimationFrame(loop);
      }, 100) as unknown as number;
    };
    requestAnimationFrame(loop);
    return () => {
      active = false;
      if (rafRef.current !== null) clearTimeout(rafRef.current);
    };
  }, [hasActiveCooldown]);

  // Activate a hotbar slot by index
  const activateSlot = useCallback(
    (index: number) => {
      const itemId = modulesState.hotbar[index];
      if (!itemId) return;

      const def = getItemDef(itemId);
      if (!def) return;

      const ok = useConsumable(itemId);
      if (ok) {
        // Apply instant effects via shared buffer
        if (def.useEffects) {
          for (const eff of def.useEffects) {
            if (eff.key === "mining.currentHeat") {
              if (eff.op === "multiply") {
                heatSinkBuffer.pendingMultiplier = eff.value as number;
              } else if (eff.op === "add") {
                heatSinkBuffer.pendingAdd = eff.value as number;
              }
            }
          }
        }
        addToast({ message: `Used: ${def.name}`, durationMs: 2000 });
      }
    },
    [modulesState.hotbar, useConsumable, addToast],
  );

  // Handle key presses 0-9 for hotbar
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const key = e.key;
      if (key >= "0" && key <= "9") {
        activateSlot(parseInt(key, 10));
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activateSlot]);

  // Only show hotbar if there are consumables
  const hasConsumables = useMemo(
    () => Object.values(modulesState.consumables).some((c) => c > 0),
    [modulesState.consumables],
  );

  if (!hasConsumables) return null;

  const now = performance.now();

  return (
    <div className="hotbar">
      {modulesState.hotbar.map((itemId, index) => {
        const def = itemId ? getItemDef(itemId) : null;
        const count = itemId ? (modulesState.consumables[itemId] ?? 0) : 0;
        const hasItem = def && count > 0;

        // Check cooldown
        let onCooldown = false;
        let cooldownFraction = 0;
        let cooldownRemaining = 0;
        if (itemId && def?.cooldownS) {
          const lastUse = modulesState.consumableCooldowns[itemId] ?? 0;
          const elapsed = (now - lastUse) / 1000;
          if (elapsed < def.cooldownS) {
            onCooldown = true;
            cooldownRemaining = Math.ceil(def.cooldownS - elapsed);
            cooldownFraction = 1 - elapsed / def.cooldownS;
          }
        }

        return (
          <div
            key={index}
            className={`hotbar__slot ${hasItem ? "hotbar__slot--filled" : ""} ${
              onCooldown ? "hotbar__slot--cooldown" : ""
            }`}
            onClick={hasItem && !onCooldown ? () => activateSlot(index) : undefined}
          >
            <span className="hotbar__key">{index}</span>
            {hasItem && (
              <>
                <img
                  className="hotbar__icon"
                  src={getItemIconUrl(def)}
                  alt={def.name}
                />
                {onCooldown ? (
                  <>
                    <div
                      className="hotbar__cooldown-fill"
                      style={{ height: `${cooldownFraction * 100}%` }}
                    />
                    <span className="hotbar__cooldown-text">{cooldownRemaining}s</span>
                  </>
                ) : (
                  <span className="hotbar__count">×{count}</span>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
