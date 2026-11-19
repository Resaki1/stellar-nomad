/**
 * Guest main thread: join a room by code, open the WebRTC link, admit (credential kept per host
 * world), activate the host's snapshot as a read-only mirror, then keep retrying the room after a
 * link loss. The outstanding intent survives in localStorage and is retried on rejoin.
 */
import { getItemDef } from "@/data/content";
import { activateMirror, getActiveSave, PILOT_KEYS } from "@/save/activeSave";
import { setSessionPlayerId } from "@/save/playerId";
import type { PlayerState, SaveMeta, WreckRecord } from "@/save/types";
import { contentFingerprint } from "@/sim/session/fingerprint";
import type { GuestSession } from "@/sim/session/guestSession";
import type { WorldOperation } from "@/sim/world/commands";
import { PROTOCOL_VERSION, type RefuseReason } from "@/sim/session/protocol";
import { activeSystem } from "@/sim/systemRegistry";
import { worldAuthority } from "@/sim/world/worldAuthority";
import { hostClock, logCoop, remotePoses, setCoop } from "./coopState";
import { createSessionClient, installSessionAuthority, localGuestStore, startSessionLoops } from "./sessionClient";
import { POLL_FAST_MS, gameSignaling, type RoomInfo, type Signaling } from "./signaling";
import { pilotName } from "./pilotName";
import { devFault, devFaultMs } from "./devFault";
import { guestAnswer, type PeerLink } from "./webrtc";
import { createIncomingDelay } from "./latencyFault";

const CONNECT_TIMEOUT_MS = 40_000;
const RETRY_MS = 2000;
/** A link that opened but never delivered a snapshot (host stalled or restarting) fails the join. */
const SNAPSHOT_TIMEOUT_MS = 20_000;
/** Pilot keys an authority op writes (its reducer's playerKeys): adopted from the host when it committed unseen. */
const OP_PILOT_KEYS: Partial<Record<WorldOperation["type"], (keyof PlayerState)[]>> = {
  "expedition.give": ["propellant"],
  "ship.destroy": ["health", "propellant", "processing"],
  "ship.respawn": ["health", "ship", "propellant", "power", "processing"],
  "wreck.collect": ["propellant"],
  "processing.start": ["processing"],
  "processing.cancel": ["processing"],
  "ship.repair": ["health"],
};

interface Joined {
  code: string;
  info: RoomInfo;
  client: GuestSession;
  link: PeerLink | null;
  intentional: boolean;
  stopLoops: () => void;
  /** Test fault: from the next commit/settled on, drop the cmd channel until the link closes. */
  cut: "off" | "armed" | "cutting";
  /** Test fault: hold incoming messages (latency spike). */
  delay: ReturnType<typeof createIncomingDelay>;
}

let joined: Joined | null = null;
/** A join that has not booted yet (the card's Back cancels it). */
let pendingJoin: { cancelled: boolean; cancel?: () => void } | null = null;

/** Abandon a join still in progress: close its link; a late snapshot no longer boots the game. */
export function cancelJoin(): void {
  pendingJoin?.cancel?.();
  pendingJoin = null;
}
/** Tests: is a join still in progress, and is a session (loops, link) live? */
export const joinActivity = (): { pendingJoin: boolean; joined: boolean; link: boolean } => ({ pendingJoin: pendingJoin !== null, joined: joined !== null, link: !!joined?.link });
/** Messages this tab has handed to a guest link (tests: nothing is sent after leaving). */
let sentMsgs = 0;
export const guestSentCount = (): number => sentMsgs;

export type JoinFailure = RefuseReason | "no_room" | "version" | "timeout" | "relay" | "unreachable";

/** One short line per refusal; protocol and content mismatches read the same to a player. */
export const JOIN_MESSAGES: Record<JoinFailure, string> = {
  no_room: "Code expired or unknown",
  full: "Session full",
  protocol: "Different game version",
  version: "Different game version",
  content: "Different game version",
  credential: "Not recognised by the host",
  kicked: "Removed by the host",
  replaced: "This pilot joined from another tab",
  relay: "Relay unavailable",
  closed: "Session closed",
  timeout: "Can't reach host",
  unreachable: "Can't reach host",
};

export class JoinError extends Error {
  constructor(readonly reason: JoinFailure) {
    super(JOIN_MESSAGES[reason]);
  }
}


