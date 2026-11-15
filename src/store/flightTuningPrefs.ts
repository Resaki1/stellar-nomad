/** Dev preference: live flight/camera tuning edits persist in localStorage and are re-applied on load. */
import { DEFAULT_FLIGHT_TUNING, getFlightTuning, setFlightTuning, type FlightTuning } from "@/sim/ship/flightTuning";
import { DEFAULT_CAMERA_TUNING, getCameraTuning, setCameraTuning, type CameraTuning } from "@/components/Camera/cameraTuning";

const KEY = "dev-flight-tuning-v1";

type Prefs = { flight?: Partial<FlightTuning>; camera?: Partial<CameraTuning> };

function diff<T extends object>(live: Readonly<T>, defaults: Readonly<T>): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(defaults) as (keyof T)[]) if (live[k] !== defaults[k]) out[k] = live[k];
  return out;
}

export function loadTuningPrefs(): void {
  if (process.env.NODE_ENV !== "development") return;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return;
    const p = JSON.parse(raw) as Prefs;
    if (p.flight) setFlightTuning(p.flight);
    if (p.camera) setCameraTuning(p.camera);
  } catch {
    // Unreadable blob: defaults stay.
  }
}

/** Store only the values that differ from the defaults (none → key removed). */
export function saveTuningPrefs(): void {
  try {
    const p: Prefs = { flight: diff(getFlightTuning(), DEFAULT_FLIGHT_TUNING), camera: diff(getCameraTuning(), DEFAULT_CAMERA_TUNING) };
    if (Object.keys(p.flight ?? {}).length === 0 && Object.keys(p.camera ?? {}).length === 0) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Blocked storage: the live edit still applies for this session.
  }
}

/** Full tables, ready to paste over the defaults. */
export function tuningJson(): string {
  return JSON.stringify({ flight: getFlightTuning(), camera: getCameraTuning() }, null, 2);
}
