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
  /** Chosen at creation; applied through `src/sim/difficulty.ts`. */
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
  /** Unlocked option ids in unlock order (schema 3: the M3.3 catalogue). */
  completedNodes: string[];
  /** Schema 3: pre-M3.3 node ids with no mapping, kept inert. */
  legacy: string[];
}

/** One confirmed material family (schema 3). Recorded once; flags only ever turn on. */
export interface FamilyFinding {
  firstAt: number;
  by: PlayerId;
  /** Confirmed by a close inspection / by extraction. */
  inspected: boolean;
  extracted: boolean;
  /** Source that first confirmed it, if inspected. */
  sourceId: string | null;
}

/** An inspected rock: stable `fieldId:chunkKey:asteroidId` id, never an instance index. */
export interface SourceFinding {
  id: string;
  fieldId: string;
  chunkKey: string;
  asteroidId: number;
  classId: string;
  /** Frame-relative position (the field's anchor body), km. */
  frameId: string;
  positionKm: Vec3Tuple;
  radiusM: number;
  /** Estimated yield, material → integer units (before equipment). */
  composition: Record<string, number>;
  depleted: boolean;
  foundAt: number;
  by: PlayerId;
}

export interface EvidenceStamp {
  at: number;
  by: PlayerId;
}

/** Durable world findings (schema 3). Written only by accepted operations. */
export interface DiscoveryState {
  families: Record<string, FamilyFinding>;
  /** Bounded (MAX_SOURCES), oldest first. */
  sources: SourceFinding[];
  /** Recovered authored sites (one-time rewards). */
  sites: Record<string, EvidenceStamp>;
  trials: Record<string, EvidenceStamp>;
  /** Schema 5: authored sites closely inspected (recovery needs it). */
  inspectedSites: Record<string, EvidenceStamp>;
}

/** One accepted operation, for duplicate rejection across reloads. */
export interface OperationReceipt {
  opId: string;
  type: string;
  by: PlayerId;
  /** Wall clock ms at acceptance. */
  at: number;
}

/** A placed replication point (schema 4). World-owned; no per-player active flag on it. */
export interface ReplicationPoint {
  id: string;
  name: string;
  frameId: string;
  /** Relative to `frameId`'s origin, km. */
  positionKm: Vec3Tuple;
  quaternion: QuatTuple;
  by: PlayerId;
  createdAt: number;
  /** The protected, supplied initial point every world has. */
  starter: boolean;
}

export interface ReplicationState {
  /** Starter first, then placement order; bounded (MAX_POINTS). */
  points: ReplicationPoint[];
}

/** A player's own recovery selection (schema 4). */
export interface PlayerReplicationState {
  activeId: string;
}

export interface WorldState {
  simEpochMs: number;
  simRate: number;
  asteroidDeltas: AsteroidDeltas;
  wrecks: WreckRecord[];
  research: SharedResearchState;
  discoveries: DiscoveryState;
  replication: ReplicationState;
  /** Bounded, oldest first (MAX_RECEIPTS). */
  receipts: OperationReceipt[];
}

export type CargoState = {
  /** Maximum cargo capacity in "cargo units". */
  capacityUnits: number;
  /** ResourceId -> amount (integer units). */
  items: Record<string, number>;
};

/** Schema 3: what the M3.3 migration could not map, kept inert (never read by gameplay). */
export interface PlayerLegacyState {
  assaySamples: number;
  activeResearch: { nodeId: string; elapsedS: number } | null;
  items: string[];
  consumables: Record<string, number>;
  notes: string[];
}

/** A player's named bookmark of a world source (schema 3). */
export interface SourceBookmark {
  sourceId: string;
  name: string;
}

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

  /** Close-inspection time / range multipliers (1 = base). */
  scannerInspectTimeMult: number;
  scannerInspectRangeMult: number;

  // ── Ship resources (applied to the resource tuning by `equipTuning`) ──
  tankBonusKg: number;
  reactorBonusKW: number;
  miningPowerMult: number;
  processingRateMult: number;
  heatCapacityMult: number;

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

/** What the last death left at its wreck (recovery screen across a reload). */
export interface LossRecord {
  items: Record<string, number>;
  consumables: Record<string, number>;
  fuelKg: number;
  cause: "impact" | "abandon";
}

export interface PlayerState {
  /** null = never saved; the ship spawns at the system's starting position. */
  ship: ShipPose | null;
  health: number;
  isDead: boolean;
  cargo: CargoState;
  modules: ModulesState;
  shipConfig: ShipConfig;
  aiName: string | null;
  commsPlayed: string[];
  starMarkers: string[];
  minedLifetime: number;
  propellant: PropellantState;
  power: PowerState;
  processing: ProcessingBatch | null;
  bookmarks: SourceBookmark[];
  legacy: PlayerLegacyState | null;
  replication: PlayerReplicationState;
  lastLoss: LossRecord | null;
  /** Schema 5: the player's tracked project id (src/data/projects.ts), or null. */
  trackedProject: string | null;
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
