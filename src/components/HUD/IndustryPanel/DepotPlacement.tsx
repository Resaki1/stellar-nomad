"use client";

import { useCallback, useEffect, useState } from "react";
import { useAtom, useAtomValue, useStore } from "jotai";
import { playAudio } from "@/audio/voices";
import { getLocalPlayerShip } from "@/sim/entities";
import { DEPOT_KIT_ID, INDUSTRY_TUNING } from "@/sim/industry/catalog";
import { checkDepotPlacement } from "@/sim/industry/placement";
import { miningFieldsAt } from "@/sim/industry/mining";
import { emergencePose } from "@/sim/replication/points";
import { worldAuthority } from "@/sim/world/worldAuthority";
import { isDeadAtom } from "@/store/death";
import { industryAtom } from "@/store/industry";
import { cancelDepotPlacementAtom, clearDepotPlacementAtom, depotPlacementAtom, depotPlacementNameAtom, depotPlacementPendingAtom, depotPlacementPreview, industryRequestAtom, sampleDepotPlacementPose } from "@/store/industryHud";
import { miningStateAtom } from "@/store/mining";
import { modulesAtom } from "@/store/modules";
import { newOpId, runOperation } from "@/store/operations";
import { pilotPOIsAtom } from "@/store/poi";
import { localPlacementMotion, replicationPointsAtom } from "@/store/replication";
import { settingsIsOpenAtom } from "@/store/store";
import { transitDriveBuffer } from "@/store/transit";
import { PlacementCard } from "../shared/PlacementControls";
import { industryMessage, industryRejection } from "./industryActions";

type Store = ReturnType<typeof useStore>;

function readPreview(store: Store) {
  const ship = getLocalPlayerShip();
  const preview = depotPlacementPreview;
  if (!ship || !sampleDepotPlacementPose()) return { obstruction: "Waiting for ship position.", field: null };
  worldAuthority.world();
  const depots = store.get(industryAtom).depots;
  const occupied = store.get(replicationPointsAtom).flatMap(point => [
    point, { frameId: point.frameId, positionKm: emergencePose(point, 0).positionKm },
  ]);
  for (const pilot of store.get(pilotPOIsAtom)) occupied.push({ frameId: pilot.frameId ?? "system", positionKm: pilot.positionKm });
  const obstruction = transitDriveBuffer.phase !== "idle" ? "Finish transit before deploying."
    : store.get(miningStateAtom).isMining ? "Stop mining before deploying."
    : checkDepotPlacement(preview, { frameId: ship.frameId, positionKm: ship.posKm.toArray() },
      store.get(modulesAtom).consumables[DEPOT_KIT_ID] ?? 0, worldAuthority.asteroids, depots, occupied, localPlacementMotion());
  preview.valid = obstruction === null;
  const field = miningFieldsAt(preview)[0]?.name ?? null;
  return { obstruction: obstruction && industryMessage(obstruction), field };
}

/** Aim with the ship and place one pre-fabricated kit. Placement stays live until authority confirms. */
export default function DepotPlacement() {
  const placement = useAtomValue(depotPlacementAtom);
  return placement ? <AimDepot placement={placement} /> : null;
}

function AimDepot({ placement }: { placement: { fromIndustry: boolean } }) {
  const store = useStore();
  const dead = useAtomValue(isDeadAtom);
  const menu = useAtomValue(settingsIsOpenAtom);
  const kits = useAtomValue(modulesAtom).consumables[DEPOT_KIT_ID] ?? 0;
  const [name, setName] = useAtom(depotPlacementNameAtom);
  const [status, setStatus] = useState<ReturnType<typeof readPreview> | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const pending = useAtomValue(depotPlacementPendingAtom);

  useEffect(() => {
    if (dead || menu) store.set(clearDepotPlacementAtom);
  }, [dead, menu, store]);

  useEffect(() => {
    const refresh = () => {
      const next = readPreview(store);
      setStatus(before => before && before.obstruction === next.obstruction && before.field === next.field ? before : next);
    };
    refresh();
    const timer = window.setInterval(refresh, 100);
    return () => window.clearInterval(timer);
  }, [store]);

  const isActive = useCallback(() => store.get(depotPlacementAtom) === placement, [placement, store]);
  const cancel = useCallback(() => store.set(cancelDepotPlacementAtom), [store]);

  const confirm = useCallback(() => {
    if (!isActive() || store.get(depotPlacementPendingAtom) || store.get(isDeadAtom) || store.get(settingsIsOpenAtom)) return;
    const name = store.get(depotPlacementNameAtom).trim();
    const current = readPreview(store);
    setStatus(current);
    if (!name || current.obstruction) {
      playAudio("ui.reject");
      return;
    }
    setRefusal(null);
    store.set(depotPlacementPendingAtom, true);
    const { frameId, positionKm, quaternion } = depotPlacementPreview;
    runOperation({ type: "depot.place", opId: newOpId(), name, frameId, positionKm: [...positionKm], quaternion: [...quaternion] }, outcome => {
      store.set(depotPlacementPendingAtom, false);
      if (outcome.status === "accepted" && outcome.result.type === "depot.place") {
        playAudio("click.hard");
        if (store.get(depotPlacementAtom) === placement) {
          store.set(clearDepotPlacementAtom);
          if (placement.fromIndustry) store.set(industryRequestAtom, { depotId: outcome.result.depotId });
        }
      } else if (outcome.status === "rejected") {
        playAudio("ui.reject");
        setRefusal(industryRejection(outcome));
      }
    });
  }, [isActive, placement, store]);

  return <PlacementCard kind="depot" distanceKm={INDUSTRY_TUNING.placeDistanceKm} kits={kits}
    name={name} onNameChange={setName} ready={status?.obstruction === null} blocked={status?.obstruction}
    clearMessage={status?.field ? `Nearby field · ${status.field}` : "Clear · outside mining range"} refusal={refusal}
    pending={pending} isActive={isActive} cancel={cancel} confirm={confirm} />;
}