export function guestState(): Joined | null {
  return joined;
}

/** Our content fingerprint as the host sees it (the join-card fault perturbs it). */
function ourContent(): string {
  const c = contentFingerprint(activeSystem());
  return devFault("content") ? `${c}-mismatch` : c;
}

const guestKey = (worldId: string) => `coop-guest:${worldId}`;

export type RoomPreview =
  | { kind: "ok"; info: RoomInfo; refusal: "version" | "full" | null }
  | { kind: "no_room" }
  | { kind: "unreachable" };

/** Room preview for the join card. Read-only: touches no save, credential or room slot. */
export async function previewRoom(code: string, signaling: Signaling = gameSignaling): Promise<RoomPreview> {
  const l = await signaling.info(code.trim().toUpperCase());
  if (l.kind !== "ok") return l;
  const forced = devFault("full");
  const info = forced ? { ...l.info, players: l.info.maxPlayers } : l.info;
  const compatible = info.protocol === PROTOCOL_VERSION && info.content === ourContent();
  // The count includes links the host has not yet seen die; a returning member may rebind its slot.
  const member = !!localGuestStore(guestKey(info.worldId)).load().credential;
  const full = forced || (info.players >= info.maxPlayers && !member);
  return { kind: "ok", info, refusal: !compatible ? "version" : full ? "full" : null };
}

async function connect(code: string, signaling: Signaling): Promise<{ link: PeerLink; info: RoomInfo }> {
  const j = await signaling.join(code);
  logCoop(`join ${j ? j.peer : "no room"}`);
  if (!j) throw new JoinError((await signaling.info(code)).kind === "no_room" ? "no_room" : "unreachable");
  try {
    const deadline = performance.now() + CONNECT_TIMEOUT_MS;
    while (performance.now() < deadline) {
      const msgs = (await signaling.poll(code, j.peer)) ?? [];
      const hostMsgs = msgs.filter(m => m.from === "host").map(m => m.data as { t?: string; sdp?: string });
      if (hostMsgs.some(d => d?.t === "relay_unavailable")) throw new JoinError("relay");
      const offer = hostMsgs.find(d => d?.t === "offer" && typeof d.sdp === "string");
      if (offer) {
        logCoop("offer");
        const ice = await signaling.ice?.(code, j.peer).catch(() => { throw new JoinError("relay"); });
        const a = await guestAnswer(offer.sdp!, ice);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await signaling.send(code, j.peer, "host", { t: "answer", sdp: a.sdp });
          const timeout = new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new JoinError("timeout")), Math.max(1000, deadline - performance.now()));
          });
          return { link: await Promise.race([a.open, timeout]), info: j.info };
        } catch (e) {
          logCoop(`open failed ${e instanceof Error ? e.message : e}`);
          a.abort();
          throw e;
        } finally { clearTimeout(timer); }
      }
      await new Promise((r) => setTimeout(r, POLL_FAST_MS));
    }
    throw new JoinError("timeout");
  } finally { signaling.detach?.(code, j.peer); }
}

function bindLink(j: Joined, link: PeerLink, signaling: Signaling): void {
  j.link = link;
  j.cut = "off";
  link.onMessage = (ch, msg) => {
    const t = (msg as { t?: string })?.t;
    if (j.cut === "armed" && (t === "commit" || t === "settled")) j.cut = "cutting";
    if (j.cut === "cutting" && ch === "cmd") return;
    j.delay.receive(ch, msg);
  };
  link.onClose = () => {
    logCoop("link closed");
    if (j.link !== link) return;
    j.link = null;
    j.client.closed();
    if (!j.intentional) void reconnect(j, signaling);
  };
  j.client.attach({
    send: (ch, msg) => {
      sentMsgs++;
      link.send(ch, msg);
    },
    close: () => link.close(),
  });
  j.client.opened();
}

