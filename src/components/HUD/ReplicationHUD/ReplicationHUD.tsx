"use client";

import { useCallback, useEffect } from "react";
import { useAtom, useAtomValue, useStore } from "jotai";
import { keybindsAtom } from "@/store/keybinds";
import { hudHiddenAtom, settingsIsOpenAtom } from "@/store/store";
import { clearDepotPlacementAtom, depotPlacementAtom, depotPlacementPendingAtom, industryPanelOpenAtom } from "@/store/industryHud";
import { isDeadAtom } from "@/store/death";
import { playAudio } from "@/audio";
import { isTypingTarget } from "@/input/keyboard";
import { REPLICATION_TUNING } from "@/sim/replication/points";
import {
  cancelPointPlacementAtom,
  kitCountAtom,
  placePointAtom,
  placementModeAtom,
  placementNameAtom,
  placementStatusAtom,
  pointPlacementPendingAtom,
  replicationPointsAtom,
  RESOURCE_WARN_KM,
  updateNearbyPoint,
  updatePlacementPreview,
} from "@/store/replication";
import { PlacementCard, usePlacementEscapeLock } from "../shared/PlacementControls";

const HUD_RATE_MS = 100;
type Store = ReturnType<typeof useStore>;

/** Enter placement with a fresh default name, which can be edited on the card. */
export function togglePlacement(store: Store): void {
  if (store.get(pointPlacementPendingAtom) || store.get(depotPlacementPendingAtom)) return;
  if (store.get(placementModeAtom)) {
    store.set(cancelPointPlacementAtom);
    return;
  }

  if (store.get(depotPlacementAtom)) store.set(clearDepotPlacementAtom);
  store.set(hudHiddenAtom, false);
  store.set(placementNameAtom, `Point ${store.get(replicationPointsAtom).length}`);
  store.set(placementStatusAtom, null);
  store.set(placementModeAtom, true);
}

function PointPlacement() {
  const store = useStore();
  const status = useAtomValue(placementStatusAtom);
  const kits = useAtomValue(kitCountAtom);
  const pending = useAtomValue(pointPlacementPendingAtom);
  const [name, setName] = useAtom(placementNameAtom);
  const isActive = useCallback(() => store.get(placementModeAtom), [store]);
  const cancel = useCallback(() => store.set(cancelPointPlacementAtom), [store]);
  const confirm = useCallback(() => {
    if (!store.get(placementModeAtom) || store.get(pointPlacementPendingAtom) || store.get(isDeadAtom) || store.get(settingsIsOpenAtom)) return;
    const name = store.get(placementNameAtom).trim();
    const status = updatePlacementPreview(store);
    if (!name || !status || status.refusal) {
      playAudio("ui.reject");
      return;
    }
    store.set(pointPlacementPendingAtom, true);
    store.set(placePointAtom, { name, onSettled: () => store.set(pointPlacementPendingAtom, false) });
  }, [store]);
  const noFuel = !!status && (status.fuelSourceKm === null || status.fuelSourceKm > RESOURCE_WARN_KM);

  return <PlacementCard kind="point" distanceKm={REPLICATION_TUNING.placeDistanceKm} kits={kits}
    name={name} onNameChange={setName} ready={!!status && !status.refusal} blocked={status?.refusal}
    warning={noFuel ? `No known hydrate source within ${RESOURCE_WARN_KM} km` : undefined} pending={pending}
    isActive={isActive} cancel={cancel} confirm={confirm} />;
}

/** Sample preview and nearby-point checks at HUD rate while mouse-look keeps aiming the pose. */
export default function ReplicationHUD() {
  const store = useStore();
  const mode = useAtomValue(placementModeAtom);
  const aimingDepot = useAtomValue(depotPlacementAtom);
  const dead = useAtomValue(isDeadAtom);
  const menu = useAtomValue(settingsIsOpenAtom);
  usePlacementEscapeLock(!dead && !menu && (mode || !!aimingDepot));

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
      if (e.defaultPrevented || isTypingTarget(e.target) || e.isComposing || e.repeat || e.metaKey || e.ctrlKey || e.altKey ||
          store.get(settingsIsOpenAtom) || store.get(isDeadAtom) || store.get(industryPanelOpenAtom)) return;
      if (store.get(keybindsAtom).placePoint.includes(e.key.toLowerCase())) togglePlacement(store);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store]);

  useEffect(() => {
    if (dead || menu) store.set(placementModeAtom, false);
  }, [dead, menu, store]);

  return mode && !aimingDepot && !dead && !menu ? <PointPlacement /> : null;
}
