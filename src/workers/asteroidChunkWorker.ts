/// <reference lib="webworker" />

import type { AsteroidFieldDef, WeightedModelRef } from "@/sim/systemTypes";
import type { PreparedFieldShape } from "@/sim/asteroids/shapes";
import { prepareFieldShape } from "@/sim/asteroids/shapes";
import type {
  AsteroidChunkData,
  ChunkCoord,
} from "@/sim/asteroids/runtimeTypes";
import { makeChunkKey } from "@/sim/asteroids/runtimeTypes";
import { generateAsteroidChunk } from "@/sim/asteroids/generation";

import type {
  AsteroidChunkWorkerMainToWorkerMessage,
  AsteroidChunkWorkerWorkerToMainMessage,
} from "./asteroidChunkWorkerProtocol";

/**
 * Max chunks generated per microtask before yielding back to the event
 * loop. This spreads postMessage delivery across frames so the main
 * thread doesn't receive 32+ chunk messages in a single microtask batch.
 */
const CHUNKS_PER_YIELD = 16;

/** Max new chunk generations queued per streaming tick. */
const MAX_NEW_CHUNKS_PER_TICK = 128;

/**
 * Look-ahead time in seconds. Chunk generation is prioritised by
 * distance to the predicted player position (pos + vel × lookAhead),
 * so chunks in the direction of travel are generated before the player
 * reaches them. The offset is capped at half the effective load radius.
 */
const GENERATION_LOOK_AHEAD_S = 2.0;

type FieldState = {
  fieldId: string;
  field: AsteroidFieldDef;
  models: WeightedModelRef[];
  shape: PreparedFieldShape;

  chunkSizeKm: number;
  maxAsteroidsPerChunk: number;

  epoch: number;

  // Streaming config (set at init)
  loadRadiusKm: number;
  maxActiveChunks: number;
  drawRadiusKm: number;
  effectiveLoadRadiusKm: number;

  // Track which chunks have been generated (keys we've sent to main thread).
  generatedKeys: Set<string>;

  // queue + dedupe
  queue: Array<{ coord: ChunkCoord; key: string; epoch: number }>;
  queuedKeys: Set<string>;
  busy: boolean;
};

const states = new Map<string, FieldState>();

// ─── Pre-allocated candidate buffers (reused across streaming ticks) ──
const _MAX_CANDIDATES = 32768;
let _candCx = new Int32Array(_MAX_CANDIDATES);
let _candCy = new Int32Array(_MAX_CANDIDATES);
let _candCz = new Int32Array(_MAX_CANDIDATES);
let _candDist = new Float64Array(_MAX_CANDIDATES);
let _candIndices = new Uint32Array(_MAX_CANDIDATES);

function ensureCandidateBuffers(size: number): void {
  if (size <= _candCx.length) return;
  const newSize = Math.max(size, _candCx.length * 2);
  _candCx = new Int32Array(newSize);
  _candCy = new Int32Array(newSize);
  _candCz = new Int32Array(newSize);
  _candDist = new Float64Array(newSize);
  _candIndices = new Uint32Array(newSize);
}

// ─── Pre-allocated generation candidate buffers (sorted by predicted dist) ──
const _GEN_INIT = 4096;
let _genSrcIdx = new Uint32Array(_GEN_INIT);
let _genPredDist = new Float64Array(_GEN_INIT);
let _genSortIdx = new Uint32Array(_GEN_INIT);

function ensureGenBuffers(size: number): void {
  if (size <= _genSrcIdx.length) return;
  const newSize = Math.max(size, _genSrcIdx.length * 2);
  _genSrcIdx = new Uint32Array(newSize);
  _genPredDist = new Float64Array(newSize);
  _genSortIdx = new Uint32Array(newSize);
}

// ─── Helpers ────────────────────────────────────────────────────────

function computeChunkRange(
  pKm: number,
  radiusKm: number,
  chunkSizeKm: number
): [number, number] {
  return [
    Math.floor((pKm - radiusKm) / chunkSizeKm),
    Math.floor((pKm + radiusKm) / chunkSizeKm),
  ];
}

