import { useSyncExternalStore } from "react";
import { Vector3 } from "three";

export const RECENTER_THRESHOLD_KM = 100;

const worldOriginKm = new Vector3();
const shipPosKm = new Vector3();

const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());

export const subscribeWorldOrigin = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getWorldOriginState = () => ({ worldOriginKm, shipPosKm });

export const setWorldOriginKm = (nextOrigin: Vector3) => {
  worldOriginKm.copy(nextOrigin);
  emit();
};

export const setShipPosKm = (nextShipPos: Vector3) => {
  shipPosKm.copy(nextShipPos);
  emit();
};

export const maybeRecenter = (shipPositionKm: Vector3) => {
  const distanceFromOrigin = shipPositionKm.distanceTo(worldOriginKm);
  if (distanceFromOrigin > RECENTER_THRESHOLD_KM) {
    worldOriginKm.copy(shipPositionKm);
    shipPosKm.copy(shipPositionKm);
    emit();
    return true;
  }

  if (!shipPosKm.equals(shipPositionKm)) {
    shipPosKm.copy(shipPositionKm);
    emit();
  }

  return false;
};

export const useWorldOrigin = () =>
  useSyncExternalStore(subscribeWorldOrigin, getWorldOriginState);
