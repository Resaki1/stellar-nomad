import * as THREE from "three";
import random from "@/helpers/random";
import type { AsteroidFieldDef, WeightedModelRef } from "@/sim/systemTypes";
import { sampleRadiusM } from "@/sim/asteroids/distributions";
import type { PreparedFieldShape } from "@/sim/asteroids/shapes";
import { hashChunkSeed, hashInstanceId } from "@/sim/asteroids/seeding";
import type {
  AsteroidChunkData,
  AsteroidChunkModelInstances,
  ChunkCoord,
} from "@/sim/asteroids/runtimeTypes";
import { makeChunkKey } from "@/sim/asteroids/runtimeTypes";

const TWO_PI = Math.PI * 2;

type GenerateChunkArgs = {
  field: AsteroidFieldDef;
  fieldId: string;
  models: WeightedModelRef[];
  shape: PreparedFieldShape;
  coord: ChunkCoord;
  chunkSizeKm: number;
  maxAsteroidsPerChunk: number;
};

function pickWeightedModelId(
  rng: { nextFloat: () => number },
  models: WeightedModelRef[]
): string {
  if (models.length === 0) return "asteroid_01";
  if (models.length === 1) return models[0].modelId;

  let total = 0;
  for (let i = 0; i < models.length; i++) {
    const w = models[i].weight;
    if (w > 0) total += w;
  }
  if (total <= 0) return models[0].modelId;

  let r = rng.nextFloat() * total;
  for (let i = 0; i < models.length; i++) {
    const w = models[i].weight;
    if (w <= 0) continue;
    r -= w;
    if (r <= 0) return models[i].modelId;
  }
  return models[models.length - 1].modelId;
}

function estimateChunkCount(
  field: AsteroidFieldDef,
  chunkSizeKm: number
): number {
  // Phase 1: rough estimates used only when population.mode === "count".
  // If you want more accurate “count across the entire field,” we can compute
  // actual volume and chunk coverage per shape type.
  if (field.shape.type === "sphere") {
    const r = field.shape.radiusKm;
    const vol = (4 / 3) * Math.PI * r * r * r;
    return Math.max(
      1,
      Math.floor(vol / (chunkSizeKm * chunkSizeKm * chunkSizeKm))
    );
  }
  // box
  const [hx, hy, hz] = field.shape.halfExtentsKm;
  const vol = hx * 2 * (hy * 2) * (hz * 2);
  return Math.max(
    1,
    Math.floor(vol / (chunkSizeKm * chunkSizeKm * chunkSizeKm))
  );
}

function getTargetCount(
  rng: { nextFloat: () => number },
  field: AsteroidFieldDef,
  chunkSizeKm: number,
  maxAsteroidsPerChunk: number
): number {
  const volumeKm3 = chunkSizeKm * chunkSizeKm * chunkSizeKm;

  let count = 0;

  if (field.population.mode === "density") {
    const density = Math.max(0, field.population.densityPerKm3);
    const expected = density * volumeKm3;

    const jitter = Math.min(Math.max(field.population.jitter ?? 0, 0), 1);
    const jitterFactor =
      jitter > 0 ? 1 + (rng.nextFloat() * 2 - 1) * jitter : 1;

    // floor(expected * jitter + a little randomness) gives stable-ish counts without Poisson cost.
    count = Math.floor(expected * jitterFactor + rng.nextFloat());
  } else {
    // Phase 1 interpretation: approxCount means per chunk
    // (If you prefer "approxCount across the entire field", flip to:
    // approxCount / estimatedChunkCount and then jitter around that.)
    const approx = Math.max(0, field.population.approxCount);

    // If you *did* mean global count, this is the safer near-term compromise:
    // spread it approximately across chunks.
    const estimatedChunks = estimateChunkCount(field, chunkSizeKm);
    const perChunk = approx / estimatedChunks;

    count = Math.floor(perChunk + rng.nextFloat());
  }

  if (count < 0) count = 0;
  if (count > maxAsteroidsPerChunk) count = maxAsteroidsPerChunk;

  return count;
}

