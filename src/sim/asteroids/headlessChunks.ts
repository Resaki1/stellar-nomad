/**
 * Headless chunk generation: the SAME deterministic generator the field streamer runs, with a
 * bounded cache, independent of any render draw distance. Clearance probes and the authority's
 * mine resolver both address rocks through it, so a never-streamed area resolves like a loaded one.
 */
import { generateAsteroidChunk } from "@/sim/asteroids/generation";
import { makeChunkKey, type AsteroidChunkData } from "@/sim/asteroids/runtimeTypes";
import { prepareFieldShape, type PreparedFieldShape } from "@/sim/asteroids/shapes";
import { activeSystem } from "@/sim/systemRegistry";
import {
  resolveFieldGeneration,
  resolveFieldModels,
  resolveFieldRender,
  resolveFieldStreaming,
  type AsteroidFieldDef,
  type SystemConfig,
  type WeightedModelRef,
} from "@/sim/systemTypes";

export interface FieldGen {
  field: AsteroidFieldDef;
  shape: PreparedFieldShape;
  models: WeightedModelRef[];
  chunkSizeKm: number;
  maxPerChunk: number;
}

let _fields: FieldGen[] | null = null;
let _byId: Map<string, FieldGen> | null = null;
/** Insertion-ordered Map as an LRU: a hit is re-inserted, the oldest entry is evicted. */
const _chunks = new Map<string, AsteroidChunkData>();
const CHUNK_CACHE_MAX = 512;

/** Every enabled field of the active system, with its generation parameters. */
export function headlessFields(): readonly FieldGen[] {
  if (_fields) return _fields;
  const system = activeSystem() as SystemConfig;
  _fields = (system.asteroidFields ?? [])
    .filter((f) => f.enabled !== false)
    .map((field) => {
      const render = resolveFieldRender(system, field);
      return {
        field,
        shape: prepareFieldShape(field.shape),
        models: resolveFieldModels(system, field),
        chunkSizeKm: resolveFieldStreaming(system, field, render.drawRadiusKm).chunkSizeKm,
        maxPerChunk: resolveFieldGeneration(system, field).maxAsteroidsPerChunk,
      };
    });
  _byId = new Map(_fields.map((g) => [g.field.id, g]));
  return _fields;
}

export function headlessField(fieldId: string): FieldGen | null {
  headlessFields();
  return _byId?.get(fieldId) ?? null;
}

export function headlessChunk(g: FieldGen, x: number, y: number, z: number): AsteroidChunkData {
  const key = makeChunkKey(g.field.id, { x, y, z });
  let c = _chunks.get(key);
  if (c) {
    _chunks.delete(key);
  } else {
    c = generateAsteroidChunk({ field: g.field, fieldId: g.field.id, models: g.models, shape: g.shape, coord: { x, y, z }, chunkSizeKm: g.chunkSizeKm, maxAsteroidsPerChunk: g.maxPerChunk });
    if (_chunks.size >= CHUNK_CACHE_MAX) {
      const oldest = _chunks.keys().next().value;
      if (oldest !== undefined) _chunks.delete(oldest);
    }
  }
  _chunks.set(key, c);
  return c;
}

export interface HeadlessRock {
  fieldId: string;
  chunkKey: string;
  instanceId: number;
  radiusM: number;
  /** Field-local km (relative to the field anchor). */
  localKm: [number, number, number];
}

const CHUNK_KEY_RE = /^(.+):(-?\d+),(-?\d+),(-?\d+)$/;

/** The rock a command addresses, or null when the key or id names nothing the generator makes. */
export function resolveHeadlessRock(fieldId: string, chunkKey: string, instanceId: number): HeadlessRock | null {
  const g = headlessField(fieldId);
  const m = CHUNK_KEY_RE.exec(chunkKey);
  if (!g || !m || m[1] !== fieldId) return null;
  const x = Number(m[2]), y = Number(m[3]), z = Number(m[4]);
  if (![x, y, z].every((v) => Number.isSafeInteger(v) && Math.abs(v) < 1e7)) return null;
  const c = headlessChunk(g, x, y, z);
  const id = instanceId >>> 0;
  for (const modelId in c.instancesByModel) {
    const inst = c.instancesByModel[modelId];
    for (let i = 0; i < inst.count; i++) {
      if (inst.instanceIds[i] >>> 0 !== id) continue;
      return {
        fieldId,
        chunkKey,
        instanceId: id,
        radiusM: inst.radiiM[i],
        localKm: [
          c.originKm[0] + inst.positionsM[i * 3] / 1000,
          c.originKm[1] + inst.positionsM[i * 3 + 1] / 1000,
          c.originKm[2] + inst.positionsM[i * 3 + 2] / 1000,
        ],
      };
    }
  }
  return null;
}
