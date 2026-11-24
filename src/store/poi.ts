/**
 * POI (Point of Interest) system — data types and shared mutable buffer.
 *
 * The POIProjector (R3F component) writes projected screen positions each frame.
 * The POIMarkers (HUD component) reads them via rAF for smooth updates.
 */

import type { MarkerCategory } from "@/data/markerCategories";
import type { FrameId } from "@/sim/frames";
import type { TransitFieldArrival } from "@/sim/ship/transitDrive";
import { atom } from "jotai";

/** Placed structures use the same aim hold for interaction and navigation. */
export const STRUCTURE_FOCUS_TIME_S = 1;

export function isStructurePoi(id: string): boolean {
  return id.startsWith("depot:") || id.startsWith("point:");
}

export type POIDef = {
  id: string;
  /** Shape, priority, filter group and scope come from `MARKER_CATEGORIES`. */
  category: MarkerCategory;
  name: string;
  /** System-frame km, or relative to `frameId` when set. A LIVE array for bodies/fields. */
  positionKm: [number, number, number];
  frameId?: FrameId;
  /** Hide marker when closer than this (km). */
  minDistanceKm: number;
  /** Hide marker when farther than this (km). */
  maxDistanceKm: number;
  /** Stand-off distance (km) for autopilot arrival. For celestial bodies this
   *  is their radius + padding so the ship arrives above the surface rather
   *  than at the center. Defaults to 0 (arrive at the exact position). */
  arrivalOffsetKm?: number;
  /** A body's anchored field: a trip from afar ends there (see `bodyTransitTarget`). */
  field?: TransitFieldArrival;
  /** Drawn object's radius (km): the marker label sits below its on-screen disc, not on its glow. */
  objectRadiusKm?: number;
  /** Owner colour (pilot slot tint) for pilots and pings. */
  tint?: string;
  /** One-letter owner tag drawn inside the glyph (pilots, pings). */
  initial?: string;
  /** Your active replication point (a state, never a suffix on the name). */
  active?: boolean;
  /** A direction, not a place: no distance shown (a ping into empty space). */
  bearing?: boolean;
  /** False: gaze never makes it a transit destination. */
  targetable?: boolean;
  /** Bodies: the marker yields once the disc's on-screen radius passes this fraction of the viewport height. */
  hideAboveScreenFrac?: number;
};

export type ProjectedPOI = {
  id: string;
  name: string;
  /** True if the POI is within the camera frustum. */
  inView: boolean;
  /** Screen X (0–1 normalized). Only valid when inView. */
  sx: number;
  /** Screen Y (0–1 normalized). Only valid when inView. */
  sy: number;
  /** Distance from the ship in km. */
  distanceKm: number;
  /** Direction angle (radians) for the edge arrow when off-screen. */
  edgeAngle: number;
  /** True when the POI is near the screen center (crosshair). */
  focused: boolean;
  /** On-screen radius of the drawn object as a fraction of viewport height (0 when none). */
  objectRadiusFrac: number;
  category: MarkerCategory;
  tint: string | null;
  initial: string | null;
  active: boolean;
  bearing: boolean;
  /** Tracked by this pilot (edge arrow, any range). */
  tracked: boolean;
  /** Behind a celestial body (drawn dimmed, no label). */
  occluded: boolean;
  /** Show the name without focus (category rule, density, or the reveal key). */
  labelled: boolean;
  /** Draw an edge arrow while off screen. */
  edge: boolean;
  /** Your structures in this body's frame, hidden here by their local scope. */
  badge: number;
};

/**
 * Other pilots in a co-op session (CoopLayer). Each def's `positionKm` / `frameId` are LIVE:
 * rewritten every frame from the interpolated pose, before the projector runs. Not targetable:
 * transit aims at a frame's velocity only (store/transit.ts updateAimVelocity), so a moving
 * friend would be missed, and the destination would outlive them.
 */
export const pilotPOIsAtom = atom<POIDef[]>([]);

/**
 * Rock under the nose for a ping, far beyond the 10 km mining lock: MiningSystem installs the
 * caster (it owns the streamed fields). Returns the hit in scene metres, or null.
 */
export const pingProbe = {
  castRock: null as ((maxM: number) => { localM: [number, number, number]; distM: number; fieldId: string; chunkKey: string; instanceId: number } | null) | null,
};

/**
 * Mutable shared buffer — written by POIProjector every frame.
 * POIMarkers registers a `flush` callback that POIProjector invokes
 * immediately after writing, so DOM updates happen in the same frame
 * as the 3D projection (eliminates one-frame lag).
 */
export const poiBuffer = {
  pois: [] as ProjectedPOI[],
  /** Called by POIProjector after writing pois. Set by POIMarkers. */
  flush: null as (() => void) | null,
  /** ID of the currently targeted POI (for transit autopilot). */
  targetedId: null as string | null,
  /** A destination chosen from a menu: looking away does not clear it. */
  pinnedId: null as string | null,
  /** A manually cleared target stays clear while the nose still points at it. */
  ignoreGazeUntilLookAway: null as string | null,
  /** Transit ETA in seconds for the targeted POI (null if not targeted). */
  targetedEtaS: null as number | null,
  /** The marker nearest the nose this frame (any, targetable or not): what a ping points at. */
  aimed: null as { id: string; name: string; frameId?: FrameId; positionKm: [number, number, number] } | null,
  /** Gaze progress 0..1 toward locking a new POI target. */
  gazeProgress: 0,
  /** True while the player is actively gazing at a POI that isn't yet targeted. */
  gazeActive: false,
};
