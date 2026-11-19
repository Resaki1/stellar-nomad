/**
 * Host main thread: hand the world to the host worker, admit our own client over the worker
 * port (connection "local"), open a signaling room and relay each guest's WebRTC link.
 */
import { getActiveSave, reclaimFromHost, releaseToHost } from "@/save/activeSave";
import { getDevicePlayerId, getLocalPlayerId } from "@/save/playerId";
import type { WorldOperation } from "@/sim/world/commands";
import { worldAuthority } from "@/sim/world/worldAuthority";
import type { GuestSession } from "@/sim/session/guestSession";
import { MAX_PLAYERS, PROTOCOL_VERSION } from "@/sim/session/protocol";
import type { HostWorkerToMain, MainToHostWorker } from "@/workers/hostWorkerProtocol";
import { coopSnapshot, logCoop, setCoop } from "./coopState";
import { createSessionClient, installSessionAuthority, startSessionLoops } from "./sessionClient";
import { POLL_FAST_MS, POLL_IDLE_MS, localSignaling, type RoomInfo, type Signaling } from "./signaling";
import { hostOffer, type PeerLink } from "./webrtc";
import { createIncomingDelay } from "./latencyFault";
import { pilotName } from "./pilotName";
import { devFaultMs } from "./devFault";

const LOCAL = "local";
const READY_TIMEOUT_MS = 15_000;
/** An offer the guest never answered is dropped (and its peer connection closed) after this. */
const OFFER_TTL_MS = 30_000;
/** Unanswered offers held at once: each is a live RTCPeerConnection. */
const MAX_OFFERS = 8;
const roomKey = (worldId: string) => `coop-room:${worldId}`;

interface Hosting {
  worker: Worker;
  client: GuestSession;
  code: string;
  info: RoomInfo;
  peers: Map<string, PeerLink>;
  offers: Map<string, { accept: (answer: string) => Promise<PeerLink>; abort: () => void; at: number }>;
  stopLoops: () => void;
  stopPoll: boolean;
  inspects: Map<number, (v: unknown) => void>;
  /** Test fault: hold what the worker sends our own client (latency spike). */
  delay: ReturnType<typeof createIncomingDelay>;
}

let hosting: Hosting | null = null;
let inspectSeq = 0;

export function isHosting(): boolean {
  return hosting !== null;
}

const post = (w: Worker, m: MainToHostWorker): void => w.postMessage(m);

