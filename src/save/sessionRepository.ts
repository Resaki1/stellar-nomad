/** IndexedDB WorldRepository for the host worker: one world, meta + data in one transaction per commit. */
import { loadWorld, putWorld } from "./saveDb";
import type { SaveData, SaveMeta, WorldId } from "./types";
import type { StoredWorld, WorldRepository } from "@/sim/session/ports";

export function idbWorldRepository(id: WorldId): WorldRepository {
  return {
    load: (): Promise<StoredWorld | null> => loadWorld(id),
    commit: (meta: SaveMeta, data: SaveData): Promise<void> => putWorld({ ...meta, lastPlayedAt: Date.now() }, data),
  };
}
