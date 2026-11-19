/**
 * Browser glue around the headless GuestSession, shared by the host's own client and guests:
 * mirror wiring (events through the authority facade), telemetry and pose loops, clock samples.
 */
import { getActiveSave, getLocalPlayerState, sampleCollectors } from "@/save/activeSave";
import type { PlayerId, SaveData, SaveMeta } from "@/save/types";
import { getLocalPlayerShip, localBeamPose, localRenderPose } from "@/sim/entities";
import { repositionState } from "@/sim/ship/reposition";
import { GuestSession, type GuestState, type GuestStore } from "@/sim/session/guestSession";
import { systemClock } from "@/sim/session/ports";
import type { RefuseReason, Telemetry, WelcomeMsg } from "@/sim/session/protocol";
import { worldAuthority } from "@/sim/world/worldAuthority";
import { getLocalPlayerId } from "@/save/playerId";
import { hostClock, pushRemotePose, remotePoses } from "./coopState";
import { onPilotNameChange } from "./pilotName";

const POSE_MS = 1000 / 15;
const TELEMETRY_MS = 2000;
const BEAM_FRESH_MS = 200;

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
    onEvent: (e) => {
      if (e.type === "ship.destroyed" || e.type === "ship.respawned") {
        remotePoses.delete(e.by);
        if (e.by === getLocalPlayerId()) localRenderPose.atMs = -1;
      }
      worldAuthority.deliver(e);
    },
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
    onSnapshot: (rec, welcome) => {
      remotePoses.clear();
      h.onSnapshot?.(rec, welcome);
    },
    onState: h.onState,
  });
}

/** Pose at 15 Hz and telemetry every 2 s while joined. Returns a stop function. */
export function startSessionLoops(gs: GuestSession): () => void {
  let seq = 0;
  const pose = setInterval(() => {
    const s = getLocalPlayerShip();
    if (!s || gs.status !== "joined" || getLocalPlayerState().isDead || localRenderPose.atMs < 0) return;
    // The respawn commit arrives before its reply queues the runtime reposition.
    if (gs.pending?.op.type === "ship.respawn" || repositionState.pending) return;
    // The pose as drawn, stamped with its frame time: receivers interpolate on this timeline.
    const rp = localRenderPose;
    const drawn = rp.atMs >= 0 && rp.frameId === s.frameId;
    const b = localBeamPose;
    // A beam drawn within the last few frames, in the frame the pose is sent in.
    const beam = b.on && b.frameId === s.frameId && performance.now() - b.atMs < BEAM_FRESH_MS;
    gs.sendPose({
      seq: ++seq,
      tick: drawn ? rp.atMs : performance.now(),
      f: s.frameId,
      p: drawn ? [rp.relKm[0], rp.relKm[1], rp.relKm[2]] : [s.posKm.x, s.posKm.y, s.posKm.z],
      v: [s.velKmps.x, s.velKmps.y, s.velKmps.z],
      q: drawn ? [rp.quat[0], rp.quat[1], rp.quat[2], rp.quat[3]] : [s.quat.x, s.quat.y, s.quat.z, s.quat.w],
      fl: (s.boosting ? 2 : 0) | (beam ? 1 : 0) | (beam && b.dim ? 4 : 0),
      th: Math.round(Math.min(1, Math.max(0, drawn ? rp.throttle : 0)) * 255),
      ...(beam ? { b: [b.relKm[0], b.relKm[1], b.relKm[2]] as [number, number, number] } : {}),
    });
  }, POSE_MS);
  const tel = setInterval(() => gs.sendTelemetry(), TELEMETRY_MS);
  // The device-wide name changed (Settings): the host relabels us for everyone.
  const offName = onPilotNameChange((n) => gs.rename(n));
  return () => {
    clearInterval(pose);
    clearInterval(tel);
    offName();
  };
}

/** Install the session as the authority: submissions go to the host and settle later. */
export function installSessionAuthority(gs: GuestSession): void {
  worldAuthority.setRemote({ submit: (op) => gs.submit(op), sendImpact: (contact) => gs.sendImpact(contact) });
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
