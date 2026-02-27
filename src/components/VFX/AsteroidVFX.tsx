"use client";

import { memo, useCallback, useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useAtomValue, useSetAtom } from "jotai";
import { CameraShake } from "@react-three/drei";

import {
  vfxEventsAtom,
  removeVFXEventAtom,
  cameraShakeIntensityAtom,
  type AsteroidVFXEvent,
} from "@/store/vfx";

import DebrisEffect from "./DebrisEffect";
import FlashEffect from "./FlashEffect";
import LootPopup from "./LootPopup";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------
const MAX_CONCURRENT_EFFECTS = 12; // prevent frame drops from too many simultaneous explosions
const VFX_CLEANUP_TIMEOUT_S = 3; // auto-cleanup stale events

// Camera shake config
const SHAKE_DECAY_RATE = 2.0; // how fast shake fades per second (lower = longer shake)
const SHAKE_MAX_YAW = 0.12;
const SHAKE_MAX_PITCH = 0.12;
const SHAKE_MAX_ROLL = 0.06;
const SHAKE_FREQUENCY = 10;

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
  const lootDone = useRef(!event.loot); // already "done" if no loot

  const checkAllDone = useCallback(() => {
    if (debrisDone.current && flashDone.current && lootDone.current) {
      onComplete(event.id);
    }
  }, [event.id, onComplete]);

  return (
    <>
      <DebrisEffect
        position={event.position}
        radiusM={event.radiusM}
        type={event.type}
        impactDirection={event.impactDirection}
        onComplete={() => {
          debrisDone.current = true;
          checkAllDone();
        }}
      />
      <FlashEffect
        position={event.position}
        radiusM={event.radiusM}
        type={event.type}
        onComplete={() => {
          flashDone.current = true;
          checkAllDone();
        }}
      />
      {event.loot && (
        <LootPopup
          position={[
            event.position[0],
            event.position[1] + event.radiusM * 1.2 + 5,
            event.position[2],
          ]}
          icon={event.loot.icon}
          name={event.loot.name}
          amount={event.loot.amount}
          onComplete={() => {
            lootDone.current = true;
            checkAllDone();
          }}
        />
      )}
    </>
  );
});

// ---------------------------------------------------------------------------
// Main VFX manager (mounted in the local scene)
// ---------------------------------------------------------------------------
const AsteroidVFX = () => {
  const events = useAtomValue(vfxEventsAtom);
  const removeEvent = useSetAtom(removeVFXEventAtom);
  const shakeIntensity = useAtomValue(cameraShakeIntensityAtom);
  const setShakeIntensity = useSetAtom(cameraShakeIntensityAtom);
  const shakeRef = useRef(shakeIntensity);

  // Keep ref in sync
  useEffect(() => {
    shakeRef.current = shakeIntensity;
  }, [shakeIntensity]);

  // Decay camera shake over time
  useFrame((_, delta) => {
    if (shakeRef.current > 0) {
      const next = Math.max(0, shakeRef.current - SHAKE_DECAY_RATE * delta);
      shakeRef.current = next;
      setShakeIntensity(next);
    }
  });

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

  // CameraShake intensity factor — only active when > 0
  const shakeActive = shakeIntensity > 0.01;

  return (
    <>
      {activeEvents.map((event) => (
        <VFXEventRenderer
          key={event.id}
          event={event}
          onComplete={handleComplete}
        />
      ))}

      {shakeActive && (
        <CameraShake
          maxYaw={SHAKE_MAX_YAW * shakeIntensity}
          maxPitch={SHAKE_MAX_PITCH * shakeIntensity}
          maxRoll={SHAKE_MAX_ROLL * shakeIntensity}
          yawFrequency={SHAKE_FREQUENCY}
          pitchFrequency={SHAKE_FREQUENCY}
          rollFrequency={SHAKE_FREQUENCY * 0.7}
          intensity={shakeIntensity}
          decay
          decayRate={SHAKE_DECAY_RATE}
        />
      )}
    </>
  );
};

export default memo(AsteroidVFX);
