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

export function toLocalUnitsKm<T extends THREE.Vector3>(
  vecKm: VectorLike,
  target: T
) {
  target.set(
    kmToLocalUnits(vecKm.x),
    kmToLocalUnits(vecKm.y),
    kmToLocalUnits(vecKm.z)
  );
  return target;
}

export function toScaledUnitsKm<T extends THREE.Vector3>(
  vecKm: VectorLike,
  target: T
) {
  target.set(
    kmToScaledUnits(vecKm.x),
    kmToScaledUnits(vecKm.y),
    kmToScaledUnits(vecKm.z)
  );
  return target;
}

// ── Astronomical unit ────────────────────────────────────────────────
export const AU_IN_M = 149_597_870_700;
export const AU_IN_KM = AU_IN_M / 1000;

// ── Display formatting (thin space = U+2009 as SI thousands separator) ──

/** Format an integer or fixed-decimal number with thin-space grouping. */
function thinSpaceFormat(n: number, decimals = 0): string {
  const fixed = n.toFixed(decimals);
  const [intPart, decPart] = fixed.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009");
  return decPart !== undefined ? `${grouped}.${decPart}` : grouped;
}

/** Format speed (input in m/s) with adaptive unit: m/s → km/s → AU/s. */
export function formatSpeed(mps: number): string {
  const abs = Math.abs(mps);
  if (abs < 1000) {
    return `${thinSpaceFormat(Math.round(mps))} m/s`;
  }
  const kmps = mps / 1000;
  if (abs < AU_IN_M) {
    return Math.abs(kmps) < 10
      ? `${thinSpaceFormat(kmps, 1)} km/s`
      : `${thinSpaceFormat(Math.round(kmps))} km/s`;
  }
  const aups = mps / AU_IN_M;
  if (Math.abs(aups) < 10) return `${thinSpaceFormat(aups, 2)} AU/s`;
  if (Math.abs(aups) < 100) return `${thinSpaceFormat(aups, 1)} AU/s`;
  return `${thinSpaceFormat(Math.round(aups))} AU/s`;
}

/** Format distance (input in km) with adaptive unit: m → km → AU. */
export function formatDistance(km: number): string {
  const abs = Math.abs(km);
  if (abs < 1) {
    return `${thinSpaceFormat(Math.round(km * 1000))} m`;
  }
  if (abs < AU_IN_KM) {
    return `${thinSpaceFormat(Math.round(km))} km`;
  }
  const au = km / AU_IN_KM;
  if (Math.abs(au) < 10) return `${thinSpaceFormat(au, 2)} AU`;
  if (Math.abs(au) < 100) return `${thinSpaceFormat(au, 1)} AU`;
  return `${thinSpaceFormat(Math.round(au))} AU`;
}

export type SpeedUnit = "m/s" | "km/s" | "AU/s";

/** Multiplier to convert from a given SpeedUnit to m/s. */
export const SPEED_UNIT_TO_MPS: Record<SpeedUnit, number> = {
  "m/s": 1,
  "km/s": 1000,
  "AU/s": AU_IN_M,
};
