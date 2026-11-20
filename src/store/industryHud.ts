import { atom } from "jotai";
import { selectAtom } from "jotai/utils";
import { Vector3 } from "three";
import { getLocalPlayerShip } from "@/sim/entities";
import { INDUSTRY_SOURCES, INDUSTRY_TUNING } from "@/sim/industry/catalog";
import { industryAtom } from "@/store/industry";
import { isFrameId } from "@/sim/frames";
import type { DepotRecord, DroneRecord } from "@/sim/industry/types";
import { targetedPOIAtom, transitDriveBuffer } from "@/store/transit";
import { poiBuffer, type POIDef } from "@/store/poi";

export const industryPanelOpenAtom = atom(false);
export const industryRequestAtom = atom<{ depotId?: string; renamePointId?: string; pointFuelId?: string; build?: boolean; name?: string } | null>(null);
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

/** The projector and the rendered drone share this frame-relative tuple while pinned. */
export function dronePoi(drone: DroneRecord, home: DepotRecord, number: number): POIDef {
  return {
    id: `drone:${drone.id}`,
    name: `${home.name} · Drone ${number}`,
    positionKm: [...home.positionKm],
    frameId: isFrameId(home.frameId) ? home.frameId : undefined,
    minDistanceKm: 0,
    maxDistanceKm: Infinity,
    kind: "drone",
    targetable: false,
  };
}

const droneBearingAtom = atom(get => {
  const target = get(targetedPOIAtom);
  if (!target?.id.startsWith("drone:")) return null;
  const { depots, drones } = get(industryAtom);
  const drone = drones.find(d => d.id === target.id.slice(6));
  const home = drone && depots.find(d => d.id === drone.homeId);
  if (!home || !drone) return null;
  const number = drones.filter(d => d.homeId === home.id).indexOf(drone) + 1;
  const poi = dronePoi(drone, home, number);
  poi.positionKm = target.positionKm as POIDef["positionKm"];
  return poi;
});
export const trackedDronePoiAtom = selectAtom(droneBearingAtom, poi => poi, (a, b) =>
  a?.id === b?.id && a?.positionKm === b?.positionKm && a?.name === b?.name && a?.frameId === b?.frameId);

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
