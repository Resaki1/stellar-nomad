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
  // ⚠ Ladder continues past AU/s: interstellar cruise is ~1e5 AU/s, which reads as
  // an unparseable seven-digit number.
  if (abs < LY_IN_M) {
    const aups = mps / AU_IN_M;
    if (Math.abs(aups) < 10) return `${thinSpaceFormat(aups, 2)} AU/s`;
    if (Math.abs(aups) < 100) return `${thinSpaceFormat(aups, 1)} AU/s`;
    return `${thinSpaceFormat(Math.round(aups))} AU/s`;
  }
  if (abs < PC_IN_M * 10) {
    const lyps = mps / LY_IN_M;
    return Math.abs(lyps) < 10
      ? `${thinSpaceFormat(lyps, 2)} ly/s`
      : `${thinSpaceFormat(lyps, 1)} ly/s`;
  }
  const pcps = mps / PC_IN_M;
  return Math.abs(pcps) < 10
    ? `${thinSpaceFormat(pcps, 2)} pc/s`
    : `${thinSpaceFormat(Math.round(pcps))} pc/s`;
}

/**
 * Format distance (input in km) with adaptive unit: m → km → AU → ly → pc.
 *
 * ⚠ The ladder has to reach `pc`, or an interstellar marker reads
 * "273 258 AU" — a number nobody can parse at a glance. Handover points are
 * chosen so the mantissa stays under ~4 significant digits: AU up to 0.1 ly
 * (6,324 AU), then ly up to 10 pc, then pc.
 */
export function formatDistance(km: number): string {
  const abs = Math.abs(km);
  if (abs < 1) {
    return `${thinSpaceFormat(Math.round(km * 1000))} m`;
  }
  if (abs < AU_IN_KM) {
    return `${thinSpaceFormat(Math.round(km))} km`;
  }
  if (abs < LY_IN_KM * 0.1) {
    const au = km / AU_IN_KM;
    if (Math.abs(au) < 10) return `${thinSpaceFormat(au, 2)} AU`;
    if (Math.abs(au) < 100) return `${thinSpaceFormat(au, 1)} AU`;
    return `${thinSpaceFormat(Math.round(au))} AU`;
  }
  if (abs < PC_IN_KM * 10) {
    const ly = km / LY_IN_KM;
    return Math.abs(ly) < 10
      ? `${thinSpaceFormat(ly, 3)} ly`
      : `${thinSpaceFormat(ly, 2)} ly`;
  }
  const pc = km / PC_IN_KM;
  return Math.abs(pc) < 100
    ? `${thinSpaceFormat(pc, 2)} pc`
    : `${thinSpaceFormat(Math.round(pc))} pc`;
}

/**
 * Format a duration in seconds with an adaptive unit: s → m → h → d → y.
 *
 * ⚠ Exists because a transit ETA is shown next to a distance that now reaches
 * parsecs, so "158 483 921s" was a realistic readout. Compound below a day
 * ("4m 12s") because that is the range a player actually times an approach in;
 * coarse above it, where a single figure is enough.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds - m * 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds - h * 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (seconds < 365.25 * 86_400) {
    const d = seconds / 86_400;
    return d < 10 ? `${thinSpaceFormat(d, 1)}d` : `${thinSpaceFormat(Math.round(d))}d`;
  }
  const y = seconds / (365.25 * 86_400);
  return y < 10
    ? `${thinSpaceFormat(y, 1)}y`
    : `${thinSpaceFormat(Math.round(y))}y`;
}

export type SpeedUnit = "m/s" | "km/s" | "AU/s" | "ly/s" | "pc/s";

/** Metres in one light-year (IAU: Julian year × c). */
export const LY_IN_M = 9.4607304725808e15;
/** Metres in one parsec (IAU 2015). */
export const PC_IN_M = 3.0856775814913673e16;
/** Kilometres in one light-year / parsec — the interstellar distance units. */
export const LY_IN_KM = LY_IN_M / 1000;
export const PC_IN_KM = PC_IN_M / 1000;

/** Multiplier to convert from a given SpeedUnit to m/s. */
export const SPEED_UNIT_TO_MPS: Record<SpeedUnit, number> = {
  "m/s": 1,
  "km/s": 1000,
  "AU/s": AU_IN_M,
  // ⚠ Interstellar cheats, for reaching another star inside a play session:
  // 1 ly/s is ~3.15e7 c. Dev-only, and the reason they exist is that the nearest
  // star is 4.24 ly — untraversable at any physical speed.
  "ly/s": LY_IN_M,
  "pc/s": PC_IN_M,
};

/** Distance units for dev inputs. */
export type DistanceUnit = "km" | "AU" | "ly" | "pc";

export const DISTANCE_UNIT_TO_KM: Record<DistanceUnit, number> = {
  km: 1,
  AU: AU_IN_M / 1000,
  ly: LY_IN_KM,
  pc: PC_IN_KM,
};

export const DISTANCE_UNITS: readonly DistanceUnit[] = ["km", "AU", "ly", "pc"];
export const SPEED_UNITS: readonly SpeedUnit[] = [
  "m/s",
  "km/s",
  "AU/s",
  "ly/s",
  "pc/s",
];
