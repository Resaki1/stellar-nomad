/**
 * Injected dependencies of the headless session core. Browser adapters (IndexedDB, WebRTC,
 * MessageChannel) and test adapters (memory, controlled clock) implement these.
 */
import type { SaveData, SaveMeta } from "@/save/types";
import type { Channel } from "./protocol";

export interface Clock {
  /** Wall clock, ms since epoch (receipt and record timestamps). */
  nowMs(): number;
  /** Monotonic ms (heartbeats, clock samples). */
  monoMs(): number;
}

export interface StoredWorld {
  meta: SaveMeta;
  data: SaveData;
}

/** Durable world storage. `commit` is ONE atomic write of meta + data; a rejection means nothing was stored. */
export interface WorldRepository {
  load(): Promise<StoredWorld | null>;
  commit(meta: SaveMeta, data: SaveData): Promise<void>;
}

export type ConnId = string;

/** Host side: the session calls these; the adapter calls `HostSession.connect/receive/disconnect`. */
export interface HostTransport {
  send(conn: ConnId, channel: Channel, msg: unknown): void;
  close(conn: ConnId): void;
}

/** Client side: the session calls these; the adapter calls `GuestSession.opened/receive/closed`. */
export interface ClientLink {
  send(channel: Channel, msg: unknown): void;
  close(): void;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  monoMs: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
};
