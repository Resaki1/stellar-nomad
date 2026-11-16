/**
 * Turns untrusted JSON (an import, or a record written by an older build) into a well-typed
 * SaveData / SaveMeta. Missing or malformed fields fall back to defaults; structurally
 * unusable input throws.
 */
import { MAX_STORED_FUEL_KG } from "@/sim/ship/shipResources";
import { MAX_RECEIPTS, SCHEMA_VERSION, defaultPlayerState, defaultShipConfig, defaultWorldState } from "./defaults";
import { MIGRATIONS } from "./migrations";
import type {
  AsteroidDeltas,
  Difficulty,
  OperationReceipt,
  PlayerState,
  ProcessingBatch,
  QuatTuple,
  SaveData,
  SaveMeta,
  ShipConfig,
  ShipPose,
  Vec3Tuple,
  WorldState,
  WreckRecord,
} from "./types";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: unknown, fallback: number): number => (isNum(v) ? v : fallback);
const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
/** ~1000 ly: anything further is corrupt, not a place the game can put a ship. */
const MAX_POS_KM = 1e16;
/** ±~3000 years around 1970; also inside Date's ±8.64e15 ms range. */
const MAX_EPOCH_MS = 1e14;
const MAX_SIM_RATE = 1e9;
const MAX_HEALTH = 1e6;
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function numRecord(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(v)) return out;
  for (const k of Object.keys(v)) if (isNum(v[k])) out[k] = v[k] as number;
  return out;
}

/** Integer counts (cargo units, consumables): floored, zero/negative/non-finite dropped. */
function countRecord(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(v)) return out;
  for (const k of Object.keys(v)) {
    const n = v[k];
    if (isNum(n) && n >= 1) out[k] = Math.min(Math.floor(n), 1e9);
  }
  return out;
}

/** Fuel mass, kg: non-finite → fallback, negative → 0, bounded. */
const fuelKg = (v: unknown, fallback: number): number => (isNum(v) ? Math.min(Math.max(0, v), MAX_STORED_FUEL_KG) : fallback);
const unit01 = (v: unknown, fallback: number): number => (isNum(v) ? Math.min(Math.max(0, v), 1) : fallback);

function uniqueStrings(v: unknown): string[] {
  return Array.from(new Set(strArray(v)));
}

function tuple<N extends 3 | 4>(v: unknown, n: N): (N extends 3 ? Vec3Tuple : QuatTuple) | null {
  if (!Array.isArray(v) || v.length !== n || !v.every(isNum)) return null;
  return [...v] as N extends 3 ? Vec3Tuple : QuatTuple;
}

function position(v: unknown): Vec3Tuple | null {
  const p = tuple(v, 3);
  return p && p.every((x) => Math.abs(x) <= MAX_POS_KM) ? p : null;
}

