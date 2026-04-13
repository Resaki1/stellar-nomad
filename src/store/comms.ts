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

const PLAYED_STORAGE_KEY = "comms-played-v1";

export const playedMessageIdsAtom = atomWithStorage<string[]>(
  PLAYED_STORAGE_KEY,
  [],
);

/**
 * Read played IDs directly from localStorage. This avoids the race where
 * atomWithStorage hasn't hydrated yet (returns default []) but localStorage
 * already has the persisted list.
 */
function readPlayedIdsFromStorage(): string[] {
  try {
    const raw = localStorage.getItem(PLAYED_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch { /* ignore */ }
  return [];
}

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
    const played = get(playedMessageIdsAtom);
    const stored = readPlayedIdsFromStorage();
    if (played.includes(message.messageId) || stored.includes(message.messageId)) return;

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
    // Check both the atom (may not be hydrated yet) and localStorage directly
    const played = get(playedMessageIdsAtom);
    const stored = readPlayedIdsFromStorage();
    if (played.includes(message.messageId) || stored.includes(message.messageId)) return;

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

  // Merge atom + localStorage to avoid overwriting during hydration race
  const fromAtom = get(playedMessageIdsAtom);
  const fromStorage = readPlayedIdsFromStorage();
  const merged = Array.from(new Set([...fromAtom, ...fromStorage]));

  if (!merged.includes(dismissed.messageId)) {
    merged.push(dismissed.messageId);
  }
  set(playedMessageIdsAtom, merged);

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
