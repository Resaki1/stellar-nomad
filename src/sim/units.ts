import * as THREE from "three";

// Local space is authored in meters (1 unit = 1 m) while the canonical
// simulation positions are kilometers. Scaled space keeps far-field bodies
// compact by using 1 unit = 1000 km.
export const LOCAL_UNITS_PER_KM = 1000;
export const SCALED_UNITS_PER_KM = 1 / 1000;

// Helpful factors for translating between the two render spaces when starting
// from local-space coordinates.
export const LOCAL_TO_SCALED_FROM_LOCAL_UNITS =
  SCALED_UNITS_PER_KM / LOCAL_UNITS_PER_KM;

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