/** Normalised; null for a (near-)zero quaternion. */
function unitQuat(v: unknown): QuatTuple | null {
  const q = tuple(v, 4);
  if (!q) return null;
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (len < 1e-6) return null;
  // Leave unit input bit-exact so a load/export round trip is lossless.
  return Math.abs(len - 1) < 1e-6 ? q : [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

export function sanitizePose(v: unknown): ShipPose | null {
  if (!isObj(v) || typeof v.frameId !== "string") return null;
  const p = position(v.positionKm);
  const q = unitQuat(v.quaternion);
  return p && q ? { frameId: v.frameId, positionKm: p, quaternion: q } : null;
}

export function sanitizeWreck(v: unknown): WreckRecord | null {
  if (!isObj(v) || typeof v.id !== "string" || typeof v.frameId !== "string") return null;
  const p = position(v.positionKm);
  if (!p) return null;
  return {
    id: v.id,
    frameId: v.frameId,
    positionKm: p,
    items: countRecord(v.items),
    fuelKg: fuelKg(v.fuelKg, 0),
    consumables: countRecord(v.consumables),
    createdAt: num(v.createdAt, 0),
  };
}

function sanitizeDeltas(v: unknown): AsteroidDeltas {
  const out: AsteroidDeltas = {};
  if (!isObj(v)) return out;
  for (const fieldId of Object.keys(v)) {
    const chunks = v[fieldId];
    if (!isObj(chunks)) continue;
    const f: Record<string, number[]> = {};
    for (const chunkKey of Object.keys(chunks)) {
      const ids = chunks[chunkKey];
      if (!Array.isArray(ids)) continue;
      const clean = ids.filter(isNum).map((id) => id >>> 0);
      if (clean.length > 0) f[chunkKey] = clean;
    }
    out[fieldId] = f;
  }
  return out;
}

export function sanitizeWorld(v: unknown): WorldState {
  const d = defaultWorldState();
  if (!isObj(v)) return d;
  return {
    simEpochMs: isNum(v.simEpochMs) && Math.abs(v.simEpochMs) <= MAX_EPOCH_MS ? v.simEpochMs : d.simEpochMs,
    simRate: Math.max(-MAX_SIM_RATE, Math.min(MAX_SIM_RATE, num(v.simRate, d.simRate))),
    asteroidDeltas: sanitizeDeltas(v.asteroidDeltas),
    wrecks: Array.isArray(v.wrecks)
      ? v.wrecks.map(sanitizeWreck).filter((w): w is WreckRecord => w !== null)
      : [],
    research: { completedNodes: uniqueStrings(isObj(v.research) ? v.research.completedNodes : undefined) },
    receipts: sanitizeReceipts(v.receipts),
  };
}

function sanitizeReceipts(v: unknown): OperationReceipt[] {
  if (!Array.isArray(v)) return [];
  const out: OperationReceipt[] = [];
  const seen = new Set<string>();
  for (const r of v) {
    if (!isObj(r) || typeof r.opId !== "string" || r.opId === "" || seen.has(r.opId)) continue;
    seen.add(r.opId);
    out.push({ opId: r.opId, type: str(r.type, ""), by: str(r.by, ""), at: num(r.at, 0) });
  }
  return out.slice(-MAX_RECEIPTS);
}

function sanitizeProcessing(v: unknown): ProcessingBatch | null {
  if (!isObj(v) || typeof v.id !== "string" || typeof v.recipeId !== "string") return null;
  return {
    id: v.id,
    recipeId: v.recipeId,
    reserved: countRecord(v.reserved),
    elapsedS: Math.max(0, num(v.elapsedS, 0)),
    committedKg: fuelKg(v.committedKg, 0),
  };
}

function sanitizeShipConfig(v: unknown): ShipConfig {
  const d = defaultShipConfig();
  if (!isObj(v)) return d;
  for (const k of Object.keys(d) as (keyof ShipConfig)[]) d[k] = num(v[k], d[k]);
  return d;
}

export function sanitizePlayer(v: unknown): PlayerState {
  const d = defaultPlayerState();
  if (!isObj(v)) return d;
  const cargo = isObj(v.cargo) ? v.cargo : {};
  const research = isObj(v.research) ? v.research : {};
  const active = isObj(research.activeResearch) ? research.activeResearch : null;
  const modules = isObj(v.modules) ? v.modules : {};
  const hotbar = Array.isArray(modules.hotbar)
    ? modules.hotbar.slice(0, 10).map((x) => (typeof x === "string" ? x : null))
    : d.modules.hotbar;
  while (hotbar.length < 10) hotbar.push(null);
  const equipped: Obj = isObj(modules.equippedModules) ? modules.equippedModules : {};
  const propellant = isObj(v.propellant) ? v.propellant : {};
  const power = isObj(v.power) ? v.power : {};
  return {
    ship: sanitizePose(v.ship),
    health: Math.max(0, Math.min(MAX_HEALTH, num(v.health, d.health))),
    isDead: v.isDead === true,
    cargo: { capacityUnits: Math.max(0, num(cargo.capacityUnits, d.cargo.capacityUnits)), items: countRecord(cargo.items) },
    research: {
      assaySamples: Math.max(0, Math.floor(num(research.assaySamples, 0))),
      activeResearch:
        active && typeof active.nodeId === "string"
          ? { nodeId: active.nodeId, elapsedS: Math.max(0, num(active.elapsedS, 0)) }
          : null,
    },
    modules: {
      ownedModules: uniqueStrings(modules.ownedModules),
      equippedModules: Object.fromEntries(
        Object.entries(equipped).filter((e): e is [string, string] => typeof e[1] === "string"),
      ),
      consumables: countRecord(modules.consumables),
      consumableCooldowns: numRecord(modules.consumableCooldowns),
      hotbar,
    },
    shipConfig: sanitizeShipConfig(v.shipConfig),
    aiName: typeof v.aiName === "string" ? v.aiName : null,
    commsPlayed: strArray(v.commsPlayed),
    starMarkers: strArray(v.starMarkers),
    minedLifetime: Math.max(0, Math.floor(num(v.minedLifetime, 0))),
    propellant: {
      ordinaryKg: fuelKg(propellant.ordinaryKg, d.propellant.ordinaryKg),
      protectedKg: fuelKg(propellant.protectedKg, d.propellant.protectedKg),
    },
    power: { capacitor01: unit01(power.capacitor01, d.power.capacitor01), heat01: unit01(power.heat01, d.power.heat01) },
    processing: sanitizeProcessing(v.processing),
  };
}

/** Applies migrations, then sanitizes. Throws on input that is not a save at all. */
export function parseSaveData(raw: unknown): SaveData {
  if (!isObj(raw)) throw new Error("save data is not an object");
  let data: Obj = raw;
  const version = num(data.schemaVersion, 0);
  if (version < 1 || !Number.isInteger(version)) throw new Error(`bad schemaVersion ${String(data.schemaVersion)}`);
  if (version > SCHEMA_VERSION) throw new Error(`save is from a newer build (schema ${version} > ${SCHEMA_VERSION})`);
  for (let v = version; v < SCHEMA_VERSION; v++) data = MIGRATIONS[v - 1](data);
  if (!isObj(data.world) || !isObj(data.players)) throw new Error("save data has no world or players");
  const players: Record<string, PlayerState> = {};
  for (const id of Object.keys(data.players)) players[id] = sanitizePlayer(data.players[id]);
  return { schemaVersion: SCHEMA_VERSION, world: sanitizeWorld(data.world), players };
}

const DIFFICULTIES: readonly Difficulty[] = ["explorer", "standard", "hard"];

export function parseSaveMeta(raw: unknown, fallbackId: string): SaveMeta {
  const v = isObj(raw) ? raw : {};
  const now = Date.now();
  return {
    id: str(v.id, fallbackId),
    name: str(v.name, "Imported world").slice(0, 64),
    seed: num(v.seed, 0) >>> 0,
    difficulty: DIFFICULTIES.includes(v.difficulty as Difficulty) ? (v.difficulty as Difficulty) : "standard",
    createdAt: num(v.createdAt, now),
    lastPlayedAt: num(v.lastPlayedAt, now),
    playTimeS: Math.max(0, num(v.playTimeS, 0)),
    schemaVersion: num(v.schemaVersion, SCHEMA_VERSION),
  };
}
