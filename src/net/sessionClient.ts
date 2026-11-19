/**
 * Browser glue around the headless GuestSession, shared by the host's own client and guests:
 * mirror wiring (events through the authority facade), telemetry and pose loops, clock samples.
 */
import { getActiveSave, getLocalPlayerState, sampleCollectors } from "@/save/activeSave";
import type { PlayerId, SaveData, SaveMeta } from "@/save/types";
import { getLocalPlayerShip, localRenderPose } from "@/sim/entities";
import { GuestSession, type GuestState, type GuestStore } from "@/sim/session/guestSession";
import { systemClock } from "@/sim/session/ports";
import type { RefuseReason, Telemetry, WelcomeMsg } from "@/sim/session/protocol";
import { worldAuthority } from "@/sim/world/worldAuthority";
import { hostClock, pushRemotePose } from "./coopState";

const POSE_MS = 1000 / 15;
const TELEMETRY_MS = 2000;

/** Pilot-owned values from the local record (collectors sampled first). */
export function collectTelemetry(): Telemetry | undefined {
  if (!getActiveSave()) return undefined;
  sampleCollectors();
  const p = getLocalPlayerState();
  const tel: Telemetry = {
    health: p.health,
    propellant: { ordinaryKg: p.propellant.ordinaryKg, protectedKg: p.propellant.protectedKg },
    power: { capacitor01: p.power.capacitor01, heat01: p.power.heat01 },
    prefs: { commsPlayed: p.commsPlayed.slice(-512), starMarkers: p.starMarkers.slice(-256), aiName: p.aiName, trackedProject: p.trackedProject },
  };
  if (p.ship) tel.pose = { frameId: p.ship.frameId, positionKm: [...p.ship.positionKm], quaternion: [...p.ship.quaternion] };
  if (p.processing) tel.processing = { id: p.processing.id, elapsedS: p.processing.elapsedS, committedKg: p.processing.committedKg };
  return tel;
}

export interface SessionClientHooks {
  local?: boolean;
  playerId?: PlayerId;
  name: string;
  content: string;
  store: GuestStore;
  onSnapshot?: (rec: { meta: SaveMeta; data: SaveData }, welcome: WelcomeMsg) => void;
  onState?: (s: GuestState, detail?: RefuseReason) => void;
}

export function createSessionClient(h: SessionClientHooks): GuestSession {
  return new GuestSession({
    clock: systemClock,
    name: h.name,
    content: h.content,
    store: h.store,
    local: h.local,
    playerId: h.playerId,
    telemetry: collectTelemetry,
    onEvent: (e) => worldAuthority.deliver(e),
    onAsteroid: (fieldId, chunkKey, instanceId) => {
      worldAuthority.world();
      worldAuthority.asteroids.add(fieldId, chunkKey, instanceId);
    },
    onPose: pushRemotePose,
    onClock: (c) => {
      hostClock.epochMs = c.epochMs;
      hostClock.rate = c.rate;
      hostClock.at = performance.now();
    },
    onSnapshot: h.onSnapshot,
    onState: h.onState,
  });
}

/** Pose at 15 Hz and telemetry every 2 s while joined. Returns a stop function. */
export function startSessionLoops(gs: GuestSession): () => void {
  let seq = 0;
  const pose = setInterval(() => {
    const s = getLocalPlayerShip();
    if (!s || gs.status !== "joined") return;
    // The pose as drawn, stamped with its frame time: receivers interpolate on this timeline.
    const rp = localRenderPose;
    const drawn = rp.atMs >= 0 && rp.frameId === s.frameId;
    gs.sendPose({
      seq: ++seq,
      tick: drawn ? rp.atMs : performance.now(),
      f: s.frameId,
      p: drawn ? [rp.relKm[0], rp.relKm[1], rp.relKm[2]] : [s.posKm.x, s.posKm.y, s.posKm.z],
      v: [s.velKmps.x, s.velKmps.y, s.velKmps.z],
      q: drawn ? [rp.quat[0], rp.quat[1], rp.quat[2], rp.quat[3]] : [s.quat.x, s.quat.y, s.quat.z, s.quat.w],
      fl: s.boosting ? 2 : 0,
    });
  }, POSE_MS);
  const tel = setInterval(() => gs.sendTelemetry(), TELEMETRY_MS);
  return () => {
    clearInterval(pose);
    clearInterval(tel);
  };
}

/** Install the session as the authority: submissions go to the host and settle later. */
export function installSessionAuthority(gs: GuestSession): void {
  worldAuthority.setRemote({ submit: (op) => gs.submit(op) });
}

export function localGuestStore(key: string): GuestStore {
  return {
    load() {
      try {
        return JSON.parse(localStorage.getItem(key) ?? "{}");
      } catch {
        return {};
      }
    },
    save(rec) {
      try {
        localStorage.setItem(key, JSON.stringify(rec));
      } catch {
        /* private mode: a reload loses the pending intent */
      }
    },
  };
}
