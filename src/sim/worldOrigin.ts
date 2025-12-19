import { useSyncExternalStore } from "react";
import { Vector3 } from "three";

export const RECENTER_THRESHOLD_KM = 150;

type Vector3Like = { x: number; y: number; z: number } | [number, number, number];

type Listener = () => void;

let worldOriginKm = new Vector3();
let shipPosKm = new Vector3();

const listeners = new Set<Listener>();
const temp = new Vector3();

function notify() {
  listeners.forEach((listener) => listener());
}

function normalizeVector(input: Vector3Like, target: Vector3): Vector3 {
  if (Array.isArray(input)) {
    const [x, y, z] = input;
    return target.set(x, y, z);
  }

  return target.set(input.x, input.y, input.z);
}

export function getWorldOriginKm(): Vector3 {
  return worldOriginKm;
}

export function setWorldOriginKm(next: Vector3Like) {
  worldOriginKm = normalizeVector(next, new Vector3());
  notify();
}

export function getShipPosKm(): Vector3 {
  return shipPosKm;
}

export function setShipPosKm(next: Vector3Like) {
  normalizeVector(next, shipPosKm);
}

export function maybeRecenterWorld(nextShipKm: Vector3Like) {
  const distanceFromOrigin = normalizeVector(nextShipKm, temp).distanceTo(worldOriginKm);

  if (distanceFromOrigin > RECENTER_THRESHOLD_KM) {
    setWorldOriginKm(nextShipKm);
  }
}

export function useWorldOriginKm(): Vector3 {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => worldOriginKm,
    () => worldOriginKm
  );
}