export function generateAsteroidChunk(
  args: GenerateChunkArgs
): AsteroidChunkData {
  const {
    field,
    fieldId,
    models,
    shape,
    coord,
    chunkSizeKm,
    maxAsteroidsPerChunk,
  } = args;

  const key = makeChunkKey(fieldId, coord);

  const originKmX = coord.x * chunkSizeKm;
  const originKmY = coord.y * chunkSizeKm;
  const originKmZ = coord.z * chunkSizeKm;

  const aabbMinKm: [number, number, number] = [originKmX, originKmY, originKmZ];
  const aabbMaxKm: [number, number, number] = [
    originKmX + chunkSizeKm,
    originKmY + chunkSizeKm,
    originKmZ + chunkSizeKm,
  ];

  const chunkSeed = hashChunkSeed(field.seed, coord.x, coord.y, coord.z);
  const rng = random(chunkSeed);

  const targetCount = getTargetCount(
    rng,
    field,
    chunkSizeKm,
    maxAsteroidsPerChunk
  );

  // Temporary buckets (JS arrays) so we can reject samples that fall outside the shape.
  const buckets: Record<
    string,
    {
      pos: number[];
      quat: number[];
      rad: number[];
      ids: number[];
      maxR: number;
    }
  > = {};

  const euler = new THREE.Euler();
  const quat = new THREE.Quaternion();

  let generated = 0;
  let attempts = 0;
  const maxAttempts = Math.max(16, targetCount * 10);

  while (generated < targetCount && attempts < maxAttempts) {
    attempts++;

    const lxKm = rng.nextFloat() * chunkSizeKm;
    const lyKm = rng.nextFloat() * chunkSizeKm;
    const lzKm = rng.nextFloat() * chunkSizeKm;

    const fxKm = originKmX + lxKm;
    const fyKm = originKmY + lyKm;
    const fzKm = originKmZ + lzKm;

    if (!shape.isInsideKm(fxKm, fyKm, fzKm)) continue;

    const radiusM = sampleRadiusM(rng, field.size);
    const modelId = pickWeightedModelId(rng, models);

    const bucket =
      buckets[modelId] ??
      (buckets[modelId] = { pos: [], quat: [], rad: [], ids: [], maxR: 0 });

    // Store local-to-chunk positions in meters
    bucket.pos.push(lxKm * 1000, lyKm * 1000, lzKm * 1000);

    // Random rotation
    euler.set(
      rng.nextFloat() * TWO_PI,
      rng.nextFloat() * TWO_PI,
      rng.nextFloat() * TWO_PI
    );
    quat.setFromEuler(euler);
    bucket.quat.push(quat.x, quat.y, quat.z, quat.w);

    bucket.rad.push(radiusM);
    bucket.ids.push(hashInstanceId(chunkSeed, generated));

    if (radiusM > bucket.maxR) bucket.maxR = radiusM;

    generated++;
  }

  const instancesByModel: Record<string, AsteroidChunkModelInstances> = {};
  let chunkMaxRadiusM = 0;

  for (const modelId of Object.keys(buckets)) {
    const b = buckets[modelId];
    const count = Math.floor(b.pos.length / 3);

    const positionsM = new Float32Array(b.pos);
    const quaternions = new Float32Array(b.quat);
    const radiiM = new Float32Array(b.rad);
    const instanceIds = new Uint32Array(b.ids);

    if (b.maxR > chunkMaxRadiusM) chunkMaxRadiusM = b.maxR;

    instancesByModel[modelId] = {
      modelId,
      count,
      positionsM,
      quaternions,
      radiiM,
      instanceIds,
      maxRadiusM: b.maxR,
    };
  }

  return {
    key,
    fieldId,
    coord,
    originKm: [originKmX, originKmY, originKmZ],
    aabbMinKm,
    aabbMaxKm,
    instancesByModel,
    maxRadiusM: chunkMaxRadiusM,
  };
}
