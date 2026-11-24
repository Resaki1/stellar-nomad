import { atom } from "jotai";
import { selectAtom } from "jotai/utils";
import { trackedMarkersAtom } from "@/store/markerPrefs";
import { Vector3 } from "three";
import { getLocalPlayerShip } from "@/sim/entities";
import { INDUSTRY_TUNING } from "@/sim/industry/catalog";
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
    objectRadiusKm: 0.06,
    category: "depot",
  };
}

/**
 * Live frame-relative positions of tracked drones, keyed by marker id: IndustryWorld writes the
 * rendered drone into its tuple every frame, and the marker def holds the same tuple.
 */
export const droneLiveKm = new Map<string, { frameId: string; positionKm: [number, number, number] }>();

export function dronePoi(drone: DroneRecord, home: DepotRecord, number: number): POIDef {
  const id = `drone:${drone.id}`;
  let live = droneLiveKm.get(id);
  if (!live || live.frameId !== home.frameId) {
    live = { frameId: home.frameId, positionKm: [...home.positionKm] };
    droneLiveKm.set(id, live);
  }
  return {
    id,
    name: `${home.name} · Drone ${number}`,
    positionKm: live.positionKm,
    frameId: isFrameId(home.frameId) ? home.frameId : undefined,
    minDistanceKm: 0,
    maxDistanceKm: Infinity,
    category: "drone",
    targetable: false,
  };
}

/** Markers for the drones this pilot tracks (Industry → Drones → Track). */
const trackedDronePoisRawAtom = atom((get): POIDef[] => {
  const tracked = get(trackedMarkersAtom);
  if (!tracked.some((id) => id.startsWith("drone:"))) return [];
  const { depots, drones } = get(industryAtom);
  const out: POIDef[] = [];
  for (const drone of drones) {
    if (!tracked.includes(`drone:${drone.id}`)) continue;
    const home = depots.find(d => d.id === drone.homeId);
    if (home) out.push(dronePoi(drone, home, drones.filter(d => d.homeId === home.id).indexOf(drone) + 1));
  }
  return out;
});
export const trackedDronePoisAtom = selectAtom(trackedDronePoisRawAtom, (pois) => pois, (a, b) => a.length === b.length &&
  a.every((p, i) => p.id === b[i].id && p.name === b[i].name && p.frameId === b[i].frameId && p.positionKm === b[i].positionKm));

export const depotPoisAtom = selectAtom(industryAtom, state => state.depots.map(depotPoi), (before, after) =>
  before.length === after.length && before.every((poi, i) => poi.id === after[i].id && poi.name === after[i].name &&
    poi.frameId === after[i].frameId && poi.positionKm.every((value, axis) => value === after[i].positionKm[axis])),
);
