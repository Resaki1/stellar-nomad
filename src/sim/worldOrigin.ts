import { atom, useAtomValue, useSetAtom } from "jotai";
import { Vector3 } from "three";

import { Vector3Like, Vector3Tuple, asVector3 } from "./units";

export const RECENTER_THRESHOLD_KM = 150;

const worldOriginAtom = atom<Vector3Tuple>([0, 0, 0]);
const shipPositionAtom = atom<Vector3Tuple>([0, 0, 0]);

const setWorldOriginAtom = atom(null, (_get, set, value: Vector3Like) => {
  const vec = asVector3(value, new Vector3());
  set(worldOriginAtom, [vec.x, vec.y, vec.z]);
});

const setShipPositionAtom = atom(null, (_get, set, value: Vector3Like) => {
  const vec = asVector3(value, new Vector3());
  set(shipPositionAtom, [vec.x, vec.y, vec.z]);
});

export const maybeRecenterAtom = atom(null, (get, set, shipPosKm: Vector3Like) => {
  const shipVec = asVector3(shipPosKm, new Vector3());
  const originVec = asVector3(get(worldOriginAtom), new Vector3());

  if (originVec.distanceTo(shipVec) > RECENTER_THRESHOLD_KM) {
    set(worldOriginAtom, [shipVec.x, shipVec.y, shipVec.z]);
  }

  set(setShipPositionAtom, shipPosKm);
});

export const useWorldOriginKm = () => useAtomValue(worldOriginAtom);
export const useShipPositionKm = () => useAtomValue(shipPositionAtom);
export const useSetWorldOriginKm = () => useSetAtom(setWorldOriginAtom);
export const useSetShipPositionKm = () => useSetAtom(setShipPositionAtom);
export const useMaybeRecenterOrigin = () => useSetAtom(maybeRecenterAtom);
