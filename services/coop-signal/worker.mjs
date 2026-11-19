// A room holds only invite metadata and short-lived signaling grants. Gameplay stays on WebRTC.
import { DurableObject } from "cloudflare:workers";

const GRACE_MS = 10 * 60_000;
const NEGOTIATE_MS = 90_000;
const MAX_PENDING = 12;
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const fail = status => json({ error: status }, status);
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), n => ALPHABET[n % ALPHABET.length]).join("");

function validInfo(i) {
  return i && ["hostName", "worldName", "worldId", "content"].every(k => typeof i[k] === "string" && i[k].length <= 256)
    && Number.isSafeInteger(i.protocol) && Number.isSafeInteger(i.players) && Number.isSafeInteger(i.maxPlayers)
    && i.players >= 1 && i.players <= i.maxPlayers && i.maxPlayers <= 4;
}

const worker = {
  async fetch(req, env) {
    const origin = req.headers.get("Origin");
    if (!origin || !env.GAME_ORIGINS?.split(",").includes(origin)) return fail(403);
    const cors = { "Access-Control-Allow-Origin": origin, "Vary": "Origin",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Max-Age": "3600" };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const path = new URL(req.url).pathname;
    const creating = path === "/rooms" && req.method === "POST";
    const match = /^\/rooms\/([A-Z2-9]{6})\/(info|join|socket|resume|update|ice|close)$/.exec(path);
    if (!creating && !match) return new Response(null, { status: 404, headers: cors });
    if ((creating || match?.[2] === "join" || match?.[2] === "info") &&
        !(await env.INVITES.limit({ key: req.headers.get("CF-Connecting-IP") ?? "local" })).success) {
      return new Response(null, { status: 429, headers: cors });
    }
    const code = creating ? newCode() : match[1];
    const action = creating ? "create" : match[2];
    const room = env.ROOMS.getByName(code);
    const reply = await room.fetch(new Request("https://room/" + action + "?code=" + code, req));
    if (reply.status === 101) return reply;
    return new Response(reply.body, { status: reply.status, headers: { ...Object.fromEntries(reply.headers), ...cors } });
  }
};

export default worker;

export class InviteRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    ctx.blockConcurrencyWhile(async () => { this.room = await ctx.storage.get("room"); });
  }

  sockets(peer) { return this.ctx.getWebSockets(peer).filter(ws => ws.readyState === 1); }
  save() { return this.ctx.storage.put("room", this.room); }

  async fetch(req) {
    const url = new URL(req.url);
    const action = url.pathname.slice(1);
    const code = url.searchParams.get("code");
    const token = req.headers.get("Authorization")?.replace(/^Bearer /, "");
    const now = Date.now();
    if (action === "create" || action === "resume" || action === "update") {
      if (req.method !== "POST") return fail(405);
      const reader = req.body?.getReader();
      if (!reader) return fail(400);
      let bytes = 0;
      let text = "";
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2048) { await reader.cancel(); return fail(413); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      let info;
      try { info = JSON.parse(text); } catch { return fail(400); }
      if (!validInfo(info)) return fail(400);
      if (action === "create") {
        if (this.room) return fail(409);
        this.room = { owner: crypto.randomUUID(), info, peers: {}, closed: false, expires: now + GRACE_MS };
      } else {
        if (!this.room || this.room.expires <= now) return fail(404);
        if (!token || token !== this.room.owner || info.worldId !== this.room.info.worldId) return fail(403);
        if (action === "update" && this.room.closed) return fail(404);
        this.room.info = info;
        if (action === "resume") {
          this.room.closed = false;
          this.room.expires = now + GRACE_MS;
        }
      }
      await this.save();
      await this.scheduleAlarm();
      return json({ code, token: this.room.owner });
    }

    const r = this.room;
    if (!r || r.closed || r.expires <= now) return fail(404);
    if (action === "info" && req.method === "GET") return json({ info: r.info });
    if (action === "join" && req.method === "POST") {
      if (!this.sockets("host").length) return fail(503);
      this.prunePeers(now);
      if (Object.keys(r.peers).length >= MAX_PENDING) return fail(429);
      const peer = crypto.randomUUID();
      r.peers[peer] = { token: crypto.randomUUID(), expires: now + NEGOTIATE_MS };
      await this.save();
      await this.scheduleAlarm();
      return json({ info: r.info, peer, token: r.peers[peer].token });
    }
    if (action === "close" && req.method === "POST") {
      if (token !== r.owner) return fail(403);
      r.closed = true;
      r.expires = now + GRACE_MS;
      r.peers = {};
      for (const ws of this.ctx.getWebSockets()) ws.close(1000, "Room closed");
      await this.save();
      await this.scheduleAlarm();
      return json({ ok: true });
    }
    if (action === "socket" && req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      // The browser can send protocols in the handshake. Echo only the application protocol.
      const [protocol, key] = (req.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map(s => s.trim());
      if (protocol !== "nomad" || !key) return fail(403);
      const peer = key === r.owner ? "host" : Object.keys(r.peers).find(id => r.peers[id].token === key && r.peers[id].expires > now);
      if (!peer) return fail(403);
      if (peer !== "host" && !this.sockets("host").length) return fail(503);
      for (const old of this.sockets(peer)) old.close(1000, "Reconnected");
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, [peer]);
      if (peer === "host") {
        r.expires = Number.MAX_SAFE_INTEGER;
        await this.save();
        await this.scheduleAlarm();
      } else {
        for (const host of this.sockets("host")) host.send(JSON.stringify({ from: peer, data: { t: "join" } }));
      }
      return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": "nomad" } });
    }
    if (action === "ice" && req.method === "POST") {
      const grant = token === r.owner ? r : Object.values(r.peers).find(p => p.token === token && p.offered && p.expires > now);
      if (!grant) return fail(403);
      if (grant.ice && grant.iceUntil > now) return json(grant.ice);
      if (!this.env.TURN_KEY_ID && !this.env.TURN_API_TOKEN) return json({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] });
      if (!this.env.TURN_KEY_ID || !this.env.TURN_API_TOKEN) return fail(503);
      const ttl = 3600;
      const response = await fetch("https://rtc.live.cloudflare.com/v1/turn/keys/" + encodeURIComponent(this.env.TURN_KEY_ID) + "/credentials/generate-ice-servers", {
        method: "POST", headers: { authorization: "Bearer " + this.env.TURN_API_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ ttl })
      });
      if (!response.ok) return fail(503);
      const { iceServers } = await response.json();
      if (!Array.isArray(iceServers)) return fail(503);
      grant.ice = { iceServers };
      grant.iceUntil = now + (ttl - 300) * 1000;
      await this.save();
      return json(grant.ice);
    }
    return fail(405);
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 32_768) return ws.close(1009);
    const [from] = this.ctx.getTags(ws);
    const room = this.room;
    if (!room || room.closed || !this.sockets(from).includes(ws)) return ws.close(1008);
    let m;
    try { m = JSON.parse(message); } catch { return ws.close(1007); }
    if (!m || typeof m !== "object") return ws.close(1007);
    const host = from === "host";
    const peer = host ? m?.to : from;
    const grant = Object.hasOwn(room.peers, peer) && room.peers[peer];
    if (!grant || grant.expires <= Date.now()) return;
    if (host && m.data?.t === "relay_unavailable") {
      for (const target of this.sockets(peer)) target.send(JSON.stringify({ from, data: { t: "relay_unavailable" } }));
      return;
    }
    if ((!host && m.to !== "host") || m.data?.t !== (host ? "offer" : "answer") || typeof m.data.sdp !== "string") return;
    if (host) {
      if (grant.offered) return;
      grant.offered = true;
    } else {
      if (!grant.offered || grant.answered) return;
      grant.answered = true;
    }
    await this.save();
    for (const target of this.sockets(m.to)) target.send(JSON.stringify({ from, data: { t: m.data.t, sdp: m.data.sdp } }));
  }

  async webSocketClose(ws, code) {
    // Complete the close handshake even on compatibility dates without automatic replies.
    ws.close(code === 1000 ? 1000 : 1001);
    const [id] = this.ctx.getTags(ws);
    if (!this.room || id !== "host" || this.sockets("host").some(s => s !== ws)) return;
    this.room.expires = Date.now() + GRACE_MS;
    await this.save();
    await this.scheduleAlarm();
  }

  prunePeers(now) {
    for (const [id, p] of Object.entries(this.room.peers)) {
      if (p.expires > now) continue;
      delete this.room.peers[id];
      for (const ws of this.sockets(id)) ws.close(1000, "Negotiation expired");
    }
  }

  async scheduleAlarm() {
    const next = Math.min(this.room.expires, ...Object.values(this.room.peers).map(p => p.expires));
    if (next === Number.MAX_SAFE_INTEGER) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  async alarm() {
    if (!this.room || this.room.expires <= Date.now()) {
      await this.ctx.storage.deleteAll();
      this.room = undefined;
      return;
    }
    this.prunePeers(Date.now());
    await this.save();
    await this.scheduleAlarm();
  }
}
