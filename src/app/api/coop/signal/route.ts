/**
 * LOCAL test signaling for co-op (M4.0): in-memory rooms, polled. M4.1 replaces it with a hosted
 * service behind the same `Signaling` client interface. 404 outside development unless
 * COOP_LOCAL_SIGNALING=1. Payloads are opaque SDP blobs; nothing here touches game state.
 */
const ROOM_TTL_MS = 10 * 60_000;
const MAX_ROOMS = 64;
const MAX_INBOX = 64;
const MAX_BODY = 64 * 1024;
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

interface Msg {
  from: string;
  data: unknown;
}
interface Room {
  code: string;
  info: unknown;
  hostSeen: number;
  inbox: Map<string, Msg[]>;
  nextPeer: number;
}

// globalThis: dev hot reload re-evaluates this module, rooms must survive it.
const g = globalThis as { __coopRooms?: Map<string, Room> };
const rooms = (g.__coopRooms ??= new Map<string, Room>());

function sweep(now: number): void {
  rooms.forEach((r, code) => {
    if (now - r.hostSeen > ROOM_TTL_MS) rooms.delete(code);
  });
}

function newCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(b, (x) => CODE_CHARS[x % CODE_CHARS.length]).join("");
}

function push(room: Room, to: string, m: Msg): void {
  const box = room.inbox.get(to) ?? [];
  if (box.length >= MAX_INBOX) box.shift();
  box.push(m);
  room.inbox.set(to, box);
}

const json = (v: unknown, status = 200): Response => Response.json(v, { status });

export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV !== "development" && process.env.COOP_LOCAL_SIGNALING !== "1") return new Response("Not found", { status: 404 });
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ error: "too large" }, 413);
  let b: { a?: string; code?: string; peer?: string; to?: string; info?: unknown; data?: unknown };
  try {
    b = JSON.parse(text);
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const now = Date.now();
  sweep(now);
  const code = typeof b.code === "string" ? b.code.toUpperCase().slice(0, 12) : "";
  const room = rooms.get(code);
  switch (b.a) {
    case "create": {
      // A host reload reuses its code while the room lives.
      if (room) {
        room.info = b.info;
        room.hostSeen = now;
        return json({ code: room.code });
      }
      if (rooms.size >= MAX_ROOMS) return json({ error: "busy" }, 503);
      let c = /^[A-Z0-9]{6}$/.test(code) ? code : newCode();
      while (rooms.has(c)) c = newCode();
      rooms.set(c, { code: c, info: b.info, hostSeen: now, inbox: new Map(), nextPeer: 1 });
      return json({ code: c });
    }
    case "info":
      return room ? json({ info: room.info }) : json({ error: "no room" }, 404);
    case "join": {
      if (!room) return json({ error: "no room" }, 404);
      const peer = `p${room.nextPeer++}`;
      push(room, "host", { from: peer, data: { t: "join" } });
      return json({ peer, info: room.info });
    }
    case "send": {
      if (!room || typeof b.peer !== "string" || typeof b.to !== "string") return json({ error: "no room" }, 404);
      push(room, b.to, { from: b.peer, data: b.data });
      return json({ ok: true });
    }
    case "poll": {
      if (!room || typeof b.peer !== "string") return json({ error: "no room" }, 404);
      if (b.peer === "host") room.hostSeen = now;
      const msgs = room.inbox.get(b.peer) ?? [];
      room.inbox.delete(b.peer);
      return json({ msgs });
    }
    case "close":
      if (room) rooms.delete(code);
      return json({ ok: true });
    default:
      return json({ error: "bad action" }, 400);
  }
}
