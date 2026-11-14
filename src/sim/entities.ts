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
