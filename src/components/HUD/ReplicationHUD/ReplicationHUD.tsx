"use client";

import { useCallback, useEffect } from "react";
import { useAtomValue, useStore } from "jotai";
import { keybindsAtom } from "@/store/keybinds";
import { settingsIsOpenAtom } from "@/store/store";
import { depotPlacementAtom, industryPanelOpenAtom } from "@/store/industryHud";
import { isDeadAtom } from "@/store/death";
import { playAudio } from "@/audio";
import { isTypingTarget } from "@/input/keyboard";
import {
  placePointAtom,
  placementModeAtom,
  placementNameAtom,
  replicationPointsAtom,
  updateNearbyPoint,
  updatePlacementPreview,
} from "@/store/replication";

const HUD_RATE_MS = 100;

/** Enter placement with a fresh default name (the card selects it, so typing replaces it). */
export function togglePlacement(store: ReturnType<typeof useStore>): void {
  const on = !store.get(placementModeAtom);
  if (on) store.set(placementNameAtom, `Point ${store.get(replicationPointsAtom).length}`);
  store.set(placementModeAtom, on);
}

/**
 * Placement mode keys (the kit's hotbar slot opens it; the preview is the Target Card in
 * NEW POINT mode). Pointer lock stays engaged: mouse-look keeps aiming the position.
 */
export default function ReplicationHUD() {
  const store = useStore();
  const mode = useAtomValue(placementModeAtom);
  const dead = useAtomValue(isDeadAtom);

  // Read models at HUD rate (not per frame): preview check and the nearby point.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (store.get(placementModeAtom)) updatePlacementPreview(store);
      updateNearbyPoint(store);
    }, HUD_RATE_MS);
    return () => window.clearInterval(id);
  }, [store]);

  useEffect(() => {
    if (mode) updatePlacementPreview(store);
  }, [mode, store]);

  const confirm = useCallback(() => {
    const o = store.set(placePointAtom, { name: store.get(placementNameAtom).trim() || "Point" });
    if (o.status === "rejected") playAudio("ui.reject");
  }, [store]);

  useEffect(() => {
    // Capture phase: Esc while placing cancels placement only (it must not open Settings).
    const onKeyDown = (e: KeyboardEvent): void => {
      if (store.get(settingsIsOpenAtom) || store.get(isDeadAtom) || store.get(industryPanelOpenAtom) || store.get(depotPlacementAtom)) return;
      const key = e.key.toLowerCase();
      const placing = store.get(placementModeAtom);
      if (placing && key === "escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        store.set(placementModeAtom, false);
        return;
      }
      if (placing && key === "enter") {
        e.preventDefault();
        confirm();
        return;
      }
      if (isTypingTarget(e.target)) return;
      if (store.get(keybindsAtom).placePoint.includes(key)) togglePlacement(store);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [store, confirm]);

  useEffect(() => {
    if (dead) store.set(placementModeAtom, false);
  }, [dead, store]);
  return null;
}
