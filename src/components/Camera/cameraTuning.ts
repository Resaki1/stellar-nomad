/** Chase-camera tuning (docs/FLIGHT_MODEL_PLAN.md §4). Defaults plus a live copy the dev panel edits. */
export interface CameraTuning {
  /** Critically damped orientation follow: ω = 1/τ, so steady lag = 2·τ·turn rate. */
  orientationLagS: number;
  /** Camera gives way against body acceleration: metres per m/s², capped. */
  accelOffsetMPerMps2: number;
  accelOffsetMaxM: number;
  accelOffsetLagS: number;
  /** Extra distance behind the ship per unit of speed fraction. */
  speedPullbackM: number;
  baseFovDeg: number;
  fovSpeedDeg: number;
  fovBoostDeg: number;
  fovMaxExtraDeg: number;
  fovLagS: number;
  freeLookDegPerPx: number;
  /** Yaw is unlimited; pitch stops short of the poles. */
  freeLookPitchMaxDeg: number;
  freeLookReturnS: number;
  /** Visual only: the model rolls into yaw and leans into pitch, scaled by turn rate. */
  bankMaxDeg: number;
  pitchLeanMaxDeg: number;
  bankLagS: number;
}

export const DEFAULT_CAMERA_TUNING: Readonly<CameraTuning> = Object.freeze({
  orientationLagS: 0.1,
  accelOffsetMPerMps2: 0.008,
  accelOffsetMaxM: 2.5,
  accelOffsetLagS: 0.15,
  speedPullbackM: 0.75,
  baseFovDeg: 75,
  fovSpeedDeg: 5,
  fovBoostDeg: 3,
  fovMaxExtraDeg: 8,
  fovLagS: 0.3,
  freeLookDegPerPx: 0.12,
  freeLookPitchMaxDeg: 89,
  freeLookReturnS: 0.25,
  bankMaxDeg: 25,
  pitchLeanMaxDeg: 6,
  bankLagS: 0.15,
});

const live: CameraTuning = { ...DEFAULT_CAMERA_TUNING };

export function getCameraTuning(): Readonly<CameraTuning> {
  return live;
}

const POSITIVE_KEYS: ReadonlySet<keyof CameraTuning> = new Set<keyof CameraTuning>([
  "orientationLagS", "accelOffsetLagS", "fovLagS", "freeLookReturnS", "baseFovDeg", "bankLagS",
]);

/** Patch the live table; non-finite values and unknown keys are ignored, negatives clamped. */
export function setCameraTuning(patch: Partial<CameraTuning>): void {
  for (const key of Object.keys(patch) as (keyof CameraTuning)[]) {
    const v = patch[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_CAMERA_TUNING, key)) continue;
    live[key] = Math.max(POSITIVE_KEYS.has(key) ? 1e-3 : 0, v);
  }
}

export function resetCameraTuning(): void {
  Object.assign(live, DEFAULT_CAMERA_TUNING);
}
