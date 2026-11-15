import type { PlayerId, WorldId } from "./types";

/** Identifies this device/profile, not a world. */
const PLAYER_ID_KEY = "player-id-v1";
const LAST_WORLD_KEY = "last-world-id";

let cached: PlayerId | null = null;

export function getLocalPlayerId(): PlayerId {
  if (cached) return cached;
  try {
    const stored = localStorage.getItem(PLAYER_ID_KEY);
    if (stored) return (cached = stored);
    cached = crypto.randomUUID();
    localStorage.setItem(PLAYER_ID_KEY, cached);
  } catch {
    cached ??= crypto.randomUUID();
  }
  return cached;
}

export function getLastWorldId(): WorldId | null {
  try {
    return localStorage.getItem(LAST_WORLD_KEY);
  } catch {
    return null;
  }
}

export function setLastWorldId(id: WorldId): void {
  try {
    localStorage.setItem(LAST_WORLD_KEY, id);
  } catch {
    /* private mode: the next boot falls back to the most recent world */
  }
}
