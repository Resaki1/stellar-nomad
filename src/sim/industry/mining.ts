import type { Difficulty, DiscoveryState, ShipPose, Vec3Tuple } from "@/save/types";
import { headlessChunk, headlessField, headlessFields, resolveHeadlessRock, type FieldGen } from "@/sim/asteroids/headlessChunks";
import { scaleRockYield } from "@/sim/asteroids/mineResolve";
import { computeMiningDurationS, getAsteroidMiningReward } from "@/sim/asteroids/resources";
import type { ChunkCoord } from "@/sim/asteroids/runtimeTypes";
import { SYSTEM_FRAME_ID } from "@/sim/frames";
import { planExtraction, sourceIdOf } from "@/sim/research/discoveries";
import { activeSystem } from "@/sim/systemRegistry";
import { getIndustrySource, INDUSTRY_TUNING as T } from "./catalog";
import { estimateDroneWorkRoute, type DroneRoute } from "./route";
import type { DroneJob, DroneMineFilter, DroneRockId, DroneRockTarget } from "./types";

type Position = Pick<ShipPose, "frameId" | "positionKm">;
const CHUNKS_PER_TICK = 4;
const MAX_SCOUTS = T.maxDepots * T.dronesPerDepot * 2;
const RANGE_SQ = T.extractionRangeKm ** 2;

export interface MiningField {
  id: string;
  name: string;
  classes: { id: string; name: string }[];
  resources: string[];
}

function fieldPosition(g: FieldGen, pose: Position): { anchor: Vec3Tuple; local: Vec3Tuple } | null {
  const { field } = g;
  if (pose.frameId !== (field.anchorBody ?? SYSTEM_FRAME_ID)) return null;
  const anchor = field.anchorBody ? field.anchorOffsetKm : field.anchorKm;
  if (!anchor) return null;
  const [x, y, z] = pose.positionKm;
  const local: Vec3Tuple = [x - anchor[0], y - anchor[1], z - anchor[2]];
  return g.shape.distanceToKm(...local) <= T.extractionRangeKm ? { anchor, local } : null;
}

function miningField(g: FieldGen): MiningField | null {
  const { field } = g;
  const defs = field.resources;
  if (!defs) return null;
  const classes = [...(defs.classes ?? []), ...(defs.pockets ?? []).flatMap(p => p.classes)];
  return {
    id: field.id, name: field.name,
    classes: Array.from(new Map(classes.map(c => [c.id, { id: c.id, name: c.name }])).values()),
    resources: Array.from(new Set(classes.flatMap(c => c.resources.filter(r => r.max > 0).map(r => r.resourceId)))),
  };
}

export function miningFieldsAt(home: Position): MiningField[] {
  return headlessFields().flatMap(g => {
    const field = fieldPosition(g, home) && miningField(g);
    return field ? [field] : [];
  });
}

export function canMineField(home: Position, fieldId: string): boolean {
  const generator = headlessField(fieldId);
  return !!generator?.field.resources && !!fieldPosition(generator, home);
}

export function decodeMineFilter(fieldId: string, value: unknown): DroneMineFilter | null {
  if (!value || typeof value !== "object") return null;
  const { mode, ids } = value as { mode?: unknown; ids?: unknown };
  const gen = headlessField(fieldId);
  const field = gen && miningField(gen);
  if (!field) return null;
  if (mode === "all") return { mode };
  const options = mode === "class" ? field.classes.map(c => c.id) : mode === "resource" ? field.resources : null;
  if (!options || !Array.isArray(ids) || !ids.length || ids.length > options.length ||
      !ids.every(id => typeof id === "string" && options.includes(id)) || new Set(ids).size !== ids.length) return null;
  return { mode: mode as "class" | "resource", ids: [...ids] };
}

/** Keeping the old assignment during an active trip preserves its funded payload and schedule. */
export function finiteMiningJob(job: DroneJob): DroneJob {
  const source = job.kind === "extract" && getIndustrySource(job.targetId);
  return source ? { ...job, kind: "mine", targetId: source.fieldId, priorities: [],
    mineFilter: { mode: "resource", ids: [source.materialId] } } : job;
}

export const droneRockKey = (rock: DroneRockId): string => `${rock.chunkKey}:${rock.instanceId}`;

export interface MiningCandidate {
  rock: DroneRockTarget;
  route: DroneRoute;
  loot: Record<string, number>;
  units: number;
}

interface Scout {
  chunks: ChunkCoord[];
  candidates: MiningCandidate[];
}

