// ---------------------------------------------------------------------------
// Comms system — priority queue + played-message persistence
// ---------------------------------------------------------------------------
import { atom } from "jotai";
import { savedAtom } from "@/store/savedAtom";
import { RETIRED_COMMS_IDS, type CommsMessage } from "@/data/commsMessages";
import type { HintDef } from "@/data/guidance";
import { benchModeAtom } from "@/store/dev";
import { addToastAtom, toastStackFullAtom, toastsAtom } from "@/store/toast";

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
export const resetCommsPlayedAtom = atom(null, (get, set): void => {
  set(playedMessageIdsAtom, []);
  set(commsQueueAtom, []);
  set(toastsAtom, get(toastsAtom).filter((t) => t.kind !== "tip"));
});

// ---------------------------------------------------------------------------
// Hints (M3.7): one-time `tip` items in the Notification Stack. Marked played when SHOWN (never
// repeat after a reload). An offer made while the stack is full is dropped; the trigger re-offers
// once there is room, only if its condition still holds (no stale hints).
// ---------------------------------------------------------------------------

/** The newest tip still on screen (harness, triggers). */
export const activeHintAtom = atom<HintDef | null>((get) => {
  const t = get(toastsAtom).find((x) => x.kind === "tip" && x.hintId);
  return t ? { id: t.hintId!, text: t.message } : null;
});

export const showHintAtom = atom(null, (get, set, hint: HintDef): void => {
  if (get(benchModeAtom) || get(toastStackFullAtom)) return;
  const played = get(playedMessageIdsAtom);
  if (played.includes(hint.id)) return;
  set(addToastAtom, { kind: "tip", message: hint.text, hintId: hint.id });
  set(playedMessageIdsAtom, [...played, hint.id]);
});

/** A shown tip whose condition stopped holding leaves the stack (no stale hints). */
export const retireHintAtom = atom(null, (get, set, hintId: string): void => {
  const list = get(toastsAtom);
  if (list.some((t) => t.hintId === hintId)) set(toastsAtom, list.filter((t) => t.hintId !== hintId));
});

/** Retire the shown tips; waiting triggers re-offer on the next render. */
export const nextHintAtom = atom(null, (get, set): void => {
  set(toastsAtom, get(toastsAtom).filter((t) => t.kind !== "tip"));
});
