import { Vector3 } from "three";

export const LOCAL_UNITS_PER_KM = 1;
export const SCALED_UNITS_PER_KM = 1 / 1000;

export type Vector3Tuple = [number, number, number];
export type Vector3Like = Vector3 | Vector3Tuple | { x: number; y: number; z: number };

export const kmToLocalUnits = (km: number) => km * LOCAL_UNITS_PER_KM;
export const kmToScaledUnits = (km: number) => km * SCALED_UNITS_PER_KM;

export const toLocalUnitsKm = <T extends Vector3>(vecKm: Vector3Like, target: T): T => {
  return target.copy(asVector3(vecKm)).multiplyScalar(LOCAL_UNITS_PER_KM) as T;
};

export const toScaledUnitsKm = <T extends Vector3>(vecKm: Vector3Like, target: T): T => {
  return target.copy(asVector3(vecKm)).multiplyScalar(SCALED_UNITS_PER_KM) as T;
};

export const asVector3 = <T extends Vector3>(value: Vector3Like, target: T = new Vector3() as T): T => {
  if (value instanceof Vector3) return target.copy(value) as T;
  if (Array.isArray(value)) return target.set(value[0], value[1], value[2]) as T;
  return target.set(value.x, value.y, value.z) as T;
};
