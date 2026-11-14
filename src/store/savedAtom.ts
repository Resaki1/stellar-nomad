/**
 * Gameplay atoms backed by the active save. Same setter contract as a primitive atom; writes
 * are mirrored into the save slice (marking it dirty). `hydrateSavedAtoms` runs once the world
 * is active and BEFORE any gameplay component mounts, so there is no hydration race.
 */
import { atom, type PrimitiveAtom, type SetStateAction, type WritableAtom, type createStore } from "jotai";
import {
  readPlayerSlice,
  readWorldSlice,
  registerCollector,
  samplePlayerSlice,
  writePlayerSlice,
  writeWorldSlice,
} from "@/save/activeSave";
import type { PlayerState, WorldState } from "@/save/types";

type Store = ReturnType<typeof createStore>;
export type SavedAtom<T> = WritableAtom<T, [SetStateAction<T>], void>;

interface Entry {
  base: PrimitiveAtom<unknown>;
  read: () => unknown;
  fallback: unknown;
  /** Set for sampled atoms: copied into the save at flush time instead of on every write. */
  sample?: (v: unknown) => void;
}

// Keyed so an HMR re-evaluation replaces its entry instead of piling up stale ones.
const registry = new Map<string, Entry>();

function make<T>(
  id: string,
  read: () => T | undefined,
  write: ((v: T) => void) | null,
  defaultValue: T,
  sample?: (v: T) => void,
): SavedAtom<T> {
  // A module re-evaluated after boot (HMR) starts from the save, not the default.
  const base = atom<T>(read() ?? defaultValue);
  const a = atom(
    (get) => get(base),
    (get, set, update: SetStateAction<T>) => {
      const next = typeof update === "function" ? (update as (prev: T) => T)(get(base)) : update;
      set(base, next);
      write?.(next);
    },
  );
  registry.set(id, { base: base as PrimitiveAtom<unknown>, read, fallback: defaultValue, sample: sample as Entry["sample"] });
  return a;
}

/** `sampled`: for values written every frame (hull regen); avoids dirtying the save per write. */
export function savedAtom<K extends keyof PlayerState>(
  scope: "player",
  key: K,
  defaultValue: PlayerState[K],
  opts?: { sampled: boolean },
): SavedAtom<PlayerState[K]>;
export function savedAtom<K extends keyof WorldState>(
  scope: "world",
  key: K,
  defaultValue: WorldState[K],
): SavedAtom<WorldState[K]>;
export function savedAtom(
  scope: "player" | "world",
  key: keyof PlayerState | keyof WorldState,
  defaultValue: unknown,
  opts?: { sampled: boolean },
): SavedAtom<unknown> {
  if (scope === "player") {
    const k = key as keyof PlayerState;
    const put = (v: unknown) => writePlayerSlice(k, v as PlayerState[typeof k]);
    const sample = (v: unknown) => samplePlayerSlice(k, v as PlayerState[typeof k]);
    return opts?.sampled
      ? make(`player:${k}`, () => readPlayerSlice(k), null, defaultValue, sample)
      : make(`player:${k}`, () => readPlayerSlice(k), put, defaultValue);
  }
  const k = key as keyof WorldState;
  return make(`world:${k}`, () => readWorldSlice(k), (v) => writeWorldSlice(k, v as WorldState[typeof k]), defaultValue);
}

/** Set every registered saved atom from the active save (defaults for missing slices). */
let unregisterSampler: (() => void) | null = null;

export function hydrateSavedAtoms(store: Store): void {
  registry.forEach((e) => store.set(e.base, e.read() ?? e.fallback));
  unregisterSampler?.();
  unregisterSampler = registerCollector(() => registry.forEach((e) => e.sample?.(store.get(e.base))));
}
