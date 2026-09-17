// ---------------------------------------------------------------------------
// Toast / notification system for in-game events
// ---------------------------------------------------------------------------
import { atom } from "jotai";

/**
 * Severity, used to pick a sound and (later) a visual treatment.
 *
 * 🔑 ADDED FOR AUDIO (docs/AUDIO_PLAN.md T13). `addToastAtom` is shared by call
 * sites spanning very different tones — research complete (celebratory),
 * "Cannot start research" (error), "TRANSIT DISENGAGED" (alert), "No heat to
 * reduce" (minor rejection). Without this field a single audio watcher would
 * have to guess the tone by pattern-matching the message TEXT, which breaks the
 * moment anyone rewords a string.
 *
 * Optional, so every existing call site keeps working and defaults to `info`.
 */
export type ToastKind = "info" | "success" | "warn";

export type Toast = {
  id: number;
  message: string;
  /** Optional secondary line */
  detail?: string;
  /** Duration in ms before auto-dismiss (default 4000) */
  durationMs?: number;
  /** Defaults to "info" when omitted. */
  kind?: ToastKind;
  createdAt: number;
};

let _nextToastId = 1;

export const toastsAtom = atom<Toast[]>([]);

export const addToastAtom = atom(
  null,
  (get, set, toast: Omit<Toast, "id" | "createdAt">): void => {
    const id = _nextToastId++;
    const full: Toast = { ...toast, id, createdAt: Date.now() };
    set(toastsAtom, (prev) => [...prev, full]);

    // Auto-remove after duration
    const dur = toast.durationMs ?? 4000;
    setTimeout(() => {
      set(toastsAtom, (prev) => prev.filter((t) => t.id !== id));
    }, dur);
  },
);

export const dismissToastAtom = atom(
  null,
  (get, set, toastId: number): void => {
    set(toastsAtom, (prev) => prev.filter((t) => t.id !== toastId));
  },
);
