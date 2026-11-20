import type { IndustryBlueprint } from "@/data/content";
import type { Vec3Tuple } from "@/save/types";
import { loadSystem } from "@/sim/systemRegistry";

export const DEPOT_KIT_ID = "consumable_depot_kit";
export const DRONE_FUEL_ID = "propellant";
export const POINT_TANK_CAPACITY_KG = 1_200;
export const POINT_TANK_RECIPE = { fe_ni_metal: 120, silicates: 50 } as const;

export const INDUSTRY_TUNING = {
  maxDepots: 24,
  dronesPerDepot: 2,
  placeDistanceKm: 0.8,
  interactRangeKm: 2,
  depotClearanceKm: 0.2,
  shipClearanceKm: 0.07,
  cargoCapacity: 6000,
  fuelCapacityKg: 3000,
  refineSeconds: 2,
  refineKgPerHydrate: 20,
  sourceCapacity: 12,
  sourceSecondsPerUnit: 4,
  extractUnits: 8,
  extractSeconds: 6,
  loadUnits: 40,
  loadFuelKg: 120,
  deliverySeconds: 2,
  minLegSeconds: 4,
  cruiseKmPerS: 0.14,
  accelerationKmPerS2: 0.018,
  terminalDistanceKm: 3,
  fieldAccelerationKmPerS2: 0.05,
  maxLocalRouteKm: 30,
  extractionRangeKm: 30,
  droneMiningSpeedMult: 0.6,
  droneTankKg: 120,
  droneDryMassKg: 1200,
  dronePropellantScale: 0.12,
  cargoUnitMassKg: 25,
  /** Drop long timer gaps instead of awarding production after sleep or a suspended page. */
  maxTickGapS: 3,
};

export interface IndustrySource {
  id: string;
  name: string;
  frameId: string;
  fieldId: string;
  positionKm: Vec3Tuple;
  materialId: string;
  rangeKm: number;
}

function fieldSource(id: string, name: string, fieldId: string, offsetKm: Vec3Tuple): IndustrySource {
  const field = loadSystem("sol").asteroidFields.find(f => f.id === fieldId);
  if (!field?.anchorBody || !field.anchorOffsetKm) throw new Error(`Missing field anchor for ${id}`);
  const [x, y, z] = field.anchorOffsetKm;
  const positionKm: Vec3Tuple = [x + offsetKm[0], y + offsetKm[1], z + offsetKm[2]];
  return { id, name, fieldId, frameId: field.anchorBody, positionKm, materialId: "hydrates", rangeKm: INDUSTRY_TUNING.extractionRangeKm };
}

/** Navigation landmarks in volatile-rich regions. Older saved extractor trips also refer to their IDs. */
export const INDUSTRY_SOURCES: IndustrySource[] = [
  // Center of the authored origin_volatile pocket's first 20 km chunk.
  fieldSource("earth_hydrates", "Earth hydrate site", "origin_belt", [-2810, 170, -190]),
  // Beyond lunar transit clearance, near the outer edge of the denser part of the belt.
  fieldSource("luna_hydrates", "Lunar hydrate site", "luna_belt", [530, 1485, 167]),
];

export function getIndustrySource(id: unknown): IndustrySource | undefined {
  return INDUSTRY_SOURCES.find(s => s.id === id);
}

export interface DepotRecipe {
  blueprint?: IndustryBlueprint;
  id: string;
  name: string;
  description: string;
  recipe: Record<string, number>;
  output: "refinery" | "drone" | "consumable";
  itemId?: string;
}

export const DEPOT_RECIPES: DepotRecipe[] = [
  { id: "refinery", blueprint: "refinery", name: "Hydrate refinery", description: "Turn stored hydrates into propellant.",
    recipe: { fe_ni_metal: 75, silicates: 50 }, output: "refinery" },
  { id: "drone", blueprint: "drone", name: "Utility drone", description: "Mine nearby asteroids or haul supplies between stations.",
    recipe: { fe_ni_metal: 45, silicates: 30, carbon: 10 }, output: "drone" },
  { id: "replication_kit", name: "Replication kit", description: "Fabricate a portable recovery point using depot stock.",
    recipe: { fe_ni_metal: 125, silicates: 80 }, output: "consumable", itemId: "consumable_replication_kit" },
  { id: "hull_patch", name: "Hull patch kit", description: "Fabricate a hull patch using depot stock.",
    recipe: { fe_ni_metal: 12, silicates: 8 }, output: "consumable", itemId: "consumable_hull_patch_kit" },
  { id: "depot_kit", blueprint: "depot_kit", name: "Depot kit", description: "Fabricate a second depot for a fuel route.",
    recipe: { fe_ni_metal: 100, silicates: 75 }, output: "consumable", itemId: DEPOT_KIT_ID },
];