function computeEffectiveLoadRadius(
  loadRadiusKm: number,
  chunkSizeKm: number,
  maxActiveChunks: number
): number {
  const chunkVol = chunkSizeKm * chunkSizeKm * chunkSizeKm;
  const sphereRadius = Math.pow(
    (maxActiveChunks * chunkVol * 3) / (4 * Math.PI),
    1 / 3
  );
  return Math.min(loadRadiusKm, sphereRadius + chunkSizeKm);
}

/** Inlined point-to-AABB distance in km. */
function chunkDistKm(
  px: number, py: number, pz: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): number {
  let dx = 0;
  if (px < minX) dx = minX - px;
  else if (px > maxX) dx = px - maxX;
  let dy = 0;
  if (py < minY) dy = minY - py;
  else if (py > maxY) dy = py - maxY;
  let dz = 0;
  if (pz < minZ) dz = minZ - pz;
  else if (pz > maxZ) dz = pz - maxZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ─── Chunk generation ───────────────────────────────────────────────

function collectTransferables(chunk: AsteroidChunkData): Transferable[] {
  const t: Transferable[] = [];

  const byModel = chunk.instancesByModel;
  for (const modelId of Object.keys(byModel)) {
    const inst = byModel[modelId];

    const positionsM = (inst as any).positionsM as Float32Array | undefined;
    const quaternions = (inst as any).quaternions as Float32Array | undefined;
    const radiiM = (inst as any).radiiM as Float32Array | undefined;
    const instanceIds = (inst as any).instanceIds as Uint32Array | undefined;

    if (positionsM?.buffer) t.push(positionsM.buffer);
    if (quaternions?.buffer) t.push(quaternions.buffer);
    if (radiiM?.buffer) t.push(radiiM.buffer);
    if (instanceIds?.buffer) t.push(instanceIds.buffer);
  }

  return t;
}

/**
 * Process up to CHUNKS_PER_YIELD chunks, then yield to the event loop
 * via setTimeout(0). This prevents the worker from blocking its own
 * message handling and spreads postMessage delivery so the main thread
 * receives chunks across multiple frames instead of all at once.
 */
function pump(state: FieldState) {
  if (state.busy) return;
  state.busy = true;

  let processed = 0;

  try {
    while (state.queue.length > 0 && processed < CHUNKS_PER_YIELD) {
      const job = state.queue.shift()!;
      state.queuedKeys.delete(job.key);

      // Drop stale work (epoch mismatch).
      if (job.epoch !== state.epoch) {
        continue;
      }

      const chunk = generateAsteroidChunk({
        field: state.field,
        fieldId: state.fieldId,
        models: state.models,
        shape: state.shape,
        coord: job.coord,
        chunkSizeKm: state.chunkSizeKm,
        maxAsteroidsPerChunk: state.maxAsteroidsPerChunk,
      });

      // Track that this chunk has been generated.
      state.generatedKeys.add(chunk.key);

      const msg: AsteroidChunkWorkerWorkerToMainMessage = {
        type: "generated",
        fieldId: state.fieldId,
        epoch: state.epoch,
        chunk,
      };

      const transferables = collectTransferables(chunk);
      (self as any).postMessage(msg, transferables);
      processed++;
    }
  } catch (e) {
    const err = e as Error;
    const msg: AsteroidChunkWorkerWorkerToMainMessage = {
      type: "error",
      message: err?.message ?? String(e),
      stack: err?.stack,
    };
    (self as any).postMessage(msg);
  } finally {
    state.busy = false;
  }

  // If there's more work, yield to the event loop then continue.
  if (state.queue.length > 0) {
    setTimeout(() => pump(state), 0);
  }
}

// ─── Streaming tick (full planning computation) ─────────────────────

function handleStreamingTick(
  state: FieldState,
  px: number,
  py: number,
  pz: number,
  vx: number,
  vy: number,
  vz: number,
  epoch: number,
): void {
  const { chunkSizeKm, shape, maxActiveChunks, drawRadiusKm } = state;
  const loadR = state.effectiveLoadRadiusKm;

  // 1. Triple loop: find candidate chunks within effective load radius.
  const [minCx, maxCx] = computeChunkRange(px, loadR, chunkSizeKm);
  const [minCy, maxCy] = computeChunkRange(py, loadR, chunkSizeKm);
  const [minCz, maxCz] = computeChunkRange(pz, loadR, chunkSizeKm);

  let candidateCount = 0;

  for (let cx = minCx; cx <= maxCx; cx++) {
    const cMinX = cx * chunkSizeKm;
    const cMaxX = cMinX + chunkSizeKm;

    for (let cy = minCy; cy <= maxCy; cy++) {
      const cMinY = cy * chunkSizeKm;
      const cMaxY = cMinY + chunkSizeKm;

      for (let cz = minCz; cz <= maxCz; cz++) {
        const cMinZ = cz * chunkSizeKm;
        const cMaxZ = cMinZ + chunkSizeKm;

        if (!shape.intersectsAabbKm(cMinX, cMinY, cMinZ, cMaxX, cMaxY, cMaxZ)) continue;

        const dist = chunkDistKm(px, py, pz, cMinX, cMinY, cMinZ, cMaxX, cMaxY, cMaxZ);
        if (dist > loadR) continue;

        ensureCandidateBuffers(candidateCount + 1);

        _candCx[candidateCount] = cx;
        _candCy[candidateCount] = cy;
        _candCz[candidateCount] = cz;
        _candDist[candidateCount] = dist;
        candidateCount++;
      }
    }
  }

  // 2. Sort by distance using index array.
  if (candidateCount > _candIndices.length) {
    _candIndices = new Uint32Array(candidateCount);
  }
  for (let i = 0; i < candidateCount; i++) _candIndices[i] = i;
  const indicesView = _candIndices.subarray(0, candidateCount);
  indicesView.sort((a, b) => _candDist[a] - _candDist[b]);

  const capped = Math.min(candidateCount, maxActiveChunks);

  // 3. Predicted position for generation ordering (velocity look-ahead).
  //    Chunks closest to where the player is HEADING get generated first,
  //    so they're ready well before the player reaches them. The offset is
  //    capped at half the load radius to maintain rearward coverage.
  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
  const lookAheadKm = Math.min(speed * GENERATION_LOOK_AHEAD_S, loadR * 0.5);
  let predX = px, predY = py, predZ = pz;
  if (speed > 0.001) {
    const scale = lookAheadKm / speed;
    predX += vx * scale;
    predY += vy * scale;
    predZ += vz * scale;
  }

  // 4. Build wanted set + collect generation candidates.
  const wantedKeys: string[] = [];
  const wantedDists = new Float64Array(capped);
  const removeRenderKeys: string[] = [];
  let genCount = 0;

  for (let i = 0; i < capped; i++) {
    const idx = indicesView[i];
    const cx = _candCx[idx];
    const cy = _candCy[idx];
    const cz = _candCz[idx];
    const key = `${state.fieldId}:${cx},${cy},${cz}`;

    wantedKeys.push(key);
    wantedDists[i] = _candDist[idx];

    // Check if beyond draw radius → mark for render removal.
    if (_candDist[idx] > drawRadiusKm) {
      removeRenderKeys.push(key);
    }

    // Collect generation candidates (not yet generated or queued).
    if (state.generatedKeys.has(key)) continue;
    if (state.queuedKeys.has(key)) continue;

    const cMinX = cx * chunkSizeKm;
    const cMinY = cy * chunkSizeKm;
    const cMinZ = cz * chunkSizeKm;
    ensureGenBuffers(genCount + 1);
    _genSrcIdx[genCount] = i;
    _genPredDist[genCount] = chunkDistKm(
      predX, predY, predZ,
      cMinX, cMinY, cMinZ,
      cMinX + chunkSizeKm, cMinY + chunkSizeKm, cMinZ + chunkSizeKm,
    );
    genCount++;
  }

  // 5. Sort generation candidates by predicted distance (closest to where
  //    the player is heading get generated first → reduces pop-in).
  if (genCount > _genSortIdx.length) {
    _genSortIdx = new Uint32Array(genCount);
  }
  for (let i = 0; i < genCount; i++) _genSortIdx[i] = i;
  const genView = _genSortIdx.subarray(0, genCount);
  genView.sort((a, b) => _genPredDist[a] - _genPredDist[b]);

  // 6. Queue generation in predicted-distance order.
  let requestedThisTick = 0;
  for (let g = 0; g < genCount && requestedThisTick < MAX_NEW_CHUNKS_PER_TICK; g++) {
    const gi = genView[g];
    const i = _genSrcIdx[gi];
    const origIdx = indicesView[i];
    const cx = _candCx[origIdx];
    const cy = _candCy[origIdx];
    const cz = _candCz[origIdx];
    const key = wantedKeys[i];
    const coord: ChunkCoord = { x: cx, y: cy, z: cz };
    state.queue.push({ coord, key, epoch });
    state.queuedKeys.add(key);
    requestedThisTick++;
  }

  // 7. Prune generatedKeys to the wanted set. Chunks that are no longer
  // wanted get "forgotten" so they can be re-generated if needed. This
  // keeps the worker in sync with the main thread (which also prunes its
  // runtime to wanted+rendered chunks).
  const wantedSet = new Set(wantedKeys);
  state.generatedKeys.forEach((key) => {
    if (!wantedSet.has(key)) {
      state.generatedKeys.delete(key);
    }
  });

  // Also drop queued generation jobs for chunks no longer wanted.
  if (state.queue.length > 0) {
    state.queue = state.queue.filter((job) => wantedSet.has(job.key));
    state.queuedKeys.clear();
    for (const job of state.queue) state.queuedKeys.add(job.key);
  }

  // 8. Send result back to main thread.
  const msg: AsteroidChunkWorkerWorkerToMainMessage = {
    type: "streamingResult",
    fieldId: state.fieldId,
    epoch,
    wantedKeys,
    removeRenderKeys,
    wantedDists,
  };

  (self as any).postMessage(msg, [wantedDists.buffer]);

  // 9. Kick the generation pump if we queued new work.
  if (requestedThisTick > 0) {
    pump(state);
  }
}

// ─── Message handler ────────────────────────────────────────────────

self.onmessage = (ev: MessageEvent<AsteroidChunkWorkerMainToWorkerMessage>) => {
  const msg = ev.data;

  switch (msg.type) {
    case "init": {
      const shape = prepareFieldShape(msg.field.shape);

      const effectiveLoadRadiusKm = computeEffectiveLoadRadius(
        msg.streaming.loadRadiusKm,
        msg.chunkSizeKm,
        msg.streaming.maxActiveChunks,
      );

      const state: FieldState = {
        fieldId: msg.fieldId,
        field: msg.field,
        models: msg.models,
        shape,
        chunkSizeKm: msg.chunkSizeKm,
        maxAsteroidsPerChunk: msg.maxAsteroidsPerChunk,
        epoch: msg.epoch,

        loadRadiusKm: msg.streaming.loadRadiusKm,
        maxActiveChunks: msg.streaming.maxActiveChunks,
        drawRadiusKm: msg.streaming.drawRadiusKm,
        effectiveLoadRadiusKm,

        generatedKeys: new Set<string>(),

        queue: [],
        queuedKeys: new Set<string>(),
        busy: false,
      };

      states.set(msg.fieldId, state);
      return;
    }

    case "setEpoch": {
      const state = states.get(msg.fieldId);
      if (!state) return;

      state.epoch = msg.epoch;
      state.queue.length = 0;
      state.queuedKeys.clear();
      state.generatedKeys.clear();
      return;
    }

    case "generate": {
      const state = states.get(msg.fieldId);
      if (!state) return;

      if (msg.epoch !== state.epoch) return;

      const key = makeChunkKey(msg.fieldId, msg.coord);
      if (state.queuedKeys.has(key)) return;

      state.queue.push({ coord: msg.coord, key, epoch: msg.epoch });
      state.queuedKeys.add(key);

      pump(state);
      return;
    }

    case "streamingTick": {
      const state = states.get(msg.fieldId);
      if (!state) return;

      if (msg.epoch !== state.epoch) return;

      handleStreamingTick(state, msg.px, msg.py, msg.pz, msg.vx, msg.vy, msg.vz, msg.epoch);
      return;
    }
  }
};
