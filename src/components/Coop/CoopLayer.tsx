"use client";

/**
 * In-Canvas co-op views: other pilots' ships at interpolated poses (host-confirmed contacts use a separate path)
 * with their plume and mining beam, their POI markers, and the host clock follower. Renders
 * nothing while solo.
 */
import { pilotTint } from "@/data/markerCategories";
import { HOST_SILENCE_MS, POSE_BEAM_MISS } from "@/sim/session/protocol";
import { Suspense, memo, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useStore } from "jotai";
import { RemoteStarterSurvey } from "@/components/models/ships/StarterSurvey";
import { MiningBeam, computeShipNoseLocal } from "@/components/Mining/MiningSystem";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { getLocalPlayerId } from "@/save/playerId";
import { worldAuthority } from "@/sim/world/worldAuthority";
import { spawnVFXEventAtom } from "@/store/vfx";
import { getActiveSave } from "@/save/activeSave";
import { frameOriginKm, isFrameId, type FrameId } from "@/sim/frames";
import { simEpochMsAtom, simEpochNudge, simRateAtom } from "@/store/simTime";
import { pilotPOIsAtom, type POIDef } from "@/store/poi";
import { REMOTE_STALE_MS, coopSnapshot, hostClock, logCoop, remotePoses, type PoseSample } from "@/net/coopState";
import { MAX_PLAYERS } from "@/sim/session/protocol";
import { getLocalPlayerShip } from "@/sim/entities";
import { FRAME_PRIORITY_REMOTE_SHIPS } from "@/components/frameOrder";

const INTERP_DELAY_MS = 100;
const MAX_EXTRAPOLATE_MS = 250;
/** Clock error above this snaps; below it is eased out over a few seconds. */
const CLOCK_SNAP_MS = 5000;
const CLOCK_EASE_PER_S = 0.5;
const LIST_REFRESH_MS = 500;
/** One ship slot per possible remote pilot, mounted for the whole session (never per pose). */
const SLOTS = MAX_PLAYERS - 1;
/** The remote plume follows the sent throttle at the local plume's smoothing rate. */
const EXHAUST_SMOOTH_RATE = 6;
/** No beam pose for this long (interpolated timeline): the beam stops drawing. */
const BEAM_STALE_MS = 300;
/** Pilots are marked at any range: a friend across the system is still a friend. */
const PILOT_MAX_KM = 1e15;

const _o = new THREE.Vector3();
const _b = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

/** Interpolated frame-relative pose at `t` (ms) into `outP` (km) / `outQ`; returns the frame id. */
function samplePose(buf: readonly PoseSample[], t: number, outP: THREE.Vector3, outQ: THREE.Quaternion): string | null {
  const n = buf.length;
  if (n === 0) return null;
  const last = buf[n - 1];
  if (t >= last.at || n === 1) {
    const dt = Math.min(Math.max(t - last.at, 0), MAX_EXTRAPOLATE_MS) / 1000;
    outP.set(last.p[0] + last.v[0] * dt, last.p[1] + last.v[1] * dt, last.p[2] + last.v[2] * dt);
    outQ.set(last.q[0], last.q[1], last.q[2], last.q[3]);
    return last.f;
  }
  let i = n - 2;
  while (i > 0 && buf[i].at > t) i--;
  const a = buf[i];
  const b = buf[i + 1];
  // A frame change resets interpolation: never blend positions from two frames.
  if (a.f !== b.f || t <= a.at) {
    const s = t <= a.at ? a : b;
    outP.set(s.p[0], s.p[1], s.p[2]);
    outQ.set(s.q[0], s.q[1], s.q[2], s.q[3]);
    return s.f;
  }
  const k = (t - a.at) / Math.max(1e-3, b.at - a.at);
  outP.set(a.p[0] + (b.p[0] - a.p[0]) * k, a.p[1] + (b.p[1] - a.p[1]) * k, a.p[2] + (b.p[2] - a.p[2]) * k);
  _qa.set(a.q[0], a.q[1], a.q[2], a.q[3]);
  _qb.set(b.q[0], b.q[1], b.q[2], b.q[3]);
  outQ.slerpQuaternions(_qa, _qb, k);
  return a.f;
}

/** The newest sample at or before `t`: activity follows the same delayed timeline as the hull. */
function sampleAt(buf: readonly PoseSample[], t: number): PoseSample | null {
  for (let i = buf.length - 1; i >= 0; i--) if (buf[i].at <= t) return buf[i];
  return buf[0] ?? null;
}

