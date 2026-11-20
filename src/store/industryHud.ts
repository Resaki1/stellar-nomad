import { atom } from "jotai";
import { selectAtom } from "jotai/utils";
import { Vector3 } from "three";
import { getLocalPlayerShip } from "@/sim/entities";
import { INDUSTRY_SOURCES, INDUSTRY_TUNING } from "@/sim/industry/catalog";
import { industryAtom } from "@/store/industry";
import { isFrameId } from "@/sim/frames";
import type { DepotRecord } from "@/sim/industry/types";
import { targetedPOIAtom, transitDriveBuffer } from "@/store/transit";
import { poiBuffer, type POIDef } from "@/store/poi";

export const industryPanelOpenAtom = atom(false);
export const industryRequestAtom = atom<{ depotId?: string; renamePointId?: string; build?: boolean; name?: string } | null>(null);
export const depotPlacementAtom = atom<{ fromIndustry: boolean } | null>(null);
export const depotPlacementNameAtom = atom("");
export const depotPlacementPendingAtom = atom(false);
export const clearDepotPlacementAtom = atom(null, (_get, set) => {
  depotPlacementPreview.ready = false;
  set(depotPlacementAtom, null);
});
export const cancelDepotPlacementAtom = atom(null, (get, set) => {
  const placement = get(depotPlacementAtom);
  if (!placement || get(depotPlacementPendingAtom)) return;
  set(clearDepotPlacementAtom);
  if (placement.fromIndustry) set(industryRequestAtom, { build: true, name: get(depotPlacementNameAtom) });
});

export const startDepotPlacementAtom = atom(null, (_get, set, name: string, fromIndustry: boolean) => {
  depotPlacementPreview.valid = false;
  sampleDepotPlacementPose();
  set(depotPlacementNameAtom, name);
  set(depotPlacementAtom, { fromIndustry });
});

export function nextDepotName(depots: readonly DepotRecord[]): string {
  const names = new Set(depots.map(depot => depot.name.toLowerCase()));
  let number = 1;
  while (names.has(`depot ${number}`)) number++;
  return `Depot ${number}`;
}

/** Frame-relative preview shared by the placement prompt and local scene. */
export const depotPlacementPreview = {
  frameId: "system",
  positionKm: [0, 0, 0] as [number, number, number],
  quaternion: [0, 0, 0, 1] as [number, number, number, number],
  valid: false,
  ready: false,
};

const nose = new Vector3();

/** Updates only the ghost pose. The HUD separately checks construction clearance at 10 Hz. */
export function sampleDepotPlacementPose(): boolean {
  const ship = getLocalPlayerShip();
  const preview = depotPlacementPreview;
  if (!ship) {
    preview.ready = false;
    return false;
  }
  const offset = nose.set(0, 0, INDUSTRY_TUNING.placeDistanceKm).applyQuaternion(ship.quat);
  preview.frameId = ship.frameId;
  preview.positionKm[0] = ship.posKm.x + offset.x;
  preview.positionKm[1] = ship.posKm.y + offset.y;
  preview.positionKm[2] = ship.posKm.z + offset.z;
  ship.quat.toArray(preview.quaternion);
  preview.ready = true;
  return true;
}

export const trackIndustryPoiAtom = atom(null, (get, set, poi: POIDef): boolean => {
  if (transitDriveBuffer.phase !== "idle") return false;
  if (get(targetedPOIAtom)?.id === poi.id) {
    poiBuffer.pinnedId = null;
    poiBuffer.targetedId = null;
    poiBuffer.targetedEtaS = null;
    poiBuffer.ignoreGazeUntilLookAway = poi.id;
    set(targetedPOIAtom, null);
    return true;
  }
  poiBuffer.ignoreGazeUntilLookAway = null;
  poiBuffer.targetedId = poi.id;
  poiBuffer.pinnedId = poi.id;
  set(targetedPOIAtom, {
    id: poi.id,
    name: poi.name,
    positionKm: poi.positionKm,
    frameId: poi.frameId,
    arrivalOffsetKm: poi.arrivalOffsetKm,
  });
  return true;
});

export function depotPoi(depot: DepotRecord): POIDef {
  return {
    id: `depot:${depot.id}`,
    name: depot.name,
    positionKm: depot.positionKm,
    frameId: isFrameId(depot.frameId) ? depot.frameId : undefined,
    minDistanceKm: 0,
    maxDistanceKm: 2e6,
    arrivalOffsetKm: 0.8,
    kind: "depot",
  };
}

export const industrySourcePois: POIDef[] = INDUSTRY_SOURCES.map(source => ({
  id: `industry-source:${source.id}`,
  name: source.name,
  positionKm: source.positionKm,
  frameId: isFrameId(source.frameId) ? source.frameId : undefined,
  minDistanceKm: 0,
  maxDistanceKm: source.rangeKm * 3,
  arrivalOffsetKm: 3,
}));

export const depotPoisAtom = selectAtom(industryAtom, state => state.depots.map(depotPoi), (before, after) =>
  before.length === after.length && before.every((poi, i) => poi.id === after[i].id && poi.name === after[i].name &&
    poi.frameId === after[i].frameId && poi.positionKm.every((value, axis) => value === after[i].positionKm[axis])),
);
