/**
 * The name other pilots see (device preference, not gameplay state: localStorage is right here).
 * Title-safe: no game imports.
 */
import { getDevicePlayerId } from "@/save/playerId";

const KEY = "coop-name";
export const PILOT_NAME_MAX = 24;

export function pilotName(): string {
  try {
    const n = localStorage.getItem(KEY)?.trim();
    if (n) return n.slice(0, PILOT_NAME_MAX);
  } catch {
    /* fall through */
  }
  return `Pilot ${getDevicePlayerId().slice(0, 4).toUpperCase()}`;
}

export function setPilotName(name: string): void {
  try {
    const n = name.trim().slice(0, PILOT_NAME_MAX);
    if (n) localStorage.setItem(KEY, n);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the default name is used */
  }
}