/** Test probe: per-frame rendered remote positions while `on` (scripts read and clear `rows`). */
export const remoteShipProbe = { on: false, rows: [] as number[][] };

/** Test probe: what each slot drew last frame, plus counters since `reset()`. */
export const remoteFxProbe = {
  slots: Array.from({ length: SLOTS }, () => ({ id: "", shown: false, beam: false, beamLenM: 0, beamLenMax: 0, exhaust: 0, frames: 0, beamFrames: 0, exhaustMax: 0 })),
  reset(): void {
    for (const s of remoteFxProbe.slots) s.frames = s.beamFrames = s.exhaustMax = s.beamLenMax = 0;
  },
};

/** Per-slot beam endpoints (scene metres) and state, mutated each frame. */
const slotBeams = Array.from({ length: SLOTS }, () => ({ start: new THREE.Vector3(), end: new THREE.Vector3(), remote: { on: false, dim: false }, hit: { value: true } }));

function memberName(id: string): string {
  return getActiveSave()?.data.world.members[id]?.name || "Replicant";
}

/**
 * A remote pilot slot: hull, plume and mining beam, mounted once at session start and drawn
 * once in a warm-up frame before any of it may show: first sight used to build its pipelines
 * mid-frame (a multi-second pose stall on both pages). `slots[slot]` names the pilot; `defs` holds its live POI marker.
 */
const RemoteShip = memo(function RemoteShip({ slot, slots, defs, ready }: { slot: number; slots: (string | null)[]; defs: Map<string, POIDef>; ready: React.RefObject<boolean> }) {
  const ref = useRef<THREE.Group>(null!);
  const beamRef = useRef<THREE.Group>(null!);
  const worldOrigin = useWorldOrigin();
  const p = useRef(new THREE.Vector3());
  const throttle = useRef(0);
  const nose = useRef<THREE.Vector3 | null>(null);
  useFrame((_, dt) => {
    const beam = slotBeams[slot];
    const g = ref.current;
    const id = slots[slot];
    const buf = id ? remotePoses.get(id) : undefined;
    const now = performance.now();
    const t = now - INTERP_DELAY_MS;
    const f = buf && buf.length > 0 && now - buf[buf.length - 1].at < REMOTE_STALE_MS ? samplePose(buf, t, p.current, g.quaternion) : null;
    const live = f !== null && isFrameId(f);
    // The hull waits for its pipelines; the marker does not.
    const show = live && ready.current;
    if (show && !g.visible) logCoop(`ship ${slot} shown ${id}`);
    g.visible = show;
    const probe = remoteFxProbe.slots[slot];
    probe.id = id ?? "";
    probe.shown = show;
    if (!live || !f || !id || !buf) {
      beam.remote.on = beamRef.current.visible = probe.beam = false;
      throttle.current = probe.exhaust = 0;
      return;
    }
    frameOriginKm(f, _o);
    const wo = worldOrigin.worldOriginKm;
    g.position.set((_o.x + p.current.x - wo.x) * 1000, (_o.y + p.current.y - wo.y) * 1000, (_o.z + p.current.z - wo.z) * 1000);
    // The marker: live frame-relative position, projected later this frame (POIProjector).
    const def = defs.get(id);
    if (def) {
      def.positionKm[0] = p.current.x;
      def.positionKm[1] = p.current.y;
      def.positionKm[2] = p.current.z;
      def.frameId = f as FrameId;
    }
    // Activity at the interpolated instant: plume from the sent throttle, beam from its endpoint.
    const s = sampleAt(buf, t);
    throttle.current += ((s?.th ?? 0) - throttle.current) * Math.min(1, EXHAUST_SMOOTH_RATE * dt);
    if (throttle.current < 0.001) throttle.current = 0;
    const bs = s && s.b && t - s.at < BEAM_STALE_MS && isFrameId(s.f) ? s : null;
    const beamOn = show && bs !== null;
    if (bs?.b && beamOn) {
      // The exported mining socket in ship-root space.
      if (!nose.current) {
        const n = new THREE.Vector3();
        nose.current = computeShipNoseLocal(g, n) ? n : new THREE.Vector3();
      }
      beam.start.copy(nose.current).applyQuaternion(g.quaternion).add(g.position);
      frameOriginKm(bs.f, _b);
      beam.end.set((_b.x + bs.b[0] - wo.x) * 1000, (_b.y + bs.b[1] - wo.y) * 1000, (_b.z + bs.b[2] - wo.z) * 1000);
      beam.remote.dim = (bs.fl & 4) !== 0;
      beam.hit.value = (bs.fl & POSE_BEAM_MISS) === 0;
    }
    beam.remote.on = beamRef.current.visible = beamOn;
    probe.beam = beamOn;
    probe.beamLenM = beamOn ? beam.start.distanceTo(beam.end) : 0;
    probe.exhaust = show ? throttle.current : 0;
    probe.frames++;
    if (beamOn) probe.beamFrames++;
    probe.exhaustMax = Math.max(probe.exhaustMax, probe.exhaust);
    probe.beamLenMax = Math.max(probe.beamLenMax, probe.beamLenM);
    if (remoteShipProbe.on) {
      const l = buf[buf.length - 1];
      const ls = getLocalPlayerShip();
      remoteShipProbe.rows.push([now, slot, g.position.x, g.position.y, g.position.z, p.current.x, p.current.y, p.current.z, buf.length, l.seq, now - l.at, l.p[0], l.p[1], l.p[2],
        wo.x, wo.y, wo.z, _o.x, _o.y, _o.z, ls?.posKm.x ?? 0, ls?.posKm.y ?? 0, ls?.posKm.z ?? 0, ls?.prevPosKm.x ?? 0, ls?.prevPosKm.y ?? 0, ls?.prevPosKm.z ?? 0, ls ? ls.velKmps.length() * 1000 : -1]);
    }
  }, FRAME_PRIORITY_REMOTE_SHIPS);
  return (
    <group name={`remoteSlot:${slot}`}>
      <group ref={ref} name={`remoteShip:${slot}`} visible={false}>
        <RemoteStarterSurvey thrust={throttle} />
      </group>
      <group ref={beamRef} visible={false}>
        <MiningBeam start={slotBeams[slot].start} end={slotBeams[slot].end} remote={slotBeams[slot].remote} hit={slotBeams[slot].hit} />
      </group>
    </group>
  );
});

