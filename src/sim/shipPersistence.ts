/**
 * Persistence for the player ship's position and orientation.
 *
 * Saves at a regular interval (not every frame) to keep perf impact negligible.
 * Uses localStorage; the shape is small (~120 bytes JSON).
 */

const STORAGE_KEY = "ship-state-v1";

// ---------------------------------------------------------------------------
// Persisted shape
// ---------------------------------------------------------------------------

export type PersistedShipState = {
  version: 1;
  /** Position in simulation km. */
  positionKm: [number, number, number];
  /** Orientation as quaternion [x, y, z, w]. */
  quaternion: [number, number, number, number];
};

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

export function loadShipState(): PersistedShipState | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed: PersistedShipState = JSON.parse(raw);
    if (parsed.version !== 1) return null;

    // Basic sanity checks
    const p = parsed.positionKm;
    const q = parsed.quaternion;

    if (
      !Array.isArray(p) || p.length !== 3 ||
      !p.every((v) => typeof v === "number" && Number.isFinite(v))
    ) return null;

    if (
      !Array.isArray(q) || q.length !== 4 ||
      !q.every((v) => typeof v === "number" && Number.isFinite(v))
    ) return null;

    return parsed;
  } catch {
    return null;
  }
}

export function saveShipState(
  positionKm: { x: number; y: number; z: number },
  quaternion: { x: number; y: number; z: number; w: number }
): void {
  if (typeof window === "undefined") return;

  const state: PersistedShipState = {
    version: 1,
    positionKm: [positionKm.x, positionKm.y, positionKm.z],
    quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or unavailable — non-fatal.
  }
}

export function clearShipState(): void {
  if (typeof window === "undefined") return;

  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
