"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { modulesAtom, useConsumableAtom } from "@/store/modules";
import { heatSinkBuffer, miningStateAtom } from "@/store/mining";
import { shipHealthAtom } from "@/store/store";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { addTimedEffectAtom } from "@/store/timedEffects";
import { addToastAtom } from "@/store/toast";
import { getItemDef, getItemIconUrl, type ItemDef } from "@/data/content";

import "./Hotbar.scss";

/** Returns true if this item requires heat to be usable. */
function requiresHeat(def: ItemDef): boolean {
  return !!def.useEffects?.some((e) => e.key === "mining.currentHeat");
}

/** Returns true if this consumable has a timed duration. */
function isTimedConsumable(def: ItemDef): boolean {
  return !!def.useDurationS && def.useDurationS > 0;
}

/** Returns true if this consumable is an information tool (no useEffects, has duration). */
function isInfoConsumable(def: ItemDef): boolean {
  return !def.useEffects && !!def.useDurationS;
}

export default function Hotbar() {
  const modulesState = useAtomValue(modulesAtom);
  const miningState = useAtomValue(miningStateAtom);
  const shipHealth = useAtomValue(shipHealthAtom);
  const shipConfig = useAtomValue(effectiveShipConfigAtom);
  const useConsumable = useSetAtom(useConsumableAtom);
  const setShipHealth = useSetAtom(shipHealthAtom);
  const addTimedEffect = useSetAtom(addTimedEffectAtom);
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

      // Block heat-related consumables when there's no heat
      if (requiresHeat(def) && miningState.laserHeat <= 0) {
        addToast({ message: "No heat to reduce", durationMs: 1500 });
        return;
      }

      // Block hull repair when at full health
      if (def.useEffects?.some((e) => e.key === "ship.currentHealth") && shipHealth >= shipConfig.maxHealth) {
        addToast({ message: "Hull already at full integrity", durationMs: 1500 });
        return;
      }

      // Information consumables — stub: show toast, consume item
      if (isInfoConsumable(def)) {
        const ok = useConsumable(itemId);
        if (ok) {
          addToast({ message: `Activated: ${def.name} (${def.useDurationS}s)`, durationMs: 3000 });
        }
        return;
      }

      const ok = useConsumable(itemId);
      if (ok) {
        // Timed consumables: add to timed effects system
        if (isTimedConsumable(def) && def.useEffects) {
          addTimedEffect({
            itemId,
            effects: def.useEffects,
            durationS: def.useDurationS!,
          });
          addToast({ message: `Activated: ${def.name} (${def.useDurationS}s)`, durationMs: 2000 });
          return;
        }

        // Instant effects
        if (def.useEffects) {
          for (const eff of def.useEffects) {
            if (eff.key === "mining.currentHeat") {
              if (eff.op === "set") {
                heatSinkBuffer.pendingSet = eff.value as number;
              } else if (eff.op === "multiply") {
                heatSinkBuffer.pendingMultiplier = eff.value as number;
              } else if (eff.op === "add") {
                heatSinkBuffer.pendingAdd = eff.value as number;
              }
            } else if (eff.key === "ship.currentHealth") {
              if (eff.op === "add") {
                const newHealth = Math.min(shipConfig.maxHealth, shipHealth + (eff.value as number));
                setShipHealth(newHealth);
              }
            }
          }
        }
        addToast({ message: `Used: ${def.name}`, durationMs: 2000 });
      }
    },
    [modulesState.hotbar, miningState.laserHeat, shipHealth, shipConfig.maxHealth, useConsumable, setShipHealth, addTimedEffect, addToast],
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
          if (elapsed >= 0 && elapsed < def.cooldownS) {
            onCooldown = true;
            cooldownRemaining = Math.ceil(def.cooldownS - elapsed);
            cooldownFraction = 1 - elapsed / def.cooldownS;
          }
        }

        // Gray out items that can't be used right now
        const heatUnavailable = hasItem && requiresHeat(def) && miningState.laserHeat <= 0;
        const healthUnavailable = hasItem && !!def.useEffects?.some((e) => e.key === "ship.currentHealth") && shipHealth >= shipConfig.maxHealth;
        const unavailable = heatUnavailable || healthUnavailable;

        return (
          <div
            key={index}
            className={`hotbar__slot ${hasItem ? "hotbar__slot--filled" : ""} ${
              onCooldown ? "hotbar__slot--cooldown" : ""
            } ${unavailable ? "hotbar__slot--unavailable" : ""}`}
            onClick={hasItem && !onCooldown && !unavailable ? () => activateSlot(index) : undefined}
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
