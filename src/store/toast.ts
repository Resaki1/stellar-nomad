// ---------------------------------------------------------------------------
// Toast / notification system for in-game events
// ---------------------------------------------------------------------------
import { atom } from "jotai";

export type Toast = {
  id: number;
  message: string;
  /** Optional secondary line */
  detail?: string;
  /** Duration in ms before auto-dismiss (default 4000) */
  durationMs?: number;
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
