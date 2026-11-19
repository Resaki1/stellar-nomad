/**
 * Signaling client (M4.0: the local dev route, polled). M4.1 swaps the implementation behind
 * `Signaling` for a hosted service; nothing else in src/net knows how messages travel.
 */

/** What a guest sees before joining (join card). */
export interface RoomInfo {
  worldId: string;
  worldName: string;
  hostName: string;
  players: number;
  maxPlayers: number;
  protocol: number;
  content: string;
}

export interface SignalMsg {
  from: string;
  data: unknown;
}

/** A room lookup: found, no such room (expired or mistyped), or the service did not answer. */
export type RoomLookup = { kind: "ok"; info: RoomInfo } | { kind: "no_room" } | { kind: "unreachable" };

export interface Signaling {
  create(info: RoomInfo, code?: string): Promise<string>;
  info(code: string): Promise<RoomLookup>;
  join(code: string): Promise<{ peer: string; info: RoomInfo } | null>;
  send(code: string, peer: string, to: string, data: unknown): Promise<void>;
  poll(code: string, peer: string): Promise<SignalMsg[] | null>;
  close(code: string): Promise<void>;
}

import { devFault } from "./devFault";

const URL_PATH = "/api/coop/signal";


type Reply<T> = { ok: true; body: T } | { ok: false; status: number };

/** status 0 = no answer (network, fault). */
async function request<T>(body: object): Promise<Reply<T>> {
  if (devFault("signalingDown")) return { ok: false, status: 0 };
  try {
    const r = await fetch(URL_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return r.ok ? { ok: true, body: (await r.json()) as T } : { ok: false, status: r.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function call<T>(body: object): Promise<T | null> {
  const r = await request<T>(body);
  return r.ok ? r.body : null;
}

export const localSignaling: Signaling = {
  async create(info, code) {
    const r = await call<{ code: string }>({ a: "create", info, code });
    if (!r) throw new Error("signaling unavailable");
    return r.code;
  },
  async info(code) {
    const r = await request<{ info: RoomInfo }>({ a: "info", code });
    if (r.ok) return { kind: "ok", info: r.body.info };
    return r.status === 404 ? { kind: "no_room" } : { kind: "unreachable" };
  },
  join: (code) => call<{ peer: string; info: RoomInfo }>({ a: "join", code }),
  async send(code, peer, to, data) {
    await call({ a: "send", code, peer, to, data });
  },
  async poll(code, peer) {
    return (await call<{ msgs: SignalMsg[] }>({ a: "poll", code, peer }))?.msgs ?? null;
  },
  async close(code) {
    await call({ a: "close", code });
  },
};

/** Poll cadence while connecting; slower while idle-hosting. */
export const POLL_FAST_MS = 250;
export const POLL_IDLE_MS = 1000;
