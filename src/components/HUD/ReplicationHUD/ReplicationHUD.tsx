"use client";

import { useEffect } from "react";
import { useAtomValue, useStore } from "jotai";
import { keybindsAtom } from "@/store/keybinds";
import { hudHiddenAtom, settingsIsOpenAtom } from "@/store/store";
import { depotPlacementAtom, industryPanelOpenAtom } from "@/store/industryHud";
import { isDeadAtom } from "@/store/death";
import { playAudio } from "@/audio";
import { isTypingTarget } from "@/input/keyboard";
import {
  placePointAtom,
  placementModeAtom,
  placementNameAtom,
  placementStatusAtom,
  replicationPointsAtom,
  updateNearbyPoint,
  updatePlacementPreview,
} from "@/store/replication";
import { handlePlacementKey, usePlacementEscapeLock } from "../shared/PlacementControls";

const HUD_RATE_MS = 100;

/** Enter placement with a fresh default name, which can be edited on the card. */
export function togglePlacement(store: ReturnType<typeof useStore>): void {
  const on = !store.get(placementModeAtom);
  if (on) {
    store.set(hudHiddenAtom, false);
    store.set(placementNameAtom, `Point ${store.get(replicationPointsAtom).length}`);
    store.set(placementStatusAtom, null);
  }
  store.set(placementModeAtom, on);
}

/** Confirm the live preview from either the keyboard or the placement button. */
export function confirmPointPlacement(store: ReturnType<typeof useStore>): void {
  if (!store.get(placementModeAtom) || store.get(settingsIsOpenAtom) || store.get(isDeadAtom)) return;
  updatePlacementPreview(store);
  const outcome = store.set(placePointAtom, { name: store.get(placementNameAtom).trim() || "Point" });
  if (outcome.status === "rejected") playAudio("ui.reject");
}

/**
 * Placement mode keys (the kit's hotbar slot opens it; the preview is the Target Card in
 * NEW POINT mode). Pointer lock stays engaged: mouse-look keeps aiming the position.
 */
export default function ReplicationHUD() {
  const store = useStore();
  const mode = useAtomValue(placementModeAtom);
  const aimingDepot = useAtomValue(depotPlacementAtom);
  const dead = useAtomValue(isDeadAtom);
  const menu = useAtomValue(settingsIsOpenAtom);
  usePlacementEscapeLock(!dead && !menu && (mode || !!aimingDepot));

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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (store.get(settingsIsOpenAtom) || store.get(isDeadAtom) || store.get(industryPanelOpenAtom) || store.get(depotPlacementAtom)) return;
      const binds = store.get(keybindsAtom);
      if (store.get(placementModeAtom) && handlePlacementKey(
        e, binds.toggleSettings, () => store.set(placementModeAtom, false), () => confirmPointPlacement(store),
      )) return;
      if (isTypingTarget(e.target) || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (binds.placePoint.includes(e.key.toLowerCase())) togglePlacement(store);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [store]);

  useEffect(() => {
    if (dead || menu) store.set(placementModeAtom, false);
  }, [dead, menu, store]);
  return null;
}
