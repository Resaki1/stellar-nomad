/** The structural mesh and the fixed contact boxes use the same metre dimensions. */
export const DEPOT_HULL = [
  { part: "core", position: [0, 0, 0], size: [16, 8, 24] },
  { part: "spine", position: [0, 0, -15], size: [9, 6, 8] },
  { part: "front", position: [0, 0, 14], size: [12, 6, 4] },
  { part: "tank", position: [-11, -1, 0], size: [6, 8, 16] },
  { part: "tank", position: [11, -1, 0], size: [6, 8, 16] },
  { part: "outrigger", position: [-19, 0, -4], size: [10, 3, 3] },
  { part: "outrigger", position: [19, 0, -4], size: [10, 3, 3] },
  { part: "radiator", position: [-25, 0, -4], size: [6, 0.7, 12] },
  { part: "radiator", position: [25, 0, -4], size: [6, 0.7, 12] },
] as const;
