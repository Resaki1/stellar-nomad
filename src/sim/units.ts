import { Vector3 } from "three";

export const LOCAL_UNITS_PER_KM = 1;
export const SCALED_UNITS_PER_KM = 1 / 1000;

export type Vector3Tuple = [number, number, number];
export type Vector3Like = Vector3 | Vector3Tuple;

export const kmToLocalUnits = (km: number) => km * LOCAL_UNITS_PER_KM;
export const kmToScaledUnits = (km: number) => km * SCALED_UNITS_PER_KM;

export const toVector3 = (value: Vector3Like, target = new Vector3()) => {
  return Array.isArray(value)
    ? target.fromArray(value as Vector3Tuple)
    : target.copy(value as Vector3);
};

export const toLocalUnitsKm = (value: Vector3Like, target = new Vector3()) =>
  toVector3(value, target).multiplyScalar(LOCAL_UNITS_PER_KM);

export const toScaledUnitsKm = (value: Vector3Like, target = new Vector3()) =>
  toVector3(value, target).multiplyScalar(SCALED_UNITS_PER_KM);
