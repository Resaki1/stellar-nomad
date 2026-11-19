import type { SaveData, SaveMeta } from "@/save/types";
import type { StoredWorld, WorldRepository } from "./ports";

/** In-memory repository for tests: stores serialized JSON (like IDB, no shared references). */
export class MemoryRepository implements WorldRepository {
  private stored: string | null;
  commits = 0;
  /** Fail the next N commits (storage-failure scenario). */
  failNext = 0;

  constructor(initial?: StoredWorld) {
    this.stored = initial ? JSON.stringify(initial) : null;
  }

  async load(): Promise<StoredWorld | null> {
    return this.stored ? (JSON.parse(this.stored) as StoredWorld) : null;
  }

  async commit(meta: SaveMeta, data: SaveData): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("injected storage failure");
    }
    this.stored = JSON.stringify({ meta, data });
    this.commits++;
  }

  /** Test peek at the durable copy. */
  peek(): StoredWorld | null {
    return this.stored ? (JSON.parse(this.stored) as StoredWorld) : null;
  }
}
