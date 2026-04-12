"use client";

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useAtomValue, useSetAtom } from "jotai";
import { enqueueCommsAtom } from "@/store/comms";
import { COMMS_MESSAGES, type CommsMessage } from "@/data/commsMessages";

// =========================================================================
// 1. ACTION TRIGGER — fire a message in response to a game event
// =========================================================================

/**
 * Hook that returns a stable callback to enqueue a message by ID.
 * Usage:
 *   const triggerComms = useCommsTrigger();
 *   triggerComms("mining_001");
 */
export function useCommsTrigger() {
  const enqueue = useSetAtom(enqueueCommsAtom);

  // Stable ref so callers don't need the atom in their dep arrays
  const enqueueRef = useRef(enqueue);
  enqueueRef.current = enqueue;

  return (messageId: string) => {
    const msg = COMMS_MESSAGES[messageId];
    if (msg) enqueueRef.current(msg);
  };
}

// =========================================================================
// 2. SPATIAL TRIGGER — R3F component that fires when the player enters a
//    sphere at a given world position (in km, matching worldOriginKm coords)
// =========================================================================

/**
 * Props for the spatial comms trigger.
 * Position and radius are in **kilometres** (world-origin space).
 */
type SpatialCommsTriggerProps = {
  messageId: string;
  /** Centre of the trigger volume in km [x, y, z]. */
  positionKm: [number, number, number];
  /** Trigger radius in km. */
  radiusKm: number;
  /** If provided, used instead of looking up COMMS_MESSAGES. */
  message?: CommsMessage;
};

/**
 * Invisible R3F node. Each frame it checks whether the camera (ship) is
 * within `radiusKm` of `positionKm`. Fires once — the played-registry in
 * the store prevents repeats.
 *
 * Must be a child of the R3F Canvas (needs useFrame).
 */
export function SpatialCommsTrigger({
  messageId,
  positionKm,
  radiusKm,
  message,
}: SpatialCommsTriggerProps) {
  const enqueue = useSetAtom(enqueueCommsAtom);
  const firedRef = useRef(false);

  useFrame(({ camera }) => {
    if (firedRef.current) return;

    // camera.position is in render-local metres; convert to km
    const camKm = camera.position.clone().multiplyScalar(0.001);
    const dx = camKm.x - positionKm[0];
    const dy = camKm.y - positionKm[1];
    const dz = camKm.z - positionKm[2];
    const distSq = dx * dx + dy * dy + dz * dz;

    if (distSq <= radiusKm * radiusKm) {
      firedRef.current = true;
      const msg = message ?? COMMS_MESSAGES[messageId];
      if (msg) enqueue(msg);
    }
  });

  return null;
}

// =========================================================================
// 3. STAT TRIGGER — watches a Jotai atom and fires when a condition is met
// =========================================================================

type CommsStatWatcherProps<T> = {
  messageId: string;
  /** The current value to watch (read via useAtomValue in the parent). */
  value: T;
  /** Predicate — when this returns true, the message fires (once). */
  condition: (value: T) => boolean;
  /** If provided, used instead of looking up COMMS_MESSAGES. */
  message?: CommsMessage;
};

/**
 * Pure-React component (no R3F dependency). Watches `value` and enqueues a
 * comms message the first time `condition(value)` returns true.
 *
 * Example:
 *   const health = useAtomValue(shipHealthAtom);
 *   <CommsStatWatcher
 *     messageId="low_health_001"
 *     value={health}
 *     condition={(h) => h < 20}
 *   />
 */
export function CommsStatWatcher<T>({
  messageId,
  value,
  condition,
  message,
}: CommsStatWatcherProps<T>) {
  const enqueue = useSetAtom(enqueueCommsAtom);
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    if (condition(value)) {
      firedRef.current = true;
      const msg = message ?? COMMS_MESSAGES[messageId];
      if (msg) enqueue(msg);
    }
  }, [value, condition, messageId, message, enqueue]);

  return null;
}
