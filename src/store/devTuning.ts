/** Dev builds: is any live tuning table off its defaults (B2: a stored physics edit silently changed lethal speed)? */
import { DEFAULT_FLIGHT_TUNING, getFlightTuning, resetFlightTuning } from "@/sim/ship/flightTuning";
import { DEFAULT_CAMERA_TUNING, getCameraTuning, resetCameraTuning } from "@/components/Camera/cameraTuning";
import { DEFAULT_PHYSICS_TUNING, getPhysicsTuning, resetPhysicsTuning } from "@/sim/physics/physicsTuning";
import { DEFAULT_RESOURCE_TUNING, getResourceTuning, resetResourceTuning } from "@/sim/ship/resourceTuning";
import { applyPhysicsMaterial, physicsDebug } from "@/store/physicsTuningPrefs";

const IS_DEV = process.env.NODE_ENV === "development";
const KEYS = ["dev-flight-tuning-v1", "dev-physics-tuning-v1", "dev-resource-tuning-v1"] as const;

function differs<T extends object>(live: Readonly<T>, defaults: Readonly<T>): boolean {
  for (const k of Object.keys(defaults) as (keyof T)[]) if (live[k] !== defaults[k]) return true;
  return false;
}

export function devTuningActive(): boolean {
  if (!IS_DEV) return false;
  return (
    differs(getFlightTuning(), DEFAULT_FLIGHT_TUNING) ||
    differs(getCameraTuning(), DEFAULT_CAMERA_TUNING) ||
    differs(getPhysicsTuning(), DEFAULT_PHYSICS_TUNING) ||
    differs(getResourceTuning(), DEFAULT_RESOURCE_TUNING)
  );
}

/** Every live table back to defaults and the stored dev prefs cleared. */
export function resetAllDevTuning(): void {
  resetFlightTuning();
  resetCameraTuning();
  resetPhysicsTuning();
  resetResourceTuning();
  physicsDebug.outlines = false;
  applyPhysicsMaterial();
  try {
    for (const k of KEYS) window.localStorage.removeItem(k);
  } catch {
    // Blocked storage: nothing was stored.
  }
}
