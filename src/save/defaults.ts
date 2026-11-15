import { DEFAULT_SIM_EPOCH_MS } from "@/sim/ephemeris";
import type {
  CargoState,
  ModulesState,
  PlayerState,
  ResearchState,
  SaveData,
  ShipConfig,
  WorldState,
} from "./types";

/** Bump with a migration appended to `migrations.ts`. */
export const SCHEMA_VERSION = 1;

export const DEFAULT_CARGO_CAPACITY_UNITS = 2000;

export const defaultCargo = (): CargoState => ({ capacityUnits: DEFAULT_CARGO_CAPACITY_UNITS, items: {} });

export const defaultResearch = (): ResearchState => ({ assaySamples: 0, completedNodes: [], activeResearch: null });

export const defaultModules = (): ModulesState => ({
  ownedModules: [],
  equippedModules: {},
  consumables: {},
  consumableCooldowns: {},
  hotbar: Array<string | null>(10).fill(null),
});

export const defaultShipConfig = (): ShipConfig => ({
  miningSpeedMult: 1,
  miningEfficiencyMult: 1,
  miningHeatCapacityS: 15,
  miningCooldownS: 10,
  maxHealth: 100,
  speedMult: 1,
  accelerationMult: 1,
  decelerationMult: 1,
  collisionDamageMult: 1,
  bonusCargoCapacity: 0,
  scannerLockSpeedMult: 1,
  scannerRangeMult: 1,
  assaySampleBonusChance: 0,
  hullRegenPerSecond: 0,
});

export const DEFAULT_HEALTH = 100;

export function defaultPlayerState(): PlayerState {
  return {
    ship: null,
    health: DEFAULT_HEALTH,
    isDead: false,
    cargo: defaultCargo(),
    research: defaultResearch(),
    modules: defaultModules(),
    shipConfig: defaultShipConfig(),
    aiName: null,
    commsPlayed: [],
    starMarkers: [],
    minedLifetime: 0,
  };
}

export function defaultWorldState(): WorldState {
  return { simEpochMs: DEFAULT_SIM_EPOCH_MS, simRate: 1, asteroidDeltas: {}, wrecks: [] };
}

export function defaultSaveData(playerId: string): SaveData {
  return {
    schemaVersion: SCHEMA_VERSION,
    world: defaultWorldState(),
    players: { [playerId]: defaultPlayerState() },
  };
}
