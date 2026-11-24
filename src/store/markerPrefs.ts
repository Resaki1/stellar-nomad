/**
 * Player control over navigation markers (docs/MARKER_SYSTEM_PLAN.md §2.5).
 *
 * Display preferences are device prefs (they follow the player into every world). Tracked
 * markers name world objects, so they live in the player's save (`trackedMarkers`).
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { MarkerGroup } from "@/data/markerCategories";
import { savedAtom } from "@/store/savedAtom";

/** full: every allowed marker; essential: destination, tracked, crew, pings; off: the destination only. */
export type MarkerDensity = "full" | "essential" | "off";
export const MARKER_DENSITIES: readonly MarkerDensity[] = ["full", "essential", "off"];

export interface MarkerPrefs {
  density: MarkerDensity;
  /** Hidden filter groups (absent = shown). */
  hidden: MarkerGroup[];
  /** Planet/moon/field names without aiming at them. */
  celestialLabels: boolean;
  /** Glyph and label size multiplier. */
  scale: number;
}

export const DEFAULT_MARKER_PREFS: MarkerPrefs = { density: "full", hidden: [], celestialLabels: false, scale: 1 };

const rawMarkerPrefsAtom = atomWithStorage<Partial<MarkerPrefs>>("markerPrefs", DEFAULT_MARKER_PREFS, undefined, { getOnInit: true });
/** atomWithStorage replaces rather than merges: a stored blob from before a field existed lacks it. */
export const markerPrefsAtom = atom(
  (get): MarkerPrefs => ({ ...DEFAULT_MARKER_PREFS, ...get(rawMarkerPrefsAtom) }),
  (_get, set, next: MarkerPrefs) => set(rawMarkerPrefsAtom, next),
);

/** Held reveal key: every allowed marker with its name, and every edge arrow. */
export const markerRevealAtom = atom(false);

export const MAX_TRACKED_MARKERS = 8;
export const trackedMarkersAtom = savedAtom("player", "trackedMarkers", []);

/** Track or untrack a marker; the oldest drops out beyond the cap. Returns the new state. */
export const toggleTrackedMarkerAtom = atom(null, (get, set, id: string): boolean => {
  const ids = get(trackedMarkersAtom);
  if (ids.includes(id)) {
    set(trackedMarkersAtom, ids.filter((x) => x !== id));
    return false;
  }
  set(trackedMarkersAtom, [...ids, id].slice(-MAX_TRACKED_MARKERS));
  return true;
});