function chunkDistanceSq([x, y, z]: Vec3Tuple, { x: i, y: j, z: k }: ChunkCoord, size: number): number {
  // Generated positions are stored in Float32 metres. Expand the bounds enough to
  // keep the nearest-rock proof conservative after decoding that quantization.
  const offset = (n: number, index: number) => Math.max(0, index * size - n - 1e-5, n - (index + 1) * size - 1e-5);
  return offset(x, i) ** 2 + offset(y, j) ** 2 + offset(z, k) ** 2;
}

function nearbyChunks(g: FieldGen, [x, y, z]: Vec3Tuple): ChunkCoord[] {
  const size = g.chunkSizeKm, radius = T.extractionRangeKm;
  const chunks: ChunkCoord[] = [];
  for (let i = Math.floor((x - radius) / size); i <= Math.floor((x + radius) / size); i++) {
    for (let j = Math.floor((y - radius) / size); j <= Math.floor((y + radius) / size); j++) {
      for (let k = Math.floor((z - radius) / size); k <= Math.floor((z + radius) / size); k++) {
        const coord = { x: i, y: j, z: k };
        if (chunkDistanceSq([x, y, z], coord, size) <= RANGE_SQ) chunks.push(coord);
      }
    }
  }
  return chunks;
}

function nearestChunk(chunks: readonly ChunkCoord[], from: Vec3Tuple, size: number): { index: number; distanceSq: number } {
  let index = -1, distanceSq = Infinity;
  for (let i = 0; i < chunks.length; i++) {
    const distance = chunkDistanceSq(from, chunks[i], size);
    if (distance < distanceSq) { index = i; distanceSq = distance; }
  }
  return { index, distanceSq };
}

export function retainedDroneLoot(loot: Record<string, number>, keepResourceIds?: readonly string[]): Record<string, number> {
  return keepResourceIds ? Object.fromEntries(Object.entries(loot).filter(([id]) => keepResourceIds.includes(id))) : loot;
}

/** An ephemeral cache per authority. Cached searches don't regenerate the neighborhood
 * while idle, and all offscreen drones share one small chunk generation budget each second. */
export class DroneMiningSearch {
  private readonly scouts = new Map<string, Scout>();
  private budget = CHUNKS_PER_TICK;
  private cursor = 0;

  clear(): void {
    this.scouts.clear();
    this.cursor = 0;
  }

  beginTick(): void {
    this.budget = CHUNKS_PER_TICK;
  }

  orderScouts<T>(scouts: readonly T[]): T[] {
    if (scouts.length <= 1) return [...scouts];
    const start = this.cursor % scouts.length;
    this.cursor = (start + CHUNKS_PER_TICK) % scouts.length;
    return [...scouts.slice(start), ...scouts.slice(0, start)];
  }