async function reconnect(j: Joined, signaling: Signaling): Promise<void> {
  setCoop({ status: "connecting" });
  let retryMs = RETRY_MS;
  while (!j.intentional && joined === j && !j.link) {
    try {
      const { link, info } = await connect(j.code, signaling);
      if (info.worldId !== j.info.worldId) {
        j.intentional = true;
        link.close();
        setCoop({ status: "refused", detail: "closed" });
        return;
      }
      // Left (or replaced) while connecting: do not revive an abandoned session.
      if (j.intentional || joined !== j) return link.close();
      bindLink(j, link, signaling);
      return;
    } catch (e) {
      if (joined !== j || j.intentional) return;
      if (e instanceof JoinError && e.reason === "no_room") setCoop({ status: "connecting", detail: "closed" });
      logCoop(`retry: ${e instanceof Error ? e.message : e}`);
      await new Promise((r) => setTimeout(r, retryMs));
      retryMs = Math.min(retryMs * 2, 30_000);
    }
  }
}

/**
 * Boot path for `?join=CODE`: resolves with the mirrored world's meta once the snapshot is
 * active, so the normal loading gate takes over from there.
 */
export function joinAndBoot(code: string, signaling: Signaling = gameSignaling): Promise<SaveMeta> {
  code = code.trim().toUpperCase();
  setCoop({ role: "guest", status: "connecting", code, detail: null });
  const attempt: NonNullable<typeof pendingJoin> = { cancelled: false };
  pendingJoin = attempt;
  return new Promise<SaveMeta>((resolve, reject) => {
    let booted = false;
    let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
    const fail = (e: unknown) => {
      if (snapshotTimer) clearTimeout(snapshotTimer);
      if (pendingJoin === attempt) pendingJoin = null;
      if (attempt.cancelled) return reject(e);
      setCoop({ status: e instanceof JoinError && e.reason !== "timeout" && e.reason !== "no_room" ? "refused" : "error", detail: e instanceof Error ? e.message : String(e) });
      reject(e);
    };
    attempt.cancel = () => {
      attempt.cancelled = true;
      leaveSession();
      fail(new JoinError("closed"));
    };
    connect(code, signaling).then(({ link, info }) => {
      if (attempt.cancelled) return link.close();
      if (info.protocol !== PROTOCOL_VERSION) {
        link.close();
        return fail(new JoinError("version"));
      }
      const content = ourContent();
      const client = createSessionClient({
        name: pilotName(),
        content,
        store: localGuestStore(guestKey(info.worldId)),
        onSnapshot: (rec, welcome) => {
          // Back pressed while joining: a late snapshot must not boot the game.
          if (attempt.cancelled) return;
          setSessionPlayerId(welcome.playerId);
          if (!booted) {
            booted = true;
            if (snapshotTimer) clearTimeout(snapshotTimer);
            if (pendingJoin === attempt) pendingJoin = null;
            const meta = activateMirror(rec);
            client.mirror = getActiveSave();
            installSessionAuthority(client);
            j.stopLoops = startSessionLoops(client);
            setCoop({ status: "joined", players: info.players });
            resolve(meta);
            return;
          }
          resync(client, rec);
          setCoop({ status: "joined", detail: null });
        },
        onState: (s, detail) => {
          if (s === "refused") {
            j.intentional = true;
            if (!booted) {
              leaveSession();
              fail(new JoinError(detail ?? "closed"));
            } else {
              j.link?.close();
              remotePoses.clear();
              setCoop({ status: "refused", detail: detail ?? "closed" });
            }
          } else if (s === "connecting" && booted) setCoop({ status: "connecting" });
        },
      });
      const j: Joined = { code, info, client, link: null, intentional: false, stopLoops: () => {}, cut: "off", delay: createIncomingDelay((ch, msg) => client.receive(ch, msg)) };
      joined = j;
      bindLink(j, link, signaling);
      // Test fault: the host's welcome/snapshot arrive late (Back while "Joining…", coop-check cancelJoin).
      const late = devFaultMs("joinSnapshotDelayMs");
      if (late) j.delay.hold(late);
      snapshotTimer = setTimeout(() => {
        if (booted || attempt.cancelled) return;
        leaveSession();
        fail(new JoinError("timeout"));
      }, SNAPSHOT_TIMEOUT_MS);
    }, fail);
  });
}

