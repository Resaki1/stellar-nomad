"use client";

import { useAtomValue, useSetAtom, useStore } from "jotai";
import { hullRepairable } from "@/sim/ship/hull";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  modulesAtom,
  useConsumableAtom,
  setHotbarSlotAtom,
  HOTBAR_DRAG_MIME,
  HOTBAR_SOURCE_SLOT_MIME,
} from "@/store/modules";
import { miningStateAtom } from "@/store/mining";
import { hudHiddenAtom, settingsIsOpenAtom, shipHealthAtom } from "@/store/store";
import { isDeadAtom } from "@/store/death";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { addTimedEffectAtom } from "@/store/timedEffects";
import { addToastAtom } from "@/store/toast";
import { signalAudioActionAtom, type AudioAction } from "@/store/audioSignals";
import { getItemDef, getItemIconUrl, type ItemDef } from "@/data/content";
import { isTypingTarget } from "@/input/keyboard";
import { REPLICATION_KIT_ID } from "@/sim/replication/points";
import { placementModeAtom, pointPlacementPendingAtom } from "@/store/replication";
import { DEPOT_KIT_ID } from "@/sim/industry/catalog";
import { industryAtom } from "@/store/industry";
import { cancelDepotPlacementAtom, depotPlacementAtom, depotPlacementPendingAtom, industryPanelOpenAtom, nextDepotName, startDepotPlacementAtom } from "@/store/industryHud";
import { togglePlacement } from "../ReplicationHUD/ReplicationHUD";

import ContextMenu, { type ContextMenuItem } from "../ContextMenu/ContextMenu";

import "./Hotbar.scss";

