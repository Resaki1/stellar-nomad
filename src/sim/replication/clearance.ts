/**
 * Geometry clearance for replication points and recovery emergence: altitude over every body
 * (live ephemeris) and rock surface distance from the SAME deterministic chunk generator the
 * field streamer runs, so a remote, never-streamed area validates exactly as a loaded one.
 */
import { Vector3 } from "three";
import { allBodyDefs } from "@/sim/celestialConstants";
import { frameOriginKm } from "@/sim/frames";
import { generateAsteroidChunk } from "@/sim/asteroids/generation";
import { makeChunkKey } from "@/sim/asteroids/runtimeTypes";
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
import type { AsteroidChunkData } from "@/sim/asteroids/runtimeTypes";
import { registerClearanceProbe, type DestroyedLookup, type Obstruction } from "./placement";

export type { DestroyedLookup, Obstruction };

interface FieldGen {
  field: AsteroidFieldDef;
  shape: PreparedFieldShape;
  models: WeightedModelRef[];
  chunkSizeKm: number;
  maxPerChunk: number;
}

let _fields: FieldGen[] | null = null;
const _chunks = new Map<string, AsteroidChunkData>();
const CHUNK_CACHE_MAX = 512;
const _o = new Vector3();

function fields(): FieldGen[] {
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
  return _fields;
}

function chunk(g: FieldGen, x: number, y: number, z: number): AsteroidChunkData {
  const key = makeChunkKey(g.field.id, { x, y, z });
  let c = _chunks.get(key);
  if (!c) {
    if (_chunks.size >= CHUNK_CACHE_MAX) _chunks.clear();
    c = generateAsteroidChunk({ field: g.field, fieldId: g.field.id, models: g.models, shape: g.shape, coord: { x, y, z }, chunkSizeKm: g.chunkSizeKm, maxAsteroidsPerChunk: g.maxPerChunk });
    _chunks.set(key, c);
  }
  return c;
}

/** Nearest intact rock surface from a system-frame point, m, searching `searchM` beyond the largest rock. */
function rockClearanceM(ax: number, ay: number, az: number, searchM: number, destroyed: DestroyedLookup | null): number {
  let best = Infinity;
  for (const g of fields()) {
    const a = g.field.anchorKm;
    const lx = ax - a[0], ly = ay - a[1], lz = az - a[2];
    const reachKm = (searchM + g.field.size.maxRadiusM) / 1000;
    if (g.shape.distanceToKm(lx, ly, lz) > reachKm) continue;
    const cs = g.chunkSizeKm;
    const x0 = Math.floor((lx - reachKm) / cs), x1 = Math.floor((lx + reachKm) / cs);
    const y0 = Math.floor((ly - reachKm) / cs), y1 = Math.floor((ly + reachKm) / cs);
    const z0 = Math.floor((lz - reachKm) / cs), z1 = Math.floor((lz + reachKm) / cs);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const c = chunk(g, x, y, z);
      for (const modelId in c.instancesByModel) {
        const inst = c.instancesByModel[modelId];
        for (let i = 0; i < inst.count; i++) {
          const dx = (c.originKm[0] - lx) * 1000 + inst.positionsM[i * 3];
          const dy = (c.originKm[1] - ly) * 1000 + inst.positionsM[i * 3 + 1];
          const dz = (c.originKm[2] - lz) * 1000 + inst.positionsM[i * 3 + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - inst.radiiM[i];
          if (d >= best) continue;
          if (destroyed?.has(g.field.id, c.key, inst.instanceIds[i] >>> 0)) continue;
          best = d;
        }
      }
    }
  }
  return best;
}

/** Bodies and rocks around a frame-relative position (at the current ephemeris instant). */
export function probeClearance(frameId: string, posKm: readonly number[], searchM: number, destroyed: DestroyedLookup | null, out: Obstruction): Obstruction {
  frameOriginKm(frameId, _o);
  const ax = _o.x + posKm[0], ay = _o.y + posKm[1], az = _o.z + posKm[2];
  out.bodyAltKm = Infinity;
  out.bodyId = null;
  for (const b of allBodyDefs()) {
    const p = b.positionKm;
    if (!p || !(b.radiusKm > 0)) continue;
    const alt = Math.hypot(ax - p[0], ay - p[1], az - p[2]) - b.radiusKm;
    if (alt < out.bodyAltKm) {
      out.bodyAltKm = alt;
      out.bodyId = b.id;
    }
  }
  out.rockClearM = rockClearanceM(ax, ay, az, searchM, destroyed);
  return out;
}

registerClearanceProbe(probeClearance);

/** System-frame km of a frame-relative position. */
export function absoluteKm(frameId: string, posKm: readonly number[], out: Vector3): Vector3 {
  frameOriginKm(frameId, out);
  return out.set(out.x + posKm[0], out.y + posKm[1], out.z + posKm[2]);
}

/** Whether every field chunk within `reachKm` of a system-frame point has been streamed in. */
export function arrivalChunksReady(abs: { x: number; y: number; z: number }, reachKm: number, hasChunk: (fieldId: string, chunkKey: string) => boolean): boolean {
  for (const g of fields()) {
    const a = g.field.anchorKm;
    const lx = abs.x - a[0], ly = abs.y - a[1], lz = abs.z - a[2];
    if (g.shape.distanceToKm(lx, ly, lz) > reachKm) continue;
    const cs = g.chunkSizeKm;
    const x0 = Math.floor((lx - reachKm) / cs), x1 = Math.floor((lx + reachKm) / cs);
    const y0 = Math.floor((ly - reachKm) / cs), y1 = Math.floor((ly + reachKm) / cs);
    const z0 = Math.floor((lz - reachKm) / cs), z1 = Math.floor((lz + reachKm) / cs);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      if (!g.shape.intersectsAabbKm(x * cs, y * cs, z * cs, (x + 1) * cs, (y + 1) * cs, (z + 1) * cs)) continue;
      if (!hasChunk(g.field.id, makeChunkKey(g.field.id, { x, y, z }))) return false;
    }
  }
  return true;
}
