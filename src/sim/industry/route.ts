import type { ShipPose } from "@/save/types";
import { INDUSTRY_TUNING as T } from "./catalog";
import { depotDistanceKm } from "./placement";
import type { DroneWaypoint } from "./types";

type Position = Pick<ShipPose, "frameId" | "positionKm">;

export interface DroneRoute {
  pathKm: number;
  legSeconds: number;
  roundTripFuelKg: number;
  via: DroneWaypoint | null;
}

type RouteGeometry = Pick<DroneRoute, "pathKm" | "via">;
type DronePathPlanner = (home: Position, destination: Position, directKm: number) => RouteGeometry | null;

// Installed by the solo and co-op authority adapters on gameplay boot. Saves, migrations
// and title-screen code can share the industry state without loading the transit planner.
let planner: DronePathPlanner | null = null;
export function registerDronePathPlanner(fn: DronePathPlanner): void {
  planner = fn;
}

/** Departure estimate from the current ephemeris. Fund both directions on the same cleared path. */
export function estimateDroneRoute(home: Position, destination: Position): DroneRoute | null {
  const directKm = depotDistanceKm(home, destination);
  if (!Number.isFinite(directKm) || directKm > T.maxRouteKm) return null;
  const geometry = planner?.(home, destination, directKm);
  if (!geometry || geometry.pathKm > T.maxRouteKm) return null;
  const { pathKm, via } = geometry;
  return {
    pathKm, via, legSeconds: T.minLegSeconds + Math.ceil(pathKm / T.cruiseKmPerS),
    roundTripFuelKg: 2 * Math.ceil(1 + pathKm / T.legFuelDistanceKm),
  };
}
