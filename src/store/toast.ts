// ---------------------------------------------------------------------------
// Notification Stack (playtest-1 §2.3): everything that HAPPENED (gains, unlocks, crafts,
// refusals, tips) goes to one column. One lifetime table, max 4 visible, merging by title.
// ---------------------------------------------------------------------------
import { atom } from "jotai";

/**
 * Severity picks the sound and the left rule (docs/AUDIO_PLAN.md T13: the audio watcher reads
 * `kind`, never the text). `tip` = a one-time hint (lightbulb, silent).
 */
export type ToastKind = "info" | "success" | "warn" | "tip";

/** One icon + number in an item's value row (`+38 [Si]`, `[fuel] 200 kg`). */
export type ToastValue = { id: string; amount?: number; unit?: string };

export type Toast = {
  id: number;
  /** Title, at most 4 words (hints: at most 10, `{action}` tokens render as key chips). */
  message: string;
  /** Optional short second line (a reason, a name). */
  detail?: string;
  /** Optional icon row; merged items sum amounts by id. */
  values?: ToastValue[];
  /** Defaults to "info" when omitted. */
  kind?: ToastKind;
  /** Suppress when a dedicated gameplay cue plays; reject for denied actions. */
  audio?: "silent" | "reject";
  /** Hint id for `tip` items (the played registry and the harness read it). */
  hintId?: string;
  createdAt: number;
};

/** One table, no per-call durations (R4 of the spec: the same thing always lasts the same time). */
export const TOAST_LIFE_MS: Record<ToastKind, number> = { info: 4000, success: 6000, warn: 6000, tip: 8000 };
export const TOAST_MAX = 4;
/** A second item with the same title within this window merges into the first. */
const MERGE_MS = 1500;

let _nextToastId = 1;

/** Newest first. */
export const toastsAtom = atom<Toast[]>([]);
/** Item ids under the pointer: their lifetime is paused. */
export const hoveredToastAtom = atom<number | null>(null);

function mergeValues(a: ToastValue[] | undefined, b: ToastValue[] | undefined): ToastValue[] | undefined {
  if (!b?.length) return a;
  const out = a ? a.map((v) => ({ ...v })) : [];
  for (const v of b) {
    const hit = out.find((x) => x.id === v.id && x.unit === v.unit);
    if (hit && hit.amount !== undefined && v.amount !== undefined) hit.amount += v.amount;
    else if (!hit) out.push({ ...v });
  }
  return out;
}

export const addToastAtom = atom(null, (get, set, toast: Omit<Toast, "id" | "createdAt">): void => {
  const now = Date.now();
  const prev = get(toastsAtom);
  const same = prev.find((t) => t.message === toast.message && t.kind === toast.kind && t.detail === toast.detail && now - t.createdAt < MERGE_MS);
  if (same && toast.kind !== "tip") {
    set(toastsAtom, [{ ...same, values: mergeValues(same.values, toast.values), createdAt: now }, ...prev.filter((t) => t !== same)]);
    return;
  }
  // The 5th is dropped at once (never queued off-screen).
  set(toastsAtom, [{ ...toast, id: _nextToastId++, createdAt: now }, ...prev].slice(0, TOAST_MAX));
});

export const dismissToastAtom = atom(null, (get, set, toastId: number): void => {
  set(toastsAtom, get(toastsAtom).filter((t) => t.id !== toastId));
});

/** Hover ended: the item gets a fresh lifetime instead of vanishing at once. */
export const touchToastAtom = atom(null, (get, set, toastId: number): void => {
  set(toastsAtom, get(toastsAtom).map((t) => (t.id === toastId ? { ...t, createdAt: Date.now() } : t)));
});

/** Drop expired items (the stack polls this; a hovered item waits). */
export const pruneToastsAtom = atom(null, (get, set): void => {
  const now = Date.now();
  const hovered = get(hoveredToastAtom);
  const prev = get(toastsAtom);
  const next = prev.filter((t) => t.id === hovered || now - t.createdAt < TOAST_LIFE_MS[t.kind ?? "info"]);
  if (next.length !== prev.length) set(toastsAtom, next);
});

/** Hints wait (their trigger re-offers them) while the stack is full; they never displace a gain. */
export const toastStackFullAtom = atom((get) => get(toastsAtom).length >= TOAST_MAX);
