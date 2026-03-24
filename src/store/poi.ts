/**
 * POI (Point of Interest) system — data types and shared mutable buffer.
 *
 * The POIProjector (R3F component) writes projected screen positions each frame.
 * The POIMarkers (HUD component) reads them via rAF for smooth updates.
 */

export type POIDef = {
  id: string;
  name: string;
  /** World position in km (simulation coordinates). */
  positionKm: [number, number, number];
  /** Hide marker when closer than this (km). */
  minDistanceKm: number;
  /** Hide marker when farther than this (km). */
  maxDistanceKm: number;
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
};

/**
 * Mutable shared buffer — written by POIProjector every frame,
 * read by POIMarkers via rAF. No React state in the hot path.
 */
export const poiBuffer = {
  pois: [] as ProjectedPOI[],
};
