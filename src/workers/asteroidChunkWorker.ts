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
 * loop via setTimeout(0). Spreads postMessage delivery across frames.
 */
const CHUNKS_PER_YIELD = 16;

type FieldState = {
  fieldId: string;
  field: AsteroidFieldDef;
  models: WeightedModelRef[];
  shape: PreparedFieldShape;

  chunkSizeKm: number;
  maxAsteroidsPerChunk: number;

  epoch: number;

  // Generation queue + dedupe
  queue: Array<{ coord: ChunkCoord; key: string; epoch: number }>;
  queuedKeys: Set<string>;
  busy: boolean;

  // Chunks generated and posted back this epoch.
  // Prevents re-generation when the main thread re-requests.
  generatedKeys: Set<string>;
};

const states = new Map<string, FieldState>();

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
 * via setTimeout(0). This lets new messages (generateChunks, forgetChunks)
 * be processed between batches.
 */
function pump(state: FieldState) {
  if (state.busy) return;
  state.busy = true;

  let processed = 0;

  try {
    while (state.queue.length > 0 && processed < CHUNKS_PER_YIELD) {
      const job = state.queue.shift()!;
      state.queuedKeys.delete(job.key);

      // Drop stale work.
      if (job.epoch !== state.epoch) continue;

      // Skip if already generated this epoch (dedup).
      if (state.generatedKeys.has(job.key)) continue;

      const chunk = generateAsteroidChunk({
        field: state.field,
        fieldId: state.fieldId,
        models: state.models,
        shape: state.shape,
        coord: job.coord,
        chunkSizeKm: state.chunkSizeKm,
        maxAsteroidsPerChunk: state.maxAsteroidsPerChunk,
      });

      state.generatedKeys.add(job.key);

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

  if (state.queue.length > 0) {
    setTimeout(() => pump(state), 0);
  }
}

// ─── Message handler ────────────────────────────────────────────────

self.onmessage = (ev: MessageEvent<AsteroidChunkWorkerMainToWorkerMessage>) => {
  const msg = ev.data;

  switch (msg.type) {
    case "init": {
      const shape = prepareFieldShape(msg.field.shape);

      const state: FieldState = {
        fieldId: msg.fieldId,
        field: msg.field,
        models: msg.models,
        shape,
        chunkSizeKm: msg.chunkSizeKm,
        maxAsteroidsPerChunk: msg.maxAsteroidsPerChunk,
        epoch: msg.epoch,

        queue: [],
        queuedKeys: new Set<string>(),
        busy: false,
        generatedKeys: new Set<string>(),
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

    case "generateChunks": {
      const state = states.get(msg.fieldId);
      if (!state) return;
      if (msg.epoch !== state.epoch) return;

      // APPEND to queue. Skip already-generated or already-queued keys.
      for (let i = 0; i < msg.items.length; i++) {
        const item = msg.items[i];
        const coord: ChunkCoord = { x: item.cx, y: item.cy, z: item.cz };
        const key = makeChunkKey(msg.fieldId, coord);

        if (state.generatedKeys.has(key)) continue;
        if (state.queuedKeys.has(key)) continue;

        state.queue.push({ coord, key, epoch: msg.epoch });
        state.queuedKeys.add(key);
      }

      pump(state);
      return;
    }

    case "forgetChunks": {
      const state = states.get(msg.fieldId);
      if (!state) return;
      if (msg.epoch !== state.epoch) return;

      for (let i = 0; i < msg.keys.length; i++) {
        state.generatedKeys.delete(msg.keys[i]);
      }
      return;
    }
  }
};
