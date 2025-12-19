import { Vector3 } from "three";

type Vector3Like = { x: number; y: number; z: number } | [number, number, number];

export const LOCAL_UNITS_PER_KM = 1;
export const SCALED_UNITS_PER_KM = 1 / 1000;

export function kmToLocalUnits(km: number): number {
  return km * LOCAL_UNITS_PER_KM;
}

export function kmToScaledUnits(km: number): number {
  return km * SCALED_UNITS_PER_KM;
}

function toVector3(input: Vector3Like, target: Vector3): Vector3 {
  if (Array.isArray(input)) {
    const [x, y, z] = input;
    return target.set(x, y, z);
  }

  return target.set(input.x, input.y, input.z);
}

export function kmVectorToLocalUnits<T extends Vector3>(
  vecKm: Vector3Like,
  target: T
): T {
  return toVector3(vecKm, target).multiplyScalar(LOCAL_UNITS_PER_KM) as T;
}

export function kmVectorToScaledUnits<T extends Vector3>(
  vecKm: Vector3Like,
  target: T
): T {
  return toVector3(vecKm, target).multiplyScalar(SCALED_UNITS_PER_KM) as T;
}