/**
 * Warm-up frame: every slot part (hull, plume, beam) is drawn ONCE, behind the camera, so its
 * pipelines are built synchronously by an ordinary draw. compileAsync was used before, but three
 * caches a pipeline entry before createRenderPipelineAsync resolves, and the plume and beam share
 * materials with our own ship: our ship drew the unresolved entry ("setPipeline ... not of type
 * GPURenderPipeline", MEASURED intermittently on fresh guest pages). Costs one hitch at session start.
 */
const WARM_BEHIND_M = 200;
const _fwd = new THREE.Vector3();

/** Eases the local sim clock toward the host's samples (the host owns epoch and rate). */
function ClockFollower() {
  const store = useStore();
  useFrame((_, dt) => {
    if (hostClock.at < 0 || coopSnapshot().role === "solo") return;
    if (store.get(simRateAtom) !== hostClock.rate) store.set(simRateAtom, hostClock.rate);
    const est = hostClock.epochMs + hostClock.rate * Math.min(HOST_SILENCE_MS, performance.now() - hostClock.at);
    const local = store.get(simEpochMsAtom);
    const err = est - local;
    // Applied by the next sim-clock tick, never mid-frame (see simEpochNudge).
    simEpochNudge.ms = Math.abs(err) < 1 ? 0 : Math.abs(err) > CLOCK_SNAP_MS ? err : err * Math.min(1, dt * CLOCK_EASE_PER_S);
  });
  return null;
}

const CoopLayer = memo(function CoopLayer() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setActive(coopSnapshot().role !== "solo"), LIST_REFRESH_MS);
    return () => clearInterval(t);
  }, []);
  if (!active) return null;
  return (
    <>
      <ClockFollower />
      <Suspense fallback={null}><RemoteShips /></Suspense>
    </>
  );
});

