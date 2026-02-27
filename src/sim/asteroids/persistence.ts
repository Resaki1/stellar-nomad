/**
 * Persistence layer for asteroid delta state (destroyed / partially mined).
 *
 * Stores only *changes* relative to the procedurally generated baseline.
 * Currently uses localStorage; the shape is designed so you can swap in
 * IndexedDB or a server backend later without touching call-sites.
 */

const STORAGE_KEY = "asteroid-deltas-v1";
const SAVE_DEBOUNCE_MS = 500;

// ---------------------------------------------------------------------------
// Serialised shape (JSON-friendly)
// ---------------------------------------------------------------------------

type PersistedFieldDeltas = {
  /** Instance IDs that have been destroyed (mined or collided). */
  destroyed: number[];
};

type PersistedDeltas = {
  version: 1;
  fields: Record<string, PersistedFieldDeltas>;
};

// ---------------------------------------------------------------------------
// Runtime types
// ---------------------------------------------------------------------------

export type AsteroidFieldDeltas = {
  destroyedIds: Set<number>;
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class AsteroidDeltaStore {
  private readonly fields = new Map<string, AsteroidFieldDeltas>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Query / mutate -------------------------------------------------------

  getFieldDeltas(fieldId: string): AsteroidFieldDeltas {
    let deltas = this.fields.get(fieldId);
    if (!deltas) {
      deltas = { destroyedIds: new Set() };
      this.fields.set(fieldId, deltas);
    }
    return deltas;
  }

  isDestroyed(fieldId: string, instanceId: number): boolean {
    return this.fields.get(fieldId)?.destroyedIds.has(instanceId >>> 0) ?? false;
  }

  markDestroyed(fieldId: string, instanceId: number): void {
    this.getFieldDeltas(fieldId).destroyedIds.add(instanceId >>> 0);
    this.scheduleSave();
  }

  /** Remove all deltas for every field (full world reset). */
  clearAll(): void {
    this.fields.clear();
    this.saveImmediate();
  }

  /** Remove deltas for a single field. */
  clearField(fieldId: string): void {
    this.fields.delete(fieldId);
    this.scheduleSave();
  }

  // --- Persistence ----------------------------------------------------------

  /** Load from localStorage. Safe to call multiple times (idempotent). */
  load(): void {
    if (typeof window === "undefined") return;

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;

      const parsed: PersistedDeltas = JSON.parse(raw);
      if (parsed.version !== 1) return;

      for (const [fieldId, fieldData] of Object.entries(parsed.fields)) {
        const deltas = this.getFieldDeltas(fieldId);
        if (Array.isArray(fieldData.destroyed)) {
          for (const id of fieldData.destroyed) {
            if (typeof id === "number" && Number.isFinite(id)) {
              deltas.destroyedIds.add(id >>> 0);
            }
          }
        }
      }
    } catch {
      // Corrupted data — ignore silently and start fresh.
      // eslint-disable-next-line no-console
      console.warn("[AsteroidDeltaStore] Failed to load persisted deltas; starting fresh.");
    }
  }

  /** Immediate write to localStorage. Called on beforeunload or clearAll. */
  saveImmediate(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.writeToStorage();
  }

  /** Debounced save — avoids thrashing localStorage during rapid destruction sequences. */
  private scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeToStorage();
    }, SAVE_DEBOUNCE_MS);
  }

  private writeToStorage(): void {
    if (typeof window === "undefined") return;

    const persisted: PersistedDeltas = { version: 1, fields: {} };

    this.fields.forEach((deltas, fieldId) => {
      if (deltas.destroyedIds.size === 0) return;
      persisted.fields[fieldId] = {
        destroyed: Array.from(deltas.destroyedIds),
      };
    });

    // If nothing to persist, remove the key entirely to keep storage clean.
    if (Object.keys(persisted.fields).length === 0) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* quota / private mode — ignore */
      }
      return;
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      // Storage full or unavailable — non-fatal.
      // eslint-disable-next-line no-console
      console.warn("[AsteroidDeltaStore] Failed to persist deltas to localStorage.");
    }
  }

  // --- Diagnostics ----------------------------------------------------------

  /** Total number of destroyed asteroid IDs across all fields. */
  getTotalDestroyedCount(): number {
    let count = 0;
    this.fields.forEach((d) => (count += d.destroyedIds.size));
    return count;
  }
}
