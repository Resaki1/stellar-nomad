import { DEFAULT_SIM_EPOCH_MS } from "@/sim/ephemeris";
import { PROPELLANT_TANK_KG, RECOVERY_ALLOWANCE_KG } from "@/sim/ship/shipResources";
import { STARTER_POINT_ID, starterPoint } from "@/sim/replication/points";
import type {
  CargoState,
  DiscoveryState,
  ModulesState,
  PlayerState,
  PowerState,
  PropellantState,
  SaveData,
  ShipConfig,
  WorldState,
} from "./types";

/** Bump with a migration appended to `migrations.ts`. */
export const SCHEMA_VERSION = 4;

/** Bound of `WorldState.receipts`. */
export const MAX_RECEIPTS = 256;

/** Bound of `WorldState.discoveries.sources` and of each player's bookmarks. */
export const MAX_SOURCES = 64;
export const MAX_BOOKMARKS = 24;
export const MAX_LEGACY_IDS = 256;

export const DEFAULT_CARGO_CAPACITY_UNITS = 2000;

export const defaultCargo = (): CargoState => ({ capacityUnits: DEFAULT_CARGO_CAPACITY_UNITS, items: {} });

export const defaultDiscoveries = (): DiscoveryState => ({ families: {}, sources: [], sites: {}, trials: {} });

export const defaultPropellant = (): PropellantState => ({ ordinaryKg: PROPELLANT_TANK_KG, protectedKg: RECOVERY_ALLOWANCE_KG });

export const defaultPower = (): PowerState => ({ capacitor01: 1, heat01: 0 });

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
  hullRegenPerSecond: 0,
  scannerInspectTimeMult: 1,
  scannerInspectRangeMult: 1,
  tankBonusKg: 0,
  reactorBonusKW: 0,
  miningPowerMult: 1,
  processingRateMult: 1,
  heatCapacityMult: 1,
});

export const DEFAULT_HEALTH = 100;

export function defaultPlayerState(): PlayerState {
  return {
    ship: null,
    health: DEFAULT_HEALTH,
    isDead: false,
    cargo: defaultCargo(),
    modules: defaultModules(),
    shipConfig: defaultShipConfig(),
    aiName: null,
    commsPlayed: [],
    starMarkers: [],
    minedLifetime: 0,
    propellant: defaultPropellant(),
    power: defaultPower(),
    processing: null,
    bookmarks: [],
    legacy: null,
    replication: { activeId: STARTER_POINT_ID },
    lastLoss: null,
  };
}

export function defaultWorldState(): WorldState {
  return {
    simEpochMs: DEFAULT_SIM_EPOCH_MS,
    simRate: 1,
    asteroidDeltas: {},
    wrecks: [],
    research: { completedNodes: [], legacy: [] },
    discoveries: defaultDiscoveries(),
    replication: { points: [starterPoint()] },
    receipts: [],
  };
}

export function defaultSaveData(playerId: string): SaveData {
  return {
    schemaVersion: SCHEMA_VERSION,
    world: defaultWorldState(),
    players: { [playerId]: defaultPlayerState() },
  };
}
