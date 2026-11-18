/** Dev preference: live ship-resource tuning edits persist in localStorage and are re-applied on load. */
import { DEFAULT_RESOURCE_TUNING, getResourceTuning, setResourceTuning, type ResourceTuning } from "@/sim/ship/resourceTuning";

const KEY = "dev-resource-tuning-v1";

export function loadResourcePrefs(): void {
  if (process.env.NODE_ENV !== "development") return;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) setResourceTuning(JSON.parse(raw) as Partial<ResourceTuning>);
  } catch {
    // Unreadable blob: defaults stay.
  }
}

/** Store only the values that differ from the defaults (none → key removed). */
export function saveResourcePrefs(): void {
  try {
    const live = getResourceTuning();
    const out: Partial<ResourceTuning> = {};
    for (const k of Object.keys(DEFAULT_RESOURCE_TUNING) as (keyof ResourceTuning)[]) if (live[k] !== DEFAULT_RESOURCE_TUNING[k]) out[k] = live[k];
    if (Object.keys(out).length === 0) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    // Blocked storage: the live edit still applies for this session.
  }
}

export function resourceTuningJson(): string {
  return JSON.stringify(getResourceTuning(), null, 2);
}
