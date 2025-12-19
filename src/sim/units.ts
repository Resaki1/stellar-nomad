import * as THREE from "three";

// Local space is authored in meters, so 1 km = 1000 local units (meters).
export const LOCAL_UNITS_PER_KM = 1000;
// Scaled space is authored directly in kilometers, so 1 km = 1 scaled unit.
export const SCALED_UNITS_PER_KM = 1;

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
