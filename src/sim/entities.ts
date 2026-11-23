import type { ShipState } from "./ship/shipState";

export const LOCAL_PLAYER_ID = "player";

export interface SimEntity {
  id: string;
  kind: "ship";
  ship: ShipState;
}

const entities = new Map<string, SimEntity>();

export function registerEntity(entity: SimEntity): void {
  entities.set(entity.id, entity);
}

export function unregisterEntity(id: string): void {
  entities.delete(id);
}

export function getEntity(id: string): SimEntity | undefined {
  return entities.get(id);
}

/** The local player's ship sim state, or null before the ship mounts. */
export function getLocalPlayerShip(): ShipState | null {
  return entities.get(LOCAL_PLAYER_ID)?.ship ?? null;
}

/**
 * The local ship as drawn this frame (interpolated between fixed steps), stamped with the
 * frame time. Co-op poses send this, not the raw 120 Hz step: a step is up to 8.3 ms old.
 */
export const localRenderPose = {
  atMs: -1,
  motion: 0,
  frameId: "",
  relKm: [0, 0, 0] as [number, number, number],
  quat: [0, 0, 0, 1] as [number, number, number, number],
  /** Smoothed main-engine plume intensity 0..1 (what the local exhaust draws). */
  throttle: 0,
};

/** The local mining beam as drawn this frame: endpoint in the ship's frame (km), for co-op poses. */
export const localBeamPose = {
  on: false,
  /** Pulse mining's off phase: the beam is drawn dim. */
  dim: false,
  /** The beam ends at its full range, on no rock (VFX plan §2 B1). */
  miss: false,
  atMs: -1,
  frameId: "",
  relKm: [0, 0, 0] as [number, number, number],
};
