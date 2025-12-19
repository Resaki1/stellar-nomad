import * as THREE from "three";

export const LOCAL_UNITS_PER_KM = 1;
export const SCALED_UNITS_PER_KM = 1 / 1000;

export type VectorLike = { x: number; y: number; z: number };

export const kmToLocalUnits = (km: number) => km * LOCAL_UNITS_PER_KM;
export const kmToScaledUnits = (km: number) => km * SCALED_UNITS_PER_KM;

export function toLocalUnitsKm<T extends THREE.Vector3>(vecKm: VectorLike, target: T) {
  target.set(
    kmToLocalUnits(vecKm.x),
    kmToLocalUnits(vecKm.y),
    kmToLocalUnits(vecKm.z)
  );
  return target;
}

export function toScaledUnitsKm<T extends THREE.Vector3>(vecKm: VectorLike, target: T) {
  target.set(
    kmToScaledUnits(vecKm.x),
    kmToScaledUnits(vecKm.y),
    kmToScaledUnits(vecKm.z)
  );
  return target;
}