  find(
    home: Position, fieldId: string, filter: DroneMineFilter, difficulty: Difficulty | undefined,
    destroyed: (rock: DroneRockId) => boolean, eligible: (candidate: MiningCandidate) => boolean,
    fromKm: Vec3Tuple = home.positionKm,
  ): { candidate: MiningCandidate | null; searching: boolean } {
    const generator = headlessField(fieldId);
    const origin = generator && fieldPosition(generator, home);
    if (!generator || !origin) return { candidate: null, searching: false };
    const key = JSON.stringify([fieldId, home.positionKm, filter, difficulty]);
    let scout = this.scouts.get(key);
    if (!scout) {
      scout = { chunks: nearbyChunks(generator, origin.local), candidates: [] };
      if (this.scouts.size >= MAX_SCOUTS) this.scouts.delete(this.scouts.keys().next().value!);
    }
    this.scouts.delete(key);
    this.scouts.set(key, scout);
    scout.candidates = scout.candidates.filter(c => !destroyed(c.rock));
    const fromLocal = fromKm.map((n, i) => n - origin.anchor[i]) as Vec3Tuple;
    const best = { candidate: null as MiningCandidate | null, surfaceKm: Infinity };
    const consider = (candidate: MiningCandidate) => {
      const p = candidate.rock.positionKm;
      const centreKm = Math.hypot(fromKm[0] - p[0], fromKm[1] - p[1], fromKm[2] - p[2]);
      const surfaceKm = Math.max(0, centreKm - candidate.rock.radiusM / 1000);
      if (surfaceKm > best.surfaceKm || (surfaceKm === best.surfaceKm && best.candidate &&
          droneRockKey(candidate.rock) >= droneRockKey(best.candidate.rock))) return;
      if (eligible(candidate)) {
        best.candidate = candidate;
        best.surfaceKm = surfaceKm;
      }
    };
    for (const candidate of scout.candidates) consider(candidate);
    let next = nearestChunk(scout.chunks, fromLocal, generator.chunkSizeKm);
    // An unvisited chunk can still contain a closer near-side surface even when
    // its closest possible centre is farther away than the current worksite.
    const largestRadiusKm = Math.max(generator.field.size.maxRadiusM, generator.field.size.minRadiusM) / 1000;
    const unresolved = () => next.index >= 0 && next.distanceSq <= (best.surfaceKm + largestRadiusKm) ** 2;
    if (this.budget > 0 && unresolved()) {
      const [{ x, y, z }] = scout.chunks.splice(next.index, 1);
      this.budget--;
      const chunk = headlessChunk(generator, x, y, z);
      const added: MiningCandidate[] = [];
      for (const model of Object.values(chunk.instancesByModel)) {
        for (let i = 0; i < model.count; i++) {
          const lx = chunk.originKm[0] + model.positionsM[3 * i] / 1000;
          const ly = chunk.originKm[1] + model.positionsM[3 * i + 1] / 1000;
          const lz = chunk.originKm[2] + model.positionsM[3 * i + 2] / 1000;
          if ((lx - origin.local[0]) ** 2 + (ly - origin.local[1]) ** 2 + (lz - origin.local[2]) ** 2 > RANGE_SQ) continue;
          const id = { fieldId, chunkKey: chunk.key, instanceId: model.instanceIds[i] };
          if (destroyed(id)) continue;
          const radiusM = model.radiiM[i];
          const reward = getAsteroidMiningReward(activeSystem(), fieldId, id.instanceId, radiusM, chunk.key);
          if (!reward || (filter.mode === "class" && !filter.ids.includes(reward.asteroidClass.id))) continue;
          const loot = scaleRockYield(reward.resources, 1, difficulty);
          if (filter.mode === "resource" && !filter.ids.some(resource => loot[resource] > 0)) continue;
          const units = Object.values(loot).reduce((sum, n) => sum + n, 0);
          if (!units) continue;
          const rock: DroneRockTarget = { ...id, radiusM, frameId: home.frameId,
            positionKm: [origin.anchor[0] + lx, origin.anchor[1] + ly, origin.anchor[2] + lz],
            workSeconds: Math.ceil(computeMiningDurationS(radiusM) / T.droneMiningSpeedMult) };
          const route = estimateDroneWorkRoute(home, rock);
          if (route) added.push({ rock, route, loot, units });
        }
      }
      scout.candidates.push(...added);
      for (const candidate of added) consider(candidate);
      next = nearestChunk(scout.chunks, fromLocal, generator.chunkSizeKm);
    }
    if (unresolved()) return { candidate: null, searching: true };
    return { candidate: best.candidate, searching: false };
  }
}

export function depleteDroneDiscoveries(discoveries: DiscoveryState, mined: readonly DroneRockId[]): DiscoveryState {
  let next = discoveries;
  for (const rock of mined) {
    const id = sourceIdOf(rock.fieldId, rock.chunkKey, rock.instanceId);
    next = planExtraction(next, id, null, "", 0)?.next ?? next;
  }
  return next;
}

/** Re-derive the full manifest before committing shared depletion, including after a reload. */
export function resolveDroneLoot(
  rock: DroneRockTarget, difficulty: Difficulty | undefined, filter: DroneMineFilter,
): Record<string, number> | null {
  const source = resolveHeadlessRock(rock.fieldId, rock.chunkKey, rock.instanceId);
  if (!source) return null;
  const g = headlessField(rock.fieldId);
  const anchor = g?.field.anchorBody ? g.field.anchorOffsetKm : g?.field.anchorKm;
  if (!anchor || rock.frameId !== (g?.field.anchorBody ?? SYSTEM_FRAME_ID) ||
      Math.abs(source.radiusM - rock.radiusM) > 1e-6 ||
      source.localKm.some((n, i) => Math.abs(n + anchor[i] - rock.positionKm[i]) > 1e-6)) return null;
  const reward = getAsteroidMiningReward(activeSystem(), rock.fieldId, rock.instanceId, source.radiusM, rock.chunkKey);
  if (!reward || (filter.mode === "class" && !filter.ids.includes(reward.asteroidClass.id))) return null;
  const loot = scaleRockYield(reward.resources, 1, difficulty);
  return filter.mode !== "resource" || filter.ids.some(resource => loot[resource] > 0) ? loot : null;
}
