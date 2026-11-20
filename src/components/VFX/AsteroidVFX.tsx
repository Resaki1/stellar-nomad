"use client";

import { memo, useCallback, useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useFrame } from "@react-three/fiber";
import { Group } from "three";
import { frameOriginKm } from "@/sim/frames";
import { useWorldOrigin } from "@/sim/worldOrigin";

import {
  vfxEventsAtom,
  removeVFXEventAtom,
  type AsteroidVFXEvent,
} from "@/store/vfx";

import DebrisEffect from "./DebrisEffect";
import FlashEffect from "./FlashEffect";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------
const MAX_CONCURRENT_EFFECTS = 12; // prevent frame drops from too many simultaneous explosions
const VFX_CLEANUP_TIMEOUT_S = 3; // auto-cleanup stale events
const ORIGIN: [number, number, number] = [0, 0, 0];

// ---------------------------------------------------------------------------
// Single-event renderer
// ---------------------------------------------------------------------------
const VFXEventRenderer = memo(function VFXEventRenderer({
  event,
  onComplete,
}: {
  event: AsteroidVFXEvent;
  onComplete: (id: number) => void;
}) {
  const debrisDone = useRef(false);
  const flashDone = useRef(false);
  const group = useRef<Group>(null!);
  const worldOrigin = useWorldOrigin();
  useFrame(() => {
    const anchor = event.debrisAt;
    if (!anchor || !group.current) return;
    const p = frameOriginKm(anchor.frameId, group.current.position);
    const rel = anchor.positionKm;
    p.sub(worldOrigin.worldOriginKm);
    p.set((p.x + rel[0]) * 1000, (p.y + rel[1]) * 1000, (p.z + rel[2]) * 1000);
  }, -0.25);

  const checkAllDone = useCallback(() => {
    if (debrisDone.current && flashDone.current) {
      onComplete(event.id);
    }
  }, [event.id, onComplete]);

  return (
    <group ref={group} position={event.debrisAt ? event.position : ORIGIN}>
      <DebrisEffect
        position={event.debrisAt ? ORIGIN : event.position}
        dynamicAnchor={event.debrisAt}
        radiusM={event.radiusM}
        type={event.type}
        impactDirection={event.impactDirection}
        onComplete={() => {
          debrisDone.current = true;
          checkAllDone();
        }}
      />
      <FlashEffect
        position={event.debrisAt ? ORIGIN : event.position}
        radiusM={event.radiusM}
        type={event.type}
        onComplete={() => {
          flashDone.current = true;
          checkAllDone();
        }}
      />
    </group>
  );
});

// ---------------------------------------------------------------------------
// Main VFX manager (mounted in the local scene)
// ---------------------------------------------------------------------------
const AsteroidVFX = () => {
  const events = useAtomValue(vfxEventsAtom);
  const removeEvent = useSetAtom(removeVFXEventAtom);

  // Auto-cleanup very old events (safety net)
  useEffect(() => {
    if (events.length === 0) return;

    const now = performance.now();
    const stale = events.filter(
      (e) => now - e.createdAt > VFX_CLEANUP_TIMEOUT_S * 1000
    );
    for (const e of stale) {
      removeEvent(e.id);
    }
  }, [events, removeEvent]);

  const handleComplete = useCallback(
    (id: number) => {
      removeEvent(id);
    },
    [removeEvent]
  );

  // Limit concurrent effects
  const activeEvents = events.slice(0, MAX_CONCURRENT_EFFECTS);

  return (
    <>
      {activeEvents.map((event) => (
        <VFXEventRenderer
          key={event.id}
          event={event}
          onComplete={handleComplete}
        />
      ))}
    </>
  );
};

export default memo(AsteroidVFX);
