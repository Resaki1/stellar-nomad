"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  modulesAtom,
  useConsumableAtom,
  setHotbarSlotAtom,
  HOTBAR_DRAG_MIME,
  HOTBAR_SOURCE_SLOT_MIME,
} from "@/store/modules";
import { heatSinkBuffer, miningStateAtom } from "@/store/mining";
import { shipHealthAtom } from "@/store/store";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { addTimedEffectAtom } from "@/store/timedEffects";
import { addToastAtom } from "@/store/toast";
import { getItemDef, getItemIconUrl, type ItemDef } from "@/data/content";

import ContextMenu, { type ContextMenuItem } from "../ContextMenu/ContextMenu";

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
  const setHotbarSlot = useSetAtom(setHotbarSlotAtom);

  // Tick counter to force re-render while any cooldown is active
  const [, setTick] = useState(0);
  const rafRef = useRef<number | null>(null);

  // DnD + right-click UI state
  const [dragOverSlot, setDragOverSlot] = useState<number | null>(null);
  const [justAssignedSlot, setJustAssignedSlot] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);

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

  // Clear the "just assigned" pulse class after the animation finishes
  useEffect(() => {
    if (justAssignedSlot === null) return;
    const id = window.setTimeout(() => setJustAssignedSlot(null), 800);
    return () => clearTimeout(id);
  }, [justAssignedSlot]);

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

  // ── Drag-and-drop wiring ─────────────────────────────────────────
  const hasConsumableDragType = (dt: DataTransfer): boolean => {
    for (const t of dt.types) {
      if (t === HOTBAR_DRAG_MIME || t === HOTBAR_SOURCE_SLOT_MIME) return true;
    }
    return false;
  };

  const onSlotDragEnter = (e: React.DragEvent<HTMLDivElement>, index: number) => {
    if (!hasConsumableDragType(e.dataTransfer)) return;
    e.preventDefault();
    setDragOverSlot(index);
  };

  const onSlotDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasConsumableDragType(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const onSlotDragLeave = (_e: React.DragEvent<HTMLDivElement>, index: number) => {
    setDragOverSlot((prev) => (prev === index ? null : prev));
  };

  const onSlotDrop = (e: React.DragEvent<HTMLDivElement>, index: number) => {
    setDragOverSlot(null);
    const itemId =
      e.dataTransfer.getData(HOTBAR_DRAG_MIME) ||
      e.dataTransfer.getData("text/plain");
    if (!itemId) return;
    e.preventDefault();
    const def = getItemDef(itemId);
    if (!def || def.type !== "consumable") return;
    setHotbarSlot({ index, itemId });
    setJustAssignedSlot(index);
    document.body.classList.remove("sn-dragging-consumable");
  };

  const onSlotDragStart = (e: React.DragEvent<HTMLDivElement>, index: number, itemId: string) => {
    e.dataTransfer.setData(HOTBAR_DRAG_MIME, itemId);
    e.dataTransfer.setData(HOTBAR_SOURCE_SLOT_MIME, String(index));
    e.dataTransfer.setData("text/plain", itemId);
    e.dataTransfer.effectAllowed = "move";
    document.body.classList.add("sn-dragging-consumable");
  };

  const onSlotDragEnd = () => {
    document.body.classList.remove("sn-dragging-consumable");
    setDragOverSlot(null);
  };

  const onSlotContextMenu = (e: React.MouseEvent, index: number) => {
    // Only useful on filled slots
    if (!modulesState.hotbar[index]) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, index });
  };

  const buildSlotMenu = (index: number): ContextMenuItem[] => {
    const itemId = modulesState.hotbar[index];
    if (!itemId) return [];
    const def = getItemDef(itemId);
    const items: ContextMenuItem[] = [];

    items.push({
      label: "Use",
      hint: String(index),
      disabled: (() => {
        if (!def) return true;
        if (requiresHeat(def) && miningState.laserHeat <= 0) return true;
        if (def.useEffects?.some((e) => e.key === "ship.currentHealth") && shipHealth >= shipConfig.maxHealth) return true;
        const cdS = def.cooldownS ?? 0;
        if (cdS > 0) {
          const last = modulesState.consumableCooldowns[itemId] ?? 0;
          if ((performance.now() - last) / 1000 < cdS) return true;
        }
        return false;
      })(),
      onSelect: () => activateSlot(index),
    });

    items.push({
      separator: true,
      label: "Clear slot",
      onSelect: () => setHotbarSlot({ index, itemId: null }),
    });

    return items;
  };

  // Only show hotbar if there are consumables
  const hasConsumables = useMemo(
    () => Object.values(modulesState.consumables).some((c) => c > 0),
    [modulesState.consumables],
  );

  if (!hasConsumables) return null;

  const now = performance.now();

  return (
    <>
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

          const remainingAngle = `${cooldownFraction * 360}deg`;
          const isDragOver = dragOverSlot === index;
          const justAssigned = justAssignedSlot === index;

          const slotClass = [
            "hotbar__slot",
            hasItem && "hotbar__slot--filled",
            !hasItem && "hotbar__slot--empty",
            onCooldown && "hotbar__slot--cooldown",
            unavailable && "hotbar__slot--unavailable",
            isDragOver && "hotbar__slot--drag-over",
            justAssigned && "hotbar__slot--just-assigned",
          ].filter(Boolean).join(" ");

          return (
            <div
              key={index}
              className={slotClass}
              onClick={hasItem && !onCooldown && !unavailable ? () => activateSlot(index) : undefined}
              onContextMenu={(e) => onSlotContextMenu(e, index)}
              draggable={!!hasItem}
              onDragStart={hasItem ? (e) => onSlotDragStart(e, index, itemId!) : undefined}
              onDragEnd={onSlotDragEnd}
              onDragEnter={(e) => onSlotDragEnter(e, index)}
              onDragOver={onSlotDragOver}
              onDragLeave={(e) => onSlotDragLeave(e, index)}
              onDrop={(e) => onSlotDrop(e, index)}
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
                  {onCooldown && (
                    <>
                      <div
                        className="hotbar__cooldown-wipe"
                        style={{ ["--cooldown-deg" as string]: remainingAngle }}
                      />
                      {cooldownRemaining >= 1 && (
                        <span className="hotbar__cooldown-text">{cooldownRemaining}s</span>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={(() => {
            const id = modulesState.hotbar[menu.index];
            return id ? (getItemDef(id)?.name ?? `Slot ${menu.index}`) : `Slot ${menu.index}`;
          })()}
          items={buildSlotMenu(menu.index)}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
