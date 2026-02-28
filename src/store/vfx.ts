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
  /** Asteroid radius in meters */
  radiusM: number;
  /** Normalized direction of impact (from asteroid toward ship) for collision bias */
  impactDirection?: [number, number, number];
  /** Resource info for loot popup */
  loot?: { resourceId: string; amount: number; name: string; icon: string };
  /** Timestamp (ms) when the event was created */
  createdAt: number;
};

let nextEventId = 1;

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

/** Active VFX events (short-lived; cleaned up after their duration elapses). */
export const vfxEventsAtom = atom<AsteroidVFXEvent[]>([]);

/** Camera shake intensity: 0 = none, 1 = max. Decays in the consumer. */
export const cameraShakeIntensityAtom = atom(0);

/** Collision impact signal (consumed once by Spaceship for speed dip). */
export type CollisionImpact = {
  /** Radius of the asteroid that was hit, in meters */
  radiusM: number;
};
export const collisionImpactAtom = atom<CollisionImpact | null>(null);

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
      set(cameraShakeIntensityAtom, 1);
      set(collisionImpactAtom, { radiusM: event.radiusM });
    }
  }
);

export const removeVFXEventAtom = atom(null, (get, set, eventId: number) => {
  set(vfxEventsAtom, (prev) => prev.filter((e) => e.id !== eventId));
});
