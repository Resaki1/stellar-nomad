/** Flight-model tuning (docs/FLIGHT_MODEL_PLAN.md §3). Defaults plus a live copy the dev panel edits. */
export interface FlightTuning {
  mainThrustMps2: number;
  retroThrustMps2: number;
  strafeThrustMps2: number;
  /** Coupled strafe set-point at full input. */
  strafeSpeedLimitMps: number;
  /** Coupled/brake sideways authority beyond the strafe thrusters. */
  gripMps2: number;
  /** v_limit = sqrt(2 · a_retro · d_stop). */
  stopDistanceKm: number;
  maxPitchRateDegS: number;
  maxYawRateDegS: number;
  maxRollRateDegS: number;
  angularAccelDegS2: number;
  boostThrustMult: number;
  boostLimitMult: number;
  /** Full charge lasts this long while held. */
  boostChargeS: number;
  /** Empty → full, once the refill delay has passed. */
  boostRefillS: number;
  boostRefillDelayS: number;
  /** Held throttle key: 0 → 1 in this time. */
  throttleRampS: number;
  velocityTimeConstantS: number;
}

export const DEFAULT_FLIGHT_TUNING: Readonly<FlightTuning> = Object.freeze({
  mainThrustMps2: 120,
  retroThrustMps2: 90,
  strafeThrustMps2: 60,
  strafeSpeedLimitMps: 80,
  gripMps2: 250,
  stopDistanceKm: 0.9,
  maxPitchRateDegS: 70,
  maxYawRateDegS: 55,
  maxRollRateDegS: 120,
  angularAccelDegS2: 250,
  boostThrustMult: 2,
  boostLimitMult: 1.5,
  boostChargeS: 5,
  boostRefillS: 8,
  boostRefillDelayS: 1.5,
  throttleRampS: 2,
  velocityTimeConstantS: 0.25,
});

const live: FlightTuning = { ...DEFAULT_FLIGHT_TUNING };

/** The live table. Read it each step; never cache fields across frames. */
export function getFlightTuning(): Readonly<FlightTuning> {
  return live;
}

// Used as divisors or time constants: zero gives NaN that never leaves the state.
const POSITIVE_KEYS: ReadonlySet<keyof FlightTuning> = new Set<keyof FlightTuning>([
  "boostChargeS", "boostRefillS", "throttleRampS", "velocityTimeConstantS",
]);
const MIN_POSITIVE = 1e-3;

/** Patch the live table; non-finite values and unknown keys are ignored, negatives clamped. */
export function setFlightTuning(patch: Partial<FlightTuning>): void {
  for (const key of Object.keys(patch) as (keyof FlightTuning)[]) {
    const v = patch[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_FLIGHT_TUNING, key)) continue;
    live[key] = Math.max(POSITIVE_KEYS.has(key) ? MIN_POSITIVE : 0, v);
  }
}

export function resetFlightTuning(): void {
  Object.assign(live, DEFAULT_FLIGHT_TUNING);
}

/** Flight-computer speed limit in km/s, before boost. Multipliers come from modules. */
export function speedLimitKmps(
  t: Readonly<FlightTuning>,
  decelerationMult = 1,
  speedMult = 1,
  stopDistanceMult = 1,
): number {
  const aRetro = (t.retroThrustMps2 * decelerationMult) / 1000;
  return Math.sqrt(2 * aRetro * t.stopDistanceKm * stopDistanceMult) * speedMult;
}
