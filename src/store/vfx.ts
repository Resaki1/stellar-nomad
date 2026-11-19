import { atom } from "jotai";

// ---------------------------------------------------------------------------
// VFX event types
// ---------------------------------------------------------------------------

export type VFXEventType = "mined" | "collision";

export type AsteroidVFXEvent = {
  id: number;
  type: VFXEventType;
  /** World position in local render-space meters */
  position: [number, number, number];
  /** Committed rock destruction, anchored in its own frame through local origin shifts. */
  debrisAt?: { frameId: string; positionKm: [number, number, number] };
  /** Asteroid radius in meters */
  radiusM: number;
  /** Normalized direction of impact (from asteroid toward ship) for collision bias */
  impactDirection?: [number, number, number];
  /** Collision: the ship's velocity change along the contact normal, m/s (scales shake and sound). */
  impactDvMps?: number;
  /** Collision: camera shake added, 0..1 (default 1). */
  shake?: number;
  /** Collision: no impact sound (a second visual of a hit that already played one). */
  silent?: boolean;
  /** Timestamp (ms) when the event was created */
  createdAt: number;
};

let nextEventId = 1;

/** Bursts shown for OTHER pilots' mined rocks (tests read it; newest last, bounded). */
export const remoteBurstLog: { at: number; fieldId: string; chunkKey: string; instanceId: number; position: [number, number, number]; radiusM: number }[] = [];

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

/** Active VFX events (short-lived; cleaned up after their duration elapses). */
export const vfxEventsAtom = atom<AsteroidVFXEvent[]>([]);

/** Camera shake intensity: 0 = none, 1 = max. Decays in the consumer. */
export const cameraShakeIntensityAtom = atom(0);

// ---------------------------------------------------------------------------
// Action atoms
// ---------------------------------------------------------------------------

export const spawnVFXEventAtom = atom(
  null,
  (get, set, event: Omit<AsteroidVFXEvent, "id" | "createdAt">) => {
    const id = nextEventId++;
    const full: AsteroidVFXEvent = { ...event, id, createdAt: performance.now() };

    set(vfxEventsAtom, (prev) => [...prev, full]);

    // Collision-specific side effects
    if (event.type === "collision") {
      set(cameraShakeIntensityAtom, Math.min(1, get(cameraShakeIntensityAtom) + (event.shake ?? 1)));
    }
  }
);

export const removeVFXEventAtom = atom(null, (get, set, eventId: number) => {
  set(vfxEventsAtom, (prev) => prev.filter((e) => e.id !== eventId));
});
