"use client";

/**
 * In-Canvas co-op views: other pilots' ships at interpolated poses (visual only, no colliders)
 * and the host clock follower. Renders nothing while solo.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useStore } from "jotai";
import { ShipOne } from "@/components/models/ships/ShipOne";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { getActiveSave } from "@/save/activeSave";
import "./CoopPill.scss";
import { frameOriginKm, isFrameId } from "@/sim/frames";
import { simEpochMsAtom, simEpochNudge, simRateAtom } from "@/store/simTime";
import { REMOTE_STALE_MS, coopSnapshot, hostClock, logCoop, remotePoses, type PoseSample } from "@/net/coopState";
import { MAX_PLAYERS } from "@/sim/session/protocol";
import { getLocalPlayerShip } from "@/sim/entities";
import { compileLocalSubtree } from "@/components/space/SpaceRenderer";

const INTERP_DELAY_MS = 100;
const MAX_EXTRAPOLATE_MS = 250;
/** Clock error above this snaps; below it is eased out over a few seconds. */
const CLOCK_SNAP_MS = 5000;
const CLOCK_EASE_PER_S = 0.5;
const LIST_REFRESH_MS = 500;

const _o = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _ndc = new THREE.Vector3();

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

/** Test probe: per-frame rendered remote positions while `on` (scripts read and clear `rows`). */
export const remoteShipProbe = { on: false, rows: [] as number[][] };

function memberName(id: string): string {
  return getActiveSave()?.data.world.members[id]?.name ?? "Pilot";
}

/** One ship slot per possible remote pilot, mounted for the whole session (never per pose). */
const SLOTS = MAX_PLAYERS - 1;

/**
 * A remote pilot slot. Mounted once at session start and precompiled (compileLocalSubtree)
 * before it may draw: first sight used to build its pipelines mid-frame (a multi-second pose
 * stall on both pages) and could draw a pending pipeline. `slots[slot]` names the pilot.
 */
const RemoteShip = memo(function RemoteShip({ slot, slots, ready }: { slot: number; slots: (string | null)[]; ready: React.RefObject<boolean> }) {
  const ref = useRef<THREE.Group>(null!);
  const label = useRef<HTMLDivElement | null>(null);
  const worldOrigin = useWorldOrigin();
  const p = useRef(new THREE.Vector3());
  // Name marker: a DOM label projected each frame (readable at any distance, unlike the hull).
  useEffect(() => {
    const el = document.createElement("div");
    el.className = "coop-marker";
    el.style.display = "none";
    document.body.appendChild(el);
    label.current = el;
    return () => {
      el.remove();
      label.current = null;
    };
  }, []);
  useFrame(({ camera, size }) => {
    const g = ref.current;
    const id = slots[slot];
    const buf = id ? remotePoses.get(id) : undefined;
    const now = performance.now();
    const f = buf && buf.length > 0 && now - buf[buf.length - 1].at < REMOTE_STALE_MS ? samplePose(buf, now - INTERP_DELAY_MS, p.current, g.quaternion) : null;
    const live = f !== null && isFrameId(f);
    // The hull waits for its pipelines; the marker does not.
    const show = live && ready.current;
    if (show && !g.visible) logCoop(`ship ${slot} shown ${id}`);
    g.visible = show;
    const el = label.current;
    if (!live || !f || !id) {
      if (el) el.style.display = "none";
      return;
    }
    frameOriginKm(f, _o);
    const wo = worldOrigin.worldOriginKm;
    g.position.set((_o.x + p.current.x - wo.x) * 1000, (_o.y + p.current.y - wo.y) * 1000, (_o.z + p.current.z - wo.z) * 1000);
    if (remoteShipProbe.on && buf) {
      const l = buf[buf.length - 1];
      const s = getLocalPlayerShip();
      remoteShipProbe.rows.push([now, slot, g.position.x, g.position.y, g.position.z, p.current.x, p.current.y, p.current.z, buf.length, l.seq, now - l.at, l.p[0], l.p[1], l.p[2],
        wo.x, wo.y, wo.z, _o.x, _o.y, _o.z, s?.posKm.x ?? 0, s?.posKm.y ?? 0, s?.posKm.z ?? 0, s?.prevPosKm.x ?? 0, s?.prevPosKm.y ?? 0, s?.prevPosKm.z ?? 0, s ? s.velKmps.length() * 1000 : -1]);
    }
    if (!el) return;
    _ndc.copy(g.position).project(camera);
    const onScreen = _ndc.z < 1 && Math.abs(_ndc.x) < 1 && Math.abs(_ndc.y) < 1;
    el.style.display = onScreen ? "block" : "none";
    if (!onScreen) return;
    // Names of pilots admitted later reach the mirror after the marker exists.
    const name = memberName(id);
    if (el.textContent !== name) el.textContent = name;
    el.style.transform = `translate(${((_ndc.x + 1) / 2) * size.width}px, ${((1 - _ndc.y) / 2) * size.height}px)`;
  });
  return (
    <group ref={ref} name={`remoteShip:${slot}`} visible={false}>
      <ShipOne />
    </group>
  );
});

