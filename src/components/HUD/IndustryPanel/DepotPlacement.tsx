"use client";

import { useCallback, useEffect, useState } from "react";
import { useAtomValue, useStore } from "jotai";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { playAudio } from "@/audio/voices";
import { getLocalPlayerShip } from "@/sim/entities";
import { DEPOT_KIT_ID, INDUSTRY_SOURCES, INDUSTRY_TUNING } from "@/sim/industry/catalog";
import { canExtractAt, checkDepotPlacement } from "@/sim/industry/placement";
import { emergencePose } from "@/sim/replication/points";
import { formatDistance } from "@/sim/units";
import { worldAuthority } from "@/sim/world/worldAuthority";
import { isDeadAtom } from "@/store/death";
import { industryAtom } from "@/store/industry";
import { cancelDepotPlacementAtom, depotPlacementAtom, depotPlacementPendingAtom, depotPlacementPreview, industryRequestAtom, sampleDepotPlacementPose } from "@/store/industryHud";
import { miningStateAtom } from "@/store/mining";
import { modulesAtom } from "@/store/modules";
import { newOpId, runOperation } from "@/store/operations";
import { pilotPOIsAtom } from "@/store/poi";
import { replicationPointsAtom } from "@/store/replication";
import { settingsIsOpenAtom } from "@/store/store";
import { transitDriveBuffer } from "@/store/transit";
import { KeyChip } from "../shared/Chips";
import { industryMessage, industryRejection } from "./industryActions";

type Store = ReturnType<typeof useStore>;

function readPreview(store: Store) {
  const ship = getLocalPlayerShip();
  const preview = depotPlacementPreview;
  if (!ship || !sampleDepotPlacementPose()) return { obstruction: "Waiting for ship position.", source: null };
  worldAuthority.world();
  const occupied = store.get(replicationPointsAtom).flatMap(point => [
    point, { frameId: point.frameId, positionKm: emergencePose(point, 0).positionKm },
  ]);
  for (const pilot of store.get(pilotPOIsAtom)) occupied.push({ frameId: pilot.frameId ?? "system", positionKm: pilot.positionKm });
  const obstruction = transitDriveBuffer.phase !== "idle" ? "Finish transit before deploying."
    : store.get(miningStateAtom).isMining ? "Stop mining before deploying."
    : checkDepotPlacement(preview, { frameId: ship.frameId, positionKm: ship.posKm.toArray() },
      store.get(modulesAtom).consumables[DEPOT_KIT_ID] ?? 0, worldAuthority.asteroids, store.get(industryAtom).depots, occupied);
  preview.valid = obstruction === null;
  const source = INDUSTRY_SOURCES.find(prospect => canExtractAt(preview, prospect.id))?.name ?? null;
  return { obstruction: obstruction && industryMessage(obstruction), source };
}

/** Aim with the ship and place one pre-fabricated kit. Placement stays live until authority confirms. */
export default function DepotPlacement() {
  const name = useAtomValue(depotPlacementAtom);
  return name ? <AimDepot name={name} /> : null;
}

function AimDepot({ name }: { name: string }) {
  const store = useStore();
  const dead = useAtomValue(isDeadAtom);
  const menu = useAtomValue(settingsIsOpenAtom);
  const [status, setStatus] = useState<ReturnType<typeof readPreview>>({ obstruction: "Checking clearance…", source: null });
  const [refusal, setRefusal] = useState<string | null>(null);
  const pending = useAtomValue(depotPlacementPendingAtom);

  const clear = useCallback(() => {
    depotPlacementPreview.ready = false;
    store.set(depotPlacementAtom, null);
  }, [store]);

  useEffect(() => {
    if (dead || menu) clear();
  }, [clear, dead, menu]);

  useEffect(() => {
    const refresh = () => {
      const next = readPreview(store);
      setStatus(before => before.obstruction === next.obstruction && before.source === next.source ? before : next);
    };
    refresh();
    const timer = window.setInterval(refresh, 100);
    return () => window.clearInterval(timer);
  }, [store]);

  const cancel = useCallback(() => {
    store.set(cancelDepotPlacementAtom);
  }, [store]);

  const confirm = useCallback(() => {
    if (store.get(depotPlacementPendingAtom) || store.get(isDeadAtom) || store.get(settingsIsOpenAtom)) return;
    const current = readPreview(store);
    setStatus(current);
    if (current.obstruction) {
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
        if (store.get(depotPlacementAtom) === name) {
          clear();
          store.set(industryRequestAtom, { depotId: outcome.result.depotId });
        }
      } else if (outcome.status === "rejected") {
        playAudio("ui.reject");
        setRefusal(industryRejection(outcome));
      }
    });
  }, [clear, name, store]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      // Keep the placement gesture from reaching settings, comms or another placeable.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (e.key === "Escape") cancel();
      else if ((e.target as HTMLElement | null)?.closest('[data-industry-action="cancel-placement"]')) cancel();
      else confirm();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancel, confirm]);

  return <section className="industry-placement" aria-label="Deploy depot">
    <div><h3>{name}</h3><p>Aim the ship to place {formatDistance(INDUSTRY_TUNING.placeDistanceKm)} ahead.</p></div>
    <div className={`industry-placement__status${status.obstruction || refusal ? " industry-placement__status--blocked" : ""}`}
      role={refusal ? "alert" : "status"} data-industry-clear={status.obstruction === null}>
      {status.obstruction || refusal ? <TriangleAlert size={14} aria-hidden /> : <CircleCheck size={14} aria-hidden />}
      {pending ? "Waiting for confirmation…" : refusal ?? status.obstruction ?? (status.source ? `${status.source} in range` : "Clear · relay site")}
    </div>
    <div className="industry-placement__buttons">
      <button type="button" className="industry__action" data-industry-action="cancel-placement" disabled={pending} onClick={cancel}>Cancel <KeyChip keyName="escape" /></button>
      <button type="button" className="industry__action industry__action--primary" data-industry-action="place" disabled={pending || !!status.obstruction} onClick={confirm}>Deploy depot <KeyChip keyName="enter" /></button>
    </div>
  </section>;
}
