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

type FieldState = {
  fieldId: string;
  field: AsteroidFieldDef;
  models: WeightedModelRef[];
  shape: PreparedFieldShape;

  chunkSizeKm: number;
  maxAsteroidsPerChunk: number;

  epoch: number;

  // queue + dedupe
  queue: Array<{ coord: ChunkCoord; key: string; epoch: number }>;
  queuedKeys: Set<string>;
  busy: boolean;
};

const states = new Map<string, FieldState>();

function collectTransferables(chunk: AsteroidChunkData): Transferable[] {
  const t: Transferable[] = [];

  const byModel = chunk.instancesByModel;
  for (const modelId of Object.keys(byModel)) {
    const inst = byModel[modelId];

    // These fields exist in your runtime code (even if repomix truncates typings).
    // We defensively check for presence to avoid crashing on unexpected shapes.
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

function pump(state: FieldState) {
  if (state.busy) return;
  state.busy = true;

  try {
    while (state.queue.length > 0) {
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

      const msg: AsteroidChunkWorkerWorkerToMainMessage = {
        type: "generated",
        fieldId: state.fieldId,
        epoch: state.epoch,
        chunk,
      };

      const transferables = collectTransferables(chunk);
      // Transfer ownership (no copy).
      (self as any).postMessage(msg, transferables);
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
}

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
      return;
    }

    case "generate": {
      const state = states.get(msg.fieldId);
      if (!state) return;

      // Ignore stale requests.
      if (msg.epoch !== state.epoch) return;

      const key = makeChunkKey(msg.fieldId, msg.coord);
      if (state.queuedKeys.has(key)) return;

      state.queue.push({ coord: msg.coord, key, epoch: msg.epoch });
      state.queuedKeys.add(key);

      pump(state);
      return;
    }
  }
};
