/**
 * Marker categories (docs/MARKER_SYSTEM_PLAN.md §2.1–2.2): shape says WHAT a marker is,
 * colour says WHOSE it is. One table; producers only name a category.
 */

export type MarkerCategory =
  | "body" | "star" | "field" | "depot" | "point" | "drone" | "wreck" | "site" | "source" | "pilot" | "ping" | "waypoint";

/** Settings → Markers filter groups. */
export type MarkerGroup = "celestial" | "stars" | "structures" | "drones" | "wrecks" | "signals" | "crew" | "pings";

/**
 * `local`: shown in the ship's own body frame or within LOCAL_MARKER_RANGE_KM (a Mercury depot
 * never shows near Neptune); `system`: anywhere its own range allows.
 */
export type MarkerScope = "local" | "system";

export interface MarkerCategoryDef {
  /** Lower draws first, keeps its label, and wins a cluster. */
  priority: number;
  group: MarkerGroup | null;
  /** Name shown without focus. */
  alwaysLabel: boolean;
  /**
   * Off-screen edge arrow without being tracked or the destination. Bodies, fields and signals
   * have one: progression keeps them few, and arrows sharing a spot merge into "+N".
   */
  edge: boolean;
  scope: MarkerScope;
  /** Shown in the "essential" density. */
  essential: boolean;
}

export const MARKER_CATEGORIES: Readonly<Record<MarkerCategory, MarkerCategoryDef>> = {
  waypoint: { priority: 1, group: null, alwaysLabel: true, edge: true, scope: "system", essential: true },
  ping: { priority: 2, group: "pings", alwaysLabel: true, edge: true, scope: "system", essential: true },
  pilot: { priority: 3, group: "crew", alwaysLabel: true, edge: true, scope: "system", essential: true },
  drone: { priority: 4, group: "drones", alwaysLabel: true, edge: true, scope: "system", essential: true },
  depot: { priority: 5, group: "structures", alwaysLabel: true, edge: false, scope: "local", essential: false },
  point: { priority: 5, group: "structures", alwaysLabel: false, edge: false, scope: "local", essential: false },
  site: { priority: 6, group: "signals", alwaysLabel: false, edge: true, scope: "local", essential: false },
  wreck: { priority: 6, group: "wrecks", alwaysLabel: false, edge: false, scope: "local", essential: false },
  source: { priority: 7, group: "signals", alwaysLabel: false, edge: false, scope: "local", essential: false },
  body: { priority: 8, group: "celestial", alwaysLabel: false, edge: true, scope: "system", essential: false },
  field: { priority: 9, group: "celestial", alwaysLabel: false, edge: true, scope: "system", essential: false },
  star: { priority: 10, group: "stars", alwaysLabel: false, edge: false, scope: "system", essential: false },
};

export const MARKER_GROUPS: readonly { id: MarkerGroup; label: string }[] = [
  { id: "celestial", label: "Planets, moons & fields" },
  { id: "stars", label: "Stars" },
  { id: "structures", label: "Depots & replication points" },
  { id: "drones", label: "Tracked drones" },
  { id: "wrecks", label: "Wrecks" },
  { id: "signals", label: "Signals & bookmarked rocks" },
  { id: "crew", label: "Crew" },
  { id: "pings", label: "Pings" },
];

/** Local markers show inside the ship's body frame or within this range (Earth–Moon is ~384,000 km). */
export const LOCAL_MARKER_RANGE_KM = 100_000;

/**
 * Pilot tints: Okabe–Ito colour-blind-safe hues, minus yellow (the destination's gold).
 * Assigned by join order in the shared `world.members`, so every peer agrees.
 */
export const PILOT_TINTS = ["#56B4E9", "#E69F00", "#009E73", "#CC79A7", "#D55E00"] as const;

export function pilotTint(playerId: string, memberIds: readonly string[]): string {
  let i = memberIds.indexOf(playerId);
  if (i < 0) {
    i = 0;
    for (let k = 0; k < playerId.length; k++) i = (i * 31 + playerId.charCodeAt(k)) >>> 0;
  }
  return PILOT_TINTS[i % PILOT_TINTS.length];
}