/** The session's ship slots: pilots are assigned to slots, never mounted per pose. */
function RemoteShips() {
  const root = useRef<THREE.Group>(null);
  const store = useStore();
  const worldOrigin = useWorldOrigin();
  useEffect(() => worldAuthority.subscribe((e) => {
    if (e.type !== "ship.contact" && e.type !== "ship.destroyed") return;
    if (e.by === getLocalPlayerId() || !isFrameId(e.frameId)) return;
    if (e.type === "ship.destroyed" && e.cause !== "impact") return;
    const origin = frameOriginKm(e.frameId, _o);
    const wo = worldOrigin.worldOriginKm;
    const position: [number, number, number] = [
      (origin.x + e.positionKm[0] - wo.x) * 1000,
      (origin.y + e.positionKm[1] - wo.y) * 1000,
      (origin.z + e.positionKm[2] - wo.z) * 1000,
    ];
    // Skip distant sparks when the pilots are exploring different parts of the system.
    if (Math.hypot(...position) > 50_000) return;
    store.set(spawnVFXEventAtom, {
      type: "collision", position, shake: 0, silent: true,
      ...(e.type === "ship.contact"
        ? { radiusM: Math.min(40, 2 + e.dvMps * 0.3), impactDirection: e.direction, impactDvMps: e.dvMps }
        : { radiusM: 120 }),
    });
  }), [store, worldOrigin]);
  const slots = useMemo<(string | null)[]>(() => new Array(SLOTS).fill(null), []);
  const defs = useMemo(() => new Map<string, POIDef>(), []);
  const ready = useRef(false);
  /** 0 pending, 1 drawn this frame (restore next), 2 done. */
  const warm = useRef(0);
  const warmSaved = useRef<[THREE.Object3D, boolean, boolean][]>([]);
  // Priority 0, registered after the slots and their plumes: nothing re-hides the parts before the render.
  useFrame(({ camera }) => {
    const g = root.current;
    if (!g || warm.current === 2) return;
    if (warm.current === 1) {
      for (const [o, v, c] of warmSaved.current) {
        o.visible = v;
        o.frustumCulled = c;
      }
      warmSaved.current = [];
      g.position.set(0, 0, 0);
      warm.current = 2;
      ready.current = true;
      logCoop("ships warmed");
      return;
    }
    g.traverse((o) => {
      warmSaved.current.push([o, o.visible, o.frustumCulled]);
      o.visible = true;
      o.frustumCulled = false;
    });
    for (const b of slotBeams) {
      b.start.set(0, 0, 0);
      b.end.set(0, 0, 1);
      b.remote.on = true;
    }
    camera.getWorldDirection(_fwd);
    g.position.copy(camera.position).addScaledVector(_fwd, -WARM_BEHIND_M);
    warm.current = 1;
  });
  useEffect(() => {
    let markers = "";
    const t = setInterval(() => {
      const now = performance.now();
      const live = new Set<string>();
      remotePoses.forEach((b, id) => {
        const l = b[b.length - 1];
        if (l && now - l.at < REMOTE_STALE_MS && isFrameId(l.f)) live.add(id);
      });
      // Keep each pilot in its slot; free slots of pilots gone stale; seat newcomers.
      for (let i = 0; i < SLOTS; i++) if (slots[i] && !live.has(slots[i]!)) slots[i] = null;
      live.forEach((id) => {
        if (slots.includes(id)) return;
        const free = slots.indexOf(null);
        if (free >= 0) slots[free] = id;
      });
      // Seated pilots as POI markers. Names reach the mirror after admission and on renames.
      const seated = slots.filter((id): id is string => id !== null);
      const key = seated.map((id) => `${id}=${memberName(id)}`).join("|");
      if (key === markers) return;
      markers = key;
      for (const id of Array.from(defs.keys())) if (!seated.includes(id)) defs.delete(id);
      for (const id of seated) {
        const d = defs.get(id);
        if (d) {
          d.name = memberName(id);
          d.initial = d.name.trim().charAt(0).toUpperCase() || "?";
          continue;
        }
        const l = remotePoses.get(id)!.at(-1)!;
        const name = memberName(id);
        defs.set(id, {
          id: `pilot:${id}`, name, category: "pilot", targetable: false,
          tint: pilotTint(id, Object.keys(getActiveSave()?.data.world.members ?? {})), initial: name.trim().charAt(0).toUpperCase() || "?",
          positionKm: [l.p[0], l.p[1], l.p[2]], frameId: l.f as FrameId,
          // No objectRadiusKm: the label stays under the diamond like every POI (a hull radius pushed it onto our own ship up close).
          minDistanceKm: 0, maxDistanceKm: PILOT_MAX_KM,
        });
      }
      store.set(pilotPOIsAtom, seated.map((id) => defs.get(id)!));
    }, LIST_REFRESH_MS / 5);
    return () => {
      clearInterval(t);
      store.set(pilotPOIsAtom, []);
    };
  }, [slots, defs, store]);
  return (
    <group ref={root} name="remoteShips">
      {slots.map((_, i) => (
        <RemoteShip key={i} slot={i} slots={slots} defs={defs} ready={ready} />
      ))}
    </group>
  );
}

export default CoopLayer;