/** D8: slot i is key `(i + 1) % 10`, so the labels read 1…9, 0 like the keyboard. */
export const slotKey = (index: number): string => String((index + 1) % 10);
const slotOfKey = (key: string): number => (key === "0" ? 9 : Number(key) - 1);
const PLACEMENT_KITS = [REPLICATION_KIT_ID, DEPOT_KIT_ID] as const;

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
  const store = useStore();
  const modulesState = useAtomValue(modulesAtom);
  const placing = useAtomValue(placementModeAtom);
  const placingDepot = useAtomValue(depotPlacementAtom);
  const miningState = useAtomValue(miningStateAtom);
  const shipHealth = useAtomValue(shipHealthAtom);
  const shipConfig = useAtomValue(effectiveShipConfigAtom);
  // Plain action dispatcher, not a hook — named without the `use` prefix so
  // rules-of-hooks doesn't flag calls from inside callbacks.
  const consumeItem = useSetAtom(useConsumableAtom);
  const addTimedEffect = useSetAtom(addTimedEffectAtom);
  const addToast = useSetAtom(addToastAtom);
  const signalAudio = useSetAtom(signalAudioActionAtom);
  const setHotbarSlot = useSetAtom(setHotbarSlotAtom);

  const [now, setNow] = useState(Date.now);

  // DnD + right-click UI state
  const [dragOverSlot, setDragOverSlot] = useState<number | null>(null);
  const [justAssignedSlot, setJustAssignedSlot] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);

  const cooldownEnd = useMemo(() => modulesState.hotbar.reduce((end, id) => {
    if (!id) return end;
    const duration = getItemDef(id)?.cooldownS ?? 0;
    return Math.max(end, (modulesState.consumableCooldowns[id] ?? 0) + duration * 1000);
  }, 0), [modulesState.hotbar, modulesState.consumableCooldowns]);

  useEffect(() => {
    if (cooldownEnd <= Date.now()) return;
    const timer = window.setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= cooldownEnd) clearInterval(timer);
    }, 100);
    return () => clearInterval(timer);
  }, [cooldownEnd]);

  // Make a newly acquired kit available from the hotbar, including when a save is loaded.
  // Removing the slot manually sticks until another kit arrives.
  const prevKits = useRef<Record<string, number>>({});
  useEffect(() => {
    const freeSlots = modulesState.hotbar.flatMap((id, index) => id === null ? [index] : []);
    for (const itemId of PLACEMENT_KITS) {
      const count = modulesState.consumables[itemId] ?? 0;
      const arrived = count > (prevKits.current[itemId] ?? 0);
      prevKits.current[itemId] = count;
      if (!arrived || modulesState.hotbar.includes(itemId)) continue;
      const index = freeSlots.shift();
      if (index !== undefined) setHotbarSlot({ index, itemId });
      else addToast({ kind: "warn", message: "Hotbar full", values: [{ id: itemId }] });
    }
  }, [modulesState.consumables, modulesState.hotbar, setHotbarSlot, addToast]);

  // Clear the "just assigned" pulse class after the animation finishes
  useEffect(() => {
    if (justAssignedSlot === null) return;
    const id = window.setTimeout(() => setJustAssignedSlot(null), 800);
    return () => clearTimeout(id);
  }, [justAssignedSlot]);

  // Activate a hotbar slot by index
  const activateSlot = useCallback(
    (index: number) => {
      if (store.get(settingsIsOpenAtom) || store.get(industryPanelOpenAtom) || store.get(isDeadAtom)) return;
      const { hotbar, consumables } = store.get(modulesAtom);
      const itemId = hotbar[index];
      const aimingDepot = store.get(depotPlacementAtom);
      const def = itemId ? getItemDef(itemId) : null;
      // An empty slot's key did nothing; say so rather than drop the input.
      if (!itemId || !def) {
        signalAudio("ui.reject");
        return;
      }

      if (itemId === DEPOT_KIT_ID) {
        if (aimingDepot) store.set(cancelDepotPlacementAtom);
        else if ((consumables[itemId] ?? 0) > 0 && !store.get(depotPlacementPendingAtom) && !store.get(pointPlacementPendingAtom)) {
          store.set(placementModeAtom, false);
          store.set(hudHiddenAtom, false);
          store.set(startDepotPlacementAtom, nextDepotName(store.get(industryAtom).depots), false);
        } else signalAudio("ui.reject");
        return;
      }

      // D16: the replication kit's slot opens (or closes) placement; placing consumes it.
      if (def.deployable) {
        if ((consumables[itemId] ?? 0) > 0 || store.get(placementModeAtom)) togglePlacement(store);
        else signalAudio("ui.reject");
        return;
      }

      if (aimingDepot) return;

      // The command samples live hull and heat. HUD values are refreshed less frequently.
      consumeItem({ itemId, onSettled(outcome) {
        if (outcome.status !== "accepted") {
          if (outcome.status === "rejected" && outcome.reason === "full_hull") {
            addToast({ audio: "reject", kind: "warn", message: "Hull intact" });
          } else if (outcome.status === "rejected" && outcome.reason === "already_done" && requiresHeat(def)) {
            addToast({ audio: "reject", kind: "warn", message: "Heat already low" });
          } else signalAudio("ui.reject");
          return;
        }
        if (isInfoConsumable(def)) {
          addToast({ message: "Used", values: [{ id: itemId }] });
          return;
        }
        // Timed consumables: add to timed effects system
        if (isTimedConsumable(def) && def.useEffects) {
          addTimedEffect({
            itemId,
            effects: def.useEffects,
            durationS: def.useDurationS!,
          });
          addToast({ message: "Used", values: [{ id: itemId }] });
          return;
        }

        // Instant effects. Each kind is a physical event aboard — a coolant
        // dump or a hull patch — so it gets that sound instead of a UI chime.
        let cue: AudioAction | null = null;
        if (def.useEffects) {
          for (const eff of def.useEffects) {
            if (eff.key === "mining.currentHeat") {
              cue = eff.op === "set" ? "mining.purge.vent" : "mining.heatsink.vent";
            } else if (eff.key === "ship.currentHealth") {
              cue = "ship.hull.repair";
            }
          }
        }
        if (cue) signalAudio(cue);
        addToast({ message: "Used", values: [{ id: itemId }], audio: cue ? "silent" : undefined });
      } });
    },
    [store, consumeItem, addTimedEffect, addToast, signalAudio],
  );

  // Keys 1…9 then 0 (names with digits are typed, never activate a slot).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || e.repeat ||
          store.get(settingsIsOpenAtom) || store.get(industryPanelOpenAtom)) return;
      const key = e.key;
      if (key.length === 1 && key >= "0" && key <= "9") {
        e.preventDefault();
        activateSlot(slotOfKey(key));
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activateSlot, store]);

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
    signalAudio("click.soft");
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
      hint: slotKey(index),
      disabled: (() => {
        if (!def) return true;
        if (requiresHeat(def) && miningState.laserHeat <= 0) return true;
        if (def.useEffects?.some((e) => e.key === "ship.currentHealth") && !hullRepairable(shipHealth, shipConfig.maxHealth)) return true;
        const cdS = def.cooldownS ?? 0;
        if (cdS > 0) {
          const last = modulesState.consumableCooldowns[itemId] ?? 0;
          if ((Date.now() - last) / 1000 < cdS) return true;
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
          const healthUnavailable = hasItem && !!def.useEffects?.some((e) => e.key === "ship.currentHealth") && !hullRepairable(shipHealth, shipConfig.maxHealth);
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
            (itemId === DEPOT_KIT_ID ? placingDepot : itemId === REPLICATION_KIT_ID && placing) && "hotbar__slot--active",
          ].filter(Boolean).join(" ");

          return (
            <div
              key={index}
              className={slotClass}
              // Greyed and cooling slots still answer a click: activateSlot explains
              // "no heat" / "hull full" with a reject toast, cooldown rejects directly.
              onClick={hasItem ? () => (onCooldown ? signalAudio("ui.reject") : activateSlot(index)) : undefined}
              onContextMenu={(e) => onSlotContextMenu(e, index)}
              draggable={!!hasItem}
              onDragStart={hasItem ? (e) => onSlotDragStart(e, index, itemId!) : undefined}
              onDragEnd={onSlotDragEnd}
              onDragEnter={(e) => onSlotDragEnter(e, index)}
              onDragOver={onSlotDragOver}
              onDragLeave={(e) => onSlotDragLeave(e, index)}
              onDrop={(e) => onSlotDrop(e, index)}
            >
              <span className="hotbar__key">{slotKey(index)}</span>
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
            return id ? (getItemDef(id)?.name ?? `Slot ${slotKey(menu.index)}`) : `Slot ${slotKey(menu.index)}`;
          })()}
          items={buildSlotMenu(menu.index)}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
