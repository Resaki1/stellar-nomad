/**
 * Save model (ROADMAP M0.3). One record per world; player progress lives INSIDE the world,
 * keyed by player id, so a co-op host's world carries every guest's progress.
 */
import type { ItemSlot } from "@/data/content";

export type PlayerId = string;
export type WorldId = string;
export type Difficulty = "explorer" | "standard" | "hard";

export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];

export interface SaveMeta {
  id: WorldId;
  name: string;
  /** Stored, not consumed yet. */
  seed: number;
  /** Stored, not consumed yet. */
  difficulty: Difficulty;
  createdAt: number;
  lastPlayedAt: number;
  playTimeS: number;
  schemaVersion: number;
}

/** Frame-relative ship pose (see sim/frames.ts). */
export interface ShipPose {
  frameId: string;
  positionKm: Vec3Tuple;
  quaternion: QuatTuple;
}

export interface WreckRecord {
  id: string;
  frameId: string;
  /** Relative to `frameId`'s origin, km. */
  positionKm: Vec3Tuple;
  /** Material cargo: resourceId → integer units. */
  items: Record<string, number>;
  /** Ordinary propellant, kg (finite, ≥ 0). Never the protected allowance. Schema 2+. */
  fuelKg: number;
  /** Loose consumables: itemId → integer count. Schema 2+. */
  consumables: Record<string, number>;
  createdAt: number;
}

/** Bucket for migrated ids whose chunk is unknown (legacy per-field lists). */
export const UNCHUNKED = "unchunked";

/** fieldId → chunkKey (or UNCHUNKED) → destroyed instance ids. */
export type AsteroidDeltas = Record<string, Record<string, number[]>>;

/** World-shared research progress (schema 2+). Only the world authority writes it. */
export interface SharedResearchState {
  /** Completed node ids in completion order. Ids unknown to this build are kept, inert. */
  completedNodes: string[];
}

/** One accepted operation, for duplicate rejection across reloads. */
export interface OperationReceipt {
  opId: string;
  type: string;
  by: PlayerId;
  /** Wall clock ms at acceptance. */
  at: number;
}

export interface WorldState {
  simEpochMs: number;
  simRate: number;
  asteroidDeltas: AsteroidDeltas;
  wrecks: WreckRecord[];
  research: SharedResearchState;
  /** Bounded, oldest first (MAX_RECEIPTS). */
  receipts: OperationReceipt[];
}

export type CargoState = {
  /** Maximum cargo capacity in "cargo units". */
  capacityUnits: number;
  /** ResourceId -> amount (integer units). */
  items: Record<string, number>;
};

/** Per-player until PR 2 retires assay samples and the timer; completions live in the world. */
export type ResearchState = {
  /** Non-cargo currency earned from mining. */
  assaySamples: number;
  /** Currently active research (only one at a time). */
  activeResearch: { nodeId: string; elapsedS: number } | null;
};

export type ModulesState = {
  /** moduleItemId[] — all owned module items. */
  ownedModules: string[];
  /** One module per slot. Only equipped modules contribute stat effects. */
  equippedModules: Partial<Record<ItemSlot, string>>;
  /** consumableItemId → current stack count. */
  consumables: Record<string, number>;
  /** consumableItemId → timestamp (ms) of last use for cooldown tracking. */
  consumableCooldowns: Record<string, number>;
  /** Hotbar: index 0-9 → consumable item ID (or null). */
  hotbar: (string | null)[];
};

export type ShipConfig = {
  // ── Mining ──
  /** Multiplier on mining speed (1 = base). Higher = faster mining. */
  miningSpeedMult: number;
  /** Multiplier on mining yield (1 = base). Higher = more resources per rock. */
  miningEfficiencyMult: number;
  /** Max continuous mining time in seconds before overheat. */
  miningHeatCapacityS: number;
  /** Time in seconds for a full cooldown from 100% heat to 0%. */
  miningCooldownS: number;

  // ── Ship ──
  /** Max hull HP. */
  maxHealth: number;
  /** Top-speed multiplier (1 = base). */
  speedMult: number;
  /** Acceleration multiplier (1 = base). */
  accelerationMult: number;
  /** Deceleration multiplier (1 = base). */
  decelerationMult: number;
  /** Collision damage multiplier (1 = base). Lower = less damage. */
  collisionDamageMult: number;
  /** Extra cargo capacity from modules/research (added on top of base). */
  bonusCargoCapacity: number;

  // ── Scanner ──
  /** Target lock speed multiplier (1 = base). Lower = faster lock. */
  scannerLockSpeedMult: number;
  /** All sensor ranges multiplier (1 = base). */
  scannerRangeMult: number;

  // ── Economy ──
  /** Probability (0-1) of receiving a bonus assay sample from mining. */
  assaySampleBonusChance: number;

  // ── Survivability ──
  /** Passive hull regeneration per second. */
  hullRegenPerSecond: number;
};

/** Propellant, kg: finite, ≥ 0, fractional. */
export interface PropellantState {
  ordinaryKg: number;
  /** Protected recovery allowance; separate from ordinary tanks. */
  protectedKg: number;
}

/** Fractions of the equipment-defined stores (0–1), so a capacity change keeps them valid. */
export interface PowerState {
  capacitor01: number;
  heat01: number;
}

/** One onboard processing batch (M3.2). Reserved feedstock is already out of cargo. */
export interface ProcessingBatch {
  id: string;
  recipeId: string;
  /** resourceId → integer units reserved. */
  reserved: Record<string, number>;
  /** Executed simulation seconds so far. */
  elapsedS: number;
  /** Output already delivered to the ordinary tank, kg. */
  committedKg: number;
}

export interface PlayerState {
  /** null = never saved; the ship spawns at the system's starting position. */
  ship: ShipPose | null;
  health: number;
  isDead: boolean;
  cargo: CargoState;
  research: ResearchState;
  modules: ModulesState;
  shipConfig: ShipConfig;
  aiName: string | null;
  commsPlayed: string[];
  starMarkers: string[];
  minedLifetime: number;
  propellant: PropellantState;
  power: PowerState;
  processing: ProcessingBatch | null;
}

export interface SaveData {
  schemaVersion: number;
  world: WorldState;
  players: Record<PlayerId, PlayerState>;
}

export interface SaveRecord {
  meta: SaveMeta;
  data: SaveData;
}