/**
 * Precompile the slots' pipelines (hidden again before any frame draws them). Resolves when
 * the hulls may draw; null when the renderer is not up (they then compile on first sight).
 */
function precompileSlots(g: THREE.Group): Promise<boolean> {
  const ships = g.children;
  const culled: [THREE.Object3D, boolean][] = [];
  // compileAsync skips invisible and (stale-frustum) culled objects; its synchronous part
  // reads them, so they are shown only for the duration of the call.
  ships.forEach((s) => (s.visible = true));
  g.traverse((o) => {
    culled.push([o, o.frustumCulled]);
    o.frustumCulled = false;
  });
  let p: Promise<void> | null = null;
  try {
    p = compileLocalSubtree(g);
  } finally {
    ships.forEach((s) => (s.visible = false));
    culled.forEach(([o, c]) => (o.frustumCulled = c));
  }
  return p ? p.then(() => true, () => false) : Promise.resolve(false);
}

/** Eases the local sim clock toward the host's samples (the host owns epoch and rate). */
function ClockFollower() {
  const store = useStore();
  useFrame((_, dt) => {
    if (hostClock.at < 0 || coopSnapshot().role === "solo") return;
    if (store.get(simRateAtom) !== hostClock.rate) store.set(simRateAtom, hostClock.rate);
    const est = hostClock.epochMs + hostClock.rate * (performance.now() - hostClock.at);
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
      <RemoteShips />
    </>
  );
});

/** The session's ship slots: pilots are assigned to slots, never mounted per pose. */
function RemoteShips() {
  const root = useRef<THREE.Group>(null);
  const slots = useMemo<(string | null)[]>(() => new Array(SLOTS).fill(null), []);
  const ready = useRef(false);
  useEffect(() => {
    if (!root.current) return;
    let cancelled = false;
    const t0 = performance.now();
    void precompileSlots(root.current).then((ok) => {
      if (cancelled) return;
      ready.current = true;
      logCoop(`ships ${ok ? "compiled" : "not precompiled"} ${Math.round(performance.now() - t0)} ms`);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const t = setInterval(() => {
      const now = performance.now();
      const live = new Set<string>();
      remotePoses.forEach((b, id) => {
        if (b.length > 0 && now - b[b.length - 1].at < REMOTE_STALE_MS) live.add(id);
      });
      // Keep each pilot in its slot; free slots of pilots gone stale; seat newcomers.
      for (let i = 0; i < SLOTS; i++) if (slots[i] && !live.has(slots[i]!)) slots[i] = null;
      live.forEach((id) => {
        if (slots.includes(id)) return;
        const free = slots.indexOf(null);
        if (free >= 0) slots[free] = id;
      });
    }, LIST_REFRESH_MS / 5);
    return () => clearInterval(t);
  }, [slots]);
  return (
    <group ref={root} name="remoteShips">
      {slots.map((_, i) => (
        <RemoteShip key={i} slot={i} slots={slots} ready={ready} />
      ))}
    </group>
  );
}

export default CoopLayer;