/** Open the current world to friends. Resolves with the room code. */
export async function startHosting(signaling: Signaling = localSignaling, hostName = pilotName()): Promise<string> {
  if (hosting) return hosting.code;
  const rec = getActiveSave();
  if (!rec) throw new Error("no world");
  setCoop({ role: "host", status: "starting", detail: null });
  // Hand-off window (flush → worker load → session installed): a local commit here would mutate
  // only this tab's record and never reach the worker. Hold intents as pending until one owns them.
  const held: WorldOperation[] = [];
  worldAuthority.setRemote({
    submit: (op) => {
      held.push(op);
      return { status: "pending", opId: op.opId, by: getLocalPlayerId() };
    },
  });
  const settleHeldLocally = () => {
    worldAuthority.setRemote(null);
    for (const op of held.splice(0)) worldAuthority.deliver({ type: "op.settled", outcome: worldAuthority.local.submit(op, getLocalPlayerId()) });
  };
  try {
    await releaseToHost();
  } catch (e) {
    settleHeldLocally();
    setCoop({ role: "solo", status: "error", detail: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  const worker = new Worker(new URL("../workers/hostWorker.ts", import.meta.url), { type: "module" });
  try {
    return await openSession(worker, rec.meta.id, signaling, hostName, held);
  } catch (e) {
    // Nothing reached a guest yet: stop the worker (its lock goes with it) and keep playing solo.
    worker.terminate();
    await reclaimFromHost();
    settleHeldLocally();
    setCoop({ role: "solo", status: "error", detail: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

async function openSession(worker: Worker, worldId: string, signaling: Signaling, hostName: string, held: WorldOperation[]): Promise<string> {
  const ready = new Promise<Extract<HostWorkerToMain, { t: "ready" }>>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("host worker did not start")), READY_TIMEOUT_MS);
    worker.addEventListener("message", function once(ev: MessageEvent<HostWorkerToMain>) {
      if (ev.data.t === "ready" || ev.data.t === "error") {
        clearTimeout(t);
        worker.removeEventListener("message", once);
        if (ev.data.t === "ready") resolve(ev.data);
        else reject(new Error(ev.data.message));
      }
    });
  });
  // Test fault: a slow worker start widens the hand-off window (coop-check handoff).
  const slow = devFaultMs("hostStartDelayMs");
  if (slow) await new Promise((r) => setTimeout(r, slow));
  post(worker, { t: "init", worldId, hostPlayerId: getDevicePlayerId(), hostName });
  const r = await ready;

  const client = createSessionClient({
    local: true,
    playerId: getDevicePlayerId(),
    name: hostName,
    content: r.content,
    store: { load: () => ({}), save: () => {} },
    // Our own record already is the world: keep it as the mirror (atoms read from it).
    onSnapshot: () => {
      const active = getActiveSave();
      if (active) client.mirror = active;
    },
  });
  const info: RoomInfo = { worldId, worldName: r.worldName, hostName, players: 1, maxPlayers: MAX_PLAYERS, protocol: PROTOCOL_VERSION, content: r.content };
  const stored = (() => {
    try {
      return localStorage.getItem(roomKey(worldId)) ?? undefined;
    } catch {
      return undefined;
    }
  })();
  const code = await signaling.create(info, stored);
  try {
    localStorage.setItem(roomKey(worldId), code);
  } catch {
    /* a reload gets a new code */
  }
  const h: Hosting = { worker, client, code, info, peers: new Map(), offers: new Map(), stopLoops: () => {}, stopPoll: false, inspects: new Map(), delay: createIncomingDelay((ch, msg) => client.receive(ch, msg)) };
  hosting = h;

  worker.addEventListener("message", (ev: MessageEvent<HostWorkerToMain>) => {
    const m = ev.data;
    if (m.t === "send") {
      if (m.conn === LOCAL) h.delay.receive(m.ch, m.msg);
      else h.peers.get(m.conn)?.send(m.ch, m.msg);
    } else if (m.t === "drop") {
      if (m.conn !== LOCAL) h.peers.get(m.conn)?.close();
    } else if (m.t === "state") {
      if (m.state === "storage_failed") setCoop({ status: "error", detail: "storage" });
    } else if (m.t === "inspect") {
      h.inspects.get(m.req)?.(m.value);
      h.inspects.delete(m.req);
    }
  });

  client.attach({ send: (ch, msg) => post(worker, { t: "msg", conn: LOCAL, ch, msg }), close: () => {} });
  post(worker, { t: "open", conn: LOCAL, local: true });
  client.opened();
  // Intents held during the hand-off go first, in order (the session settles them).
  for (const op of held.splice(0)) client.submit(op);
  installSessionAuthority(client);
  h.stopLoops = startSessionLoops(client);
  setCoop({ role: "host", status: "joined", code, players: 1 });
  void pollLoop(h, signaling);
  return code;
}

async function pollLoop(h: Hosting, signaling: Signaling): Promise<void> {
  while (!h.stopPoll) {
    const now = performance.now();
    h.offers.forEach((o, peer) => {
      if (now - o.at > OFFER_TTL_MS) {
        o.abort();
        h.offers.delete(peer);
      }
    });
    const msgs = await signaling.poll(h.code, "host");
    for (const m of msgs ?? []) void onSignal(h, signaling, m.from, m.data as { t?: string; sdp?: string });
    await new Promise((r) => setTimeout(r, h.offers.size > 0 ? POLL_FAST_MS : POLL_IDLE_MS));
  }
}

async function onSignal(h: Hosting, signaling: Signaling, peer: string, data: { t?: string; sdp?: string }): Promise<void> {
  logCoop(`${peer} ${data.t}`);
  if (data.t === "join") {
    // No capacity check here: the worker refuses "full" itself and lets a member rebind its slot.
    if (h.offers.size >= MAX_OFFERS) return;
    const o = await hostOffer();
    h.offers.get(peer)?.abort();
    h.offers.set(peer, { accept: o.accept, abort: o.abort, at: performance.now() });
    await signaling.send(h.code, "host", peer, { t: "offer", sdp: o.sdp });
    return;
  }
  if (data.t === "answer" && typeof data.sdp === "string") {
    const offer = h.offers.get(peer);
    h.offers.delete(peer);
    if (!offer) return;
    let link: PeerLink;
    try {
      link = await offer.accept(data.sdp);
    } catch (e) {
      offer.abort();
      logCoop(`${peer} failed ${e instanceof Error ? e.message : e}`);
      return;
    }
    if (h.stopPoll) return link.close();
    const old = h.peers.get(peer);
    if (old) {
      h.peers.delete(peer);
      post(h.worker, { t: "gone", conn: peer });
      old.close();
    }
    h.peers.set(peer, link);
    link.onMessage = (ch, msg) => post(h.worker, { t: "msg", conn: peer, ch, msg });
    link.onClose = () => {
      if (h.peers.get(peer) !== link) return;
      h.peers.delete(peer);
      post(h.worker, { t: "gone", conn: peer });
      updatePlayers(h, signaling);
    };
    post(h.worker, { t: "open", conn: peer, local: false });
    updatePlayers(h, signaling);
  }
}

function updatePlayers(h: Hosting, signaling: Signaling): void {
  h.info = { ...h.info, players: 1 + h.peers.size };
  setCoop({ players: h.info.players });
  signaling.create(h.info, h.code).catch(() => logCoop("room update failed"));
}

/** Close the session (worker drains + saves + releases the lock), then reload into solo. */
export async function stopHosting(signaling: Signaling = localSignaling, reload = true): Promise<void> {
  const h = hosting;
  if (!h) return;
  h.stopPoll = true;
  h.stopLoops();
  const closed = new Promise<void>((resolve) => {
    h.worker.addEventListener("message", (ev: MessageEvent<HostWorkerToMain>) => {
      if (ev.data.t === "closed") resolve();
    });
    setTimeout(resolve, 5000);
  });
  post(h.worker, { t: "close" });
  await closed;
  h.peers.forEach((p) => p.close());
  h.offers.forEach((o) => o.abort());
  h.offers.clear();
  h.worker.terminate();
  await signaling.close(h.code);
  hosting = null;
  setCoop({ role: "solo", status: "closed", code: null, players: 1 });
  if (reload) window.location.reload();
}

/** Worker-side record (tests / host UI): a player's state, or session info without an id. */
export function inspectHost(playerId?: string): Promise<unknown> {
  const h = hosting;
  if (!h) return Promise.resolve(null);
  const req = ++inspectSeq;
  return new Promise((resolve) => {
    h.inspects.set(req, resolve);
    post(h.worker, { t: "inspect", req, playerId });
  });
}

/** Test fault: hold our own client's incoming messages for `ms`. */
export function holdHostIncoming(ms: number): boolean {
  hosting?.delay.hold(ms);
  return hosting !== null;
}

export function hostClient(): GuestSession | null {
  return hosting?.client ?? null;
}

export const hostCode = (): string | null => (coopSnapshot().role === "host" ? coopSnapshot().code : null);