/** A rejoin's snapshot: adopt the host's world and our authority-owned slices; keep pilot-owned ones. */
function resync(client: GuestSession, rec: NonNullable<GuestSession["mirror"]>): void {
  const active = getActiveSave();
  const pid = client.playerId;
  if (!active || !pid) return;
  const prev = active.data.world;
  const was = prev.asteroidDeltas;
  active.data.world = rec.data.world;
  // Rocks depleted while the link was down: retire them from what this tab streams.
  for (const [fieldId, chunks] of Object.entries(rec.data.world.asteroidDeltas)) {
    for (const [chunkKey, ids] of Object.entries(chunks)) {
      const old = new Set(was[fieldId]?.[chunkKey] ?? []);
      for (const instanceId of ids) {
        if (!old.has(instanceId)) worldAuthority.deliver({ type: "asteroid.destroyed", by: "", fieldId, chunkKey, instanceId, cause: "mined" });
      }
    }
  }
  const mine = rec.data.players[pid];
  const keys: (keyof PlayerState)[] = [];
  if (mine) {
    const me = active.data.players[pid];
    // Our in-flight op committed while the link was down: the snapshot holds its pilot-key results.
    const p = client.pending;
    const unseen = p && mine.stream.seq === p.seq && mine.stream.opId === p.opId && (mine.stream.outcome as { status?: string } | null)?.status === "accepted";
    const adopt = new Set(unseen ? (OP_PILOT_KEYS[p.op.type] ?? []) : []);
    if (mine.receivedFuelKg !== me.receivedFuelKg) adopt.add("propellant");
    if (unseen && p.op.type === "item.consume") {
      const def = getItemDef(p.op.itemId);
      for (const effect of def?.useDurationS ? [] : def?.useEffects ?? []) {
        if (effect.key === "mining.currentHeat") adopt.add("power");
        if (effect.key === "ship.currentHealth") adopt.add("health");
      }
    }
    for (const k of Object.keys(mine) as (keyof PlayerState)[]) {
      // Pilot keys (telemetry prefs included) keep their live local values.
      if (PILOT_KEYS.has(k) && !adopt.has(k)) continue;
      (me as unknown as Record<string, unknown>)[k] = mine[k];
      keys.push(k);
    }
  }
  client.mirror = active;
  worldAuthority.world();
  refreshWorldMirrors(prev, rec.data.world);
  worldAuthority.deliver({ type: "player.changed", by: pid, playerId: pid, keys });
}

/**
 * Re-emit what changed while the link was down, as the events the world bridge already listens
 * to (wrecks per record; research, discoveries and replication as whole slices).
 */
function refreshWorldMirrors(prev: NonNullable<GuestSession["mirror"]>["data"]["world"], next: typeof prev): void {
  const before = new Map<string, WreckRecord>(prev.wrecks.map((w) => [w.id, w]));
  for (const w of next.wrecks) {
    const old = before.get(w.id);
    before.delete(w.id);
    if (!old) worldAuthority.deliver({ type: "wreck.created", by: "", wreck: w });
    else if (JSON.stringify(old) !== JSON.stringify(w)) worldAuthority.deliver({ type: "wreck.changed", by: "", wreck: w });
  }
  before.forEach((_, wreckId) => worldAuthority.deliver({ type: "wreck.removed", by: "", wreckId }));
  worldAuthority.deliver({ type: "research.changed", by: "", completedNodes: next.research.completedNodes });
  worldAuthority.deliver({ type: "expedition.marked", by: "" });
  worldAuthority.deliver({ type: "discoveries.changed", by: "" });
  worldAuthority.deliver({ type: "replication.changed", by: "" });
}

/** Test faults on the guest transport. */
export const guestFaults = {
  /** Lose the link right after the host commits: our claim's commit and reply never arrive. */
  cutAfterCommit(): boolean {
    if (!joined) return false;
    joined.cut = "armed";
    return true;
  },
  holdIncoming(ms: number): boolean {
    if (!joined) return false;
    joined.delay.hold(ms);
    return true;
  },
  forceReconnect(): boolean {
    if (!joined?.link) return false;
    joined.link.close();
    return true;
  },
};

/**
 * Leave: stop the loops, close the link, forget remote pilots. The mirror is only ever in memory;
 * the caller reloads to the title (module singletons make an in-place return to solo unsafe).
 */
export function leaveSession(): void {
  if (!joined) return;
  joined.intentional = true;
  joined.stopLoops();
  joined.client.closed();
  joined.link?.close();
  joined = null;
  remotePoses.clear();
  hostClock.at = -1;
  setSessionPlayerId(null);
  worldAuthority.setRemote(null);
  setCoop({ role: "solo", status: "closed", code: null, players: 1 });
}
