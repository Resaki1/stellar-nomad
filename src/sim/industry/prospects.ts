import type { Vec3Tuple } from "@/save/types";
import type { IndustrySource } from "./catalog";
import type { DepotRecord } from "./types";

interface ProspectPart {
  position: Vec3Tuple;
  rotation: Vec3Tuple;
  scale: Vec3Tuple;
  deposit: boolean;
}

/** Dodecahedra of unit radius, transformed in metres about the survey worksite. */
export const PROSPECT_PARTS: readonly ProspectPart[] = [
  { position: [0, 0, 0], rotation: [0, 0, 0], scale: [7, 4, 5], deposit: false },
  { position: [3, 1, -1], rotation: [0.2, 0.1, 0.6], scale: [3.5, 2.8, 1.4], deposit: true },
  { position: [-10, 3, 7], rotation: [1, 0.7, 0.4], scale: [2.8, 2.2, 2.1], deposit: false },
];

export const PROSPECT_RADIUS_M = Math.max(...PROSPECT_PARTS.map(part =>
  Math.hypot(...part.position) + Math.max(...part.scale)));
export const PROSPECT_DEPOT_CLEARANCE_KM = 0.065;

export function prospectWorksite(source: IndustrySource, depots: readonly DepotRecord[]): IndustrySource {
  const [x, y, z] = source.positionKm;
  // The marker stays clear for a source depot. Keep the old offset search for existing saves.
  let offsetKm = 0.085;
  while (depots.some(d => d.frameId === source.frameId &&
    Math.hypot(d.positionKm[0] - x, d.positionKm[1] - y - offsetKm, d.positionKm[2] - z) < PROSPECT_DEPOT_CLEARANCE_KM)) {
    offsetKm += 0.145;
  }
  return { ...source, positionKm: [x, y + offsetKm, z] };
}
