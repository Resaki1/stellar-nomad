/**
 * POI (Point of Interest) system — data types and shared mutable buffer.
 *
 * The POIProjector (R3F component) writes projected screen positions each frame.
 * The POIMarkers (HUD component) reads them via rAF for smooth updates.
 */

import type { FrameId } from "@/sim/frames";
import type { TransitFieldArrival } from "@/sim/ship/transitDrive";

export type POIDef = {
  id: string;
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
  /** Transit ETA in seconds for the targeted POI (null if not targeted). */
  targetedEtaS: null as number | null,
  /** Gaze progress 0..1 toward locking a new POI target. */
  gazeProgress: 0,
  /** True while the player is actively gazing at a POI that isn't yet targeted. */
  gazeActive: false,
};
