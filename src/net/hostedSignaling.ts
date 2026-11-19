import type { RoomInfo, SignalMsg, Signaling } from "./signaling";
import { devFault } from "./devFault";

class Inbox {
  private readonly messages: SignalMsg[] = [];
  private wake?: () => void;

  constructor(readonly socket: WebSocket) {
    socket.onmessage = (ev) => {
      const m: SignalMsg = JSON.parse(ev.data);
      if (this.messages.length < 32) this.messages.push(m);
      this.wake?.();
    };
    socket.onclose = () => this.wake?.();
  }

  async read(): Promise<SignalMsg[]> {
    if (!this.messages.length && this.socket.readyState === WebSocket.OPEN) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 15_000);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
      this.wake = undefined;
    }
    return this.messages.splice(0);
  }
}

/** Hibernating room sockets carry SDP only. Pilots keep flying if signaling is interrupted. */
export function hostedSignaling(base: string): Signaling {
  const sockets = new Map<string, Inbox>();
  const grants = new Map<string, string>();
  const key = (code: string, peer: string) => code + "/" + peer;
  const ownerKey = (code: string) => "coop-owner:" + base + "/" + code;
  const room = (code: string) => "/rooms/" + encodeURIComponent(code);
  function token(code: string, peer: string): string | undefined {
    const cached = grants.get(key(code, peer));
    if (cached || peer !== "host") return cached;
    try { return localStorage.getItem(ownerKey(code)) ?? undefined; } catch { return undefined; }
  }
  async function request(path: string, method: string, auth?: string, data?: RoomInfo): Promise<Response> {
    if (devFault("signalingDown")) throw new Error("Signaling unavailable");
    return fetch(base + path, { method, cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(8000),
      headers: { ...(auth ? { Authorization: "Bearer " + auth } : {}), ...(data ? { "Content-Type": "application/json" } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}) });
  }
  async function attach(code: string, peer: string): Promise<Inbox> {
    const auth = token(code, peer);
    if (!auth) throw new Error("Invite expired");
    const url = new URL(room(code) + "/socket", base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, ["nomad", auth]);
    const inbox = new Inbox(ws);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error("Signaling timed out")); }, 8000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("Signaling unavailable")); };
    });
    if (grants.get(key(code, peer)) !== auth) {
      ws.close();
      throw new Error("Session closed");
    }
    sockets.set(key(code, peer), inbox);
    return inbox;
  }
  function detach(code: string, peer: string): void {
    sockets.get(key(code, peer))?.socket.close();
    sockets.delete(key(code, peer));
    grants.delete(key(code, peer));
  }

  return {
    async create(info, stored) {
      const owner = stored && token(stored, "host");
      let r = owner ? await request(room(stored!) + "/resume", "POST", owner, info) : null;
      if (!r || r.status === 404 || r.status === 403) {
        r = await request("/rooms", "POST", undefined, info);
        if (r.status === 409) r = await request("/rooms", "POST", undefined, info);
      }
      if (!r.ok) throw new Error("Could not open invitation");
      const { code, token: auth } = await r.json() as { code: string; token: string };
      grants.set(key(code, "host"), auth);
      try { localStorage.setItem(ownerKey(code), auth); } catch { /* memory-only host */ }
      try {
        await attach(code, "host");
      } catch (e) {
        await this.close(code);
        throw e;
      }
      return code;
    },
    async update(code, info) {
      const r = await request(room(code) + "/update", "POST", token(code, "host"), info);
      if (!r.ok) throw new Error("Room update failed");
    },
    async info(code) {
      try {
        const r = await request(room(code) + "/info", "GET");
        if (r.ok) return { kind: "ok", info: (await r.json()).info as RoomInfo };
        return { kind: r.status === 404 ? "no_room" : "unreachable" };
      } catch { return { kind: "unreachable" }; }
    },
    async join(code) {
      const r = await request(room(code) + "/join", "POST");
      if (!r.ok) return null;
      const j = await r.json() as { peer: string; token: string; info: RoomInfo };
      grants.set(key(code, j.peer), j.token);
      try { await attach(code, j.peer); } catch (e) { detach(code, j.peer); throw e; }
      return { peer: j.peer, info: j.info };
    },
    async send(code, peer, to, data) {
      const ws = sockets.get(key(code, peer))?.socket;
      if (ws?.readyState !== WebSocket.OPEN) throw new Error("Signaling disconnected");
      ws.send(JSON.stringify({ to, data }));
    },
    async poll(code, peer) {
      let inbox = sockets.get(key(code, peer));
      if (inbox?.socket.readyState !== WebSocket.OPEN) {
        if (peer !== "host" || !grants.has(key(code, peer))) return null;
        try { inbox = await attach(code, peer); } catch { return null; }
      }
      return inbox.read();
    },
    async ice(code, peer) {
      const r = await request(room(code) + "/ice", "POST", token(code, peer));
      if (!r.ok) throw new Error("Relay credentials unavailable");
      const { iceServers } = await r.json() as { iceServers: RTCIceServer[] };
      return { iceServers };
    },
    detach,
    async close(code) {
      const auth = token(code, "host");
      detach(code, "host");
      // Network loss must never block the host's return to solo. The room expires on disconnect.
      await request(room(code) + "/close", "POST", auth).catch(() => undefined);
    },
  };
}
