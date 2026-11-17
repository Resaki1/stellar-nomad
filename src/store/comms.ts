// ---------------------------------------------------------------------------
// Comms system — priority queue + played-message persistence
// ---------------------------------------------------------------------------
import { atom } from "jotai";
import { savedAtom } from "@/store/savedAtom";
import { RETIRED_COMMS_IDS, type CommsMessage } from "@/data/commsMessages";
import type { HintDef } from "@/data/guidance";
import { benchModeAtom } from "@/store/dev";

// ---------------------------------------------------------------------------
// Persistent registry of message IDs that have already been shown.
// Survives page reloads so the player never sees the same message twice.
// ---------------------------------------------------------------------------

export const playedMessageIdsAtom = savedAtom("player", "commsPlayed", []);

// ---------------------------------------------------------------------------
// Live queue — ordered by priority (highest first), then insertion order.
// Only the first entry is the "active" message shown on screen.
// ---------------------------------------------------------------------------

export const commsQueueAtom = atom<CommsMessage[]>([]);

/** The message currently displayed in the overlay (head of the queue). */
export const activeCommsMessageAtom = atom<CommsMessage | null>((get) => {
  const queue = get(commsQueueAtom);
  return queue.length > 0 ? queue[0] : null;
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Message IDs currently waiting out their delaySec before entering the queue. */
const pendingDelayedIds = new Set<string>();

/**
 * Internal: insert a message into the priority queue immediately.
 * Skips if already played or already queued.
 */
const insertIntoQueueAtom = atom(
  null,
  (get, set, message: CommsMessage): void => {
    // Benchmark mode: never surface a message. Guarding here rather than in
    // enqueueCommsAtom also catches messages whose `delaySec` timer was armed
    // before the benchmark started and would otherwise land mid-measurement.
    if (get(benchModeAtom)) return;

    if (get(playedMessageIdsAtom).includes(message.messageId)) return;

    const queue = get(commsQueueAtom);
    if (queue.some((m) => m.messageId === message.messageId)) return;

    // Find insertion index: after all messages with priority >= this one
    let idx = 0;
    while (idx < queue.length && queue[idx].priority >= message.priority) {
      idx++;
    }

    const next = [...queue];
    next.splice(idx, 0, message);
    set(commsQueueAtom, next);
  },
);

/**
 * Enqueue a message. Skips if the messageId is already in the played registry,
 * already in the queue, or already waiting out a delay.
 *
 * If the message defines `delaySec`, the actual queue insertion is deferred by
 * that many seconds after the trigger fires.
 */
export const enqueueCommsAtom = atom(
  null,
  (get, set, message: CommsMessage): void => {
    if (RETIRED_COMMS_IDS.has(message.messageId)) return;
    if (get(playedMessageIdsAtom).includes(message.messageId)) return;

    const queue = get(commsQueueAtom);
    if (queue.some((m) => m.messageId === message.messageId)) return;
    if (pendingDelayedIds.has(message.messageId)) return;

    if (message.delaySec != null && message.delaySec > 0) {
      pendingDelayedIds.add(message.messageId);
      setTimeout(() => {
        pendingDelayedIds.delete(message.messageId);
        set(insertIntoQueueAtom, message);
      }, message.delaySec * 1000);
      return;
    }

    set(insertIntoQueueAtom, message);
  },
);

/**
 * Dismiss the currently active message: mark it as played (persisted) and
 * remove it from the queue so the next message becomes active.
 */
export const dismissCommsAtom = atom(null, (get, set): void => {
  const queue = get(commsQueueAtom);
  if (queue.length === 0) return;

  const dismissed = queue[0];

  const played = get(playedMessageIdsAtom);
  if (!played.includes(dismissed.messageId)) {
    set(playedMessageIdsAtom, [...played, dismissed.messageId]);
  }

  // Remove from queue
  set(commsQueueAtom, queue.slice(1));
});

/**
 * Reset the played registry (useful for "new game" or debug).
 */
export const resetCommsPlayedAtom = atom(null, (_get, set): void => {
  set(playedMessageIdsAtom, []);
  set(commsQueueAtom, []);
  set(activeHintAtom, null);
});

// ---------------------------------------------------------------------------
// Hints (M3.7): one-time, non-blocking lines. Marked played when SHOWN (never repeat after a
// reload). No queue: an offer made while another hint shows is dropped, and the trigger
// re-offers once the slot is free only if its condition still holds (no stale hints).
// ---------------------------------------------------------------------------

export const HINT_SHOW_MS = 9000;
export const activeHintAtom = atom<HintDef | null>(null);

export const showHintAtom = atom(null, (get, set, hint: HintDef): void => {
  if (get(benchModeAtom) || get(activeHintAtom)) return;
  const played = get(playedMessageIdsAtom);
  if (played.includes(hint.id)) return;
  set(activeHintAtom, hint);
  set(playedMessageIdsAtom, [...played, hint.id]);
});

/** Retire the shown hint; waiting triggers re-offer on the next render. */
export const nextHintAtom = atom(null, (_get, set): void => {
  set(activeHintAtom, null);
});
