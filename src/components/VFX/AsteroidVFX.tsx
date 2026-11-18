"use client";

import { memo, useCallback, useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";

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

  const checkAllDone = useCallback(() => {
    if (debrisDone.current && flashDone.current) {
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
    </>
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
