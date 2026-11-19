/**
 * The name other pilots see: one per device, for every world (a device preference, not gameplay
 * state: localStorage is right here). Never required: unset reads as "Replicant XXXX".
 * Title-safe: no game imports.
 */
import { getDevicePlayerId } from "@/save/playerId";

const KEY = "coop-name";
export const PILOT_NAME_MAX = 24;

const listeners = new Set<(name: string) => void>();

/** The default when no name was chosen (stable per device). */
export function defaultPilotName(): string {
  return `Replicant ${getDevicePlayerId().slice(0, 4).toUpperCase()}`;
}

/** The chosen name, or "" when none (the default applies). */
export function chosenPilotName(): string {
  try {
    return localStorage.getItem(KEY)?.trim().slice(0, PILOT_NAME_MAX) ?? "";
  } catch {
    return "";
  }
}

export function pilotName(): string {
  return chosenPilotName() || defaultPilotName();
}

/** Store the name ("" clears it back to the default) and tell a live session. */
export function setPilotName(name: string): void {
  const before = pilotName();
  try {
    const n = name.trim().slice(0, PILOT_NAME_MAX);
    if (n) localStorage.setItem(KEY, n);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the default name is used */
  }
  const after = pilotName();
  if (after !== before) listeners.forEach((l) => l(after));
}

/** Called with the effective name after each change. */
export function onPilotNameChange(fn: (name: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
