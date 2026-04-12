// ---------------------------------------------------------------------------
// Comms system — priority queue + played-message persistence
// ---------------------------------------------------------------------------
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { CommsMessage } from "@/data/commsMessages";

// ---------------------------------------------------------------------------
// Persistent registry of message IDs that have already been shown.
// Survives page reloads so the player never sees the same message twice.
// ---------------------------------------------------------------------------

export const playedMessageIdsAtom = atomWithStorage<string[]>(
  "comms-played-v1",
  [],
);

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

/**
 * Enqueue a message. Skips if the messageId is already in the played registry
 * or already in the queue. Inserts sorted by descending priority (stable for
 * equal priorities — new messages go after existing ones with the same level).
 */
export const enqueueCommsAtom = atom(
  null,
  (get, set, message: CommsMessage): void => {
    const played = get(playedMessageIdsAtom);
    if (played.includes(message.messageId)) return;

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
 * Dismiss the currently active message: mark it as played (persisted) and
 * remove it from the queue so the next message becomes active.
 */
export const dismissCommsAtom = atom(null, (get, set): void => {
  const queue = get(commsQueueAtom);
  if (queue.length === 0) return;

  const dismissed = queue[0];

  // Persist as played
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
});
