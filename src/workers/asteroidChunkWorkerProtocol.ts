import type {
  AsteroidChunkData,
} from "@/sim/asteroids/runtimeTypes";
import type { AsteroidFieldDef, WeightedModelRef } from "@/sim/systemTypes";

// ── Main → Worker ───────────────────────────────────────────────────

export type AsteroidChunkWorkerInitMsg = {
  type: "init";
  fieldId: string;
  field: AsteroidFieldDef;
  models: WeightedModelRef[];
  chunkSizeKm: number;
  maxAsteroidsPerChunk: number;
  epoch: number;
};

/**
 * Incremental generation request. Worker APPENDS these to its queue
 * (does not replace). Worker deduplicates via generatedKeys + queuedKeys.
 */
export type AsteroidChunkWorkerGenerateChunksMsg = {
  type: "generateChunks";
  fieldId: string;
  epoch: number;
  items: Array<{ cx: number; cy: number; cz: number }>;
};

/**
 * Tell the worker to forget specific chunk keys so they can be
 * re-generated if the player returns to the area. Sent when the
 * main thread unloads chunks from fieldRuntime.
 */
export type AsteroidChunkWorkerForgetChunksMsg = {
  type: "forgetChunks";
  fieldId: string;
  epoch: number;
  keys: string[];
};

export type AsteroidChunkWorkerSetEpochMsg = {
  type: "setEpoch";
  fieldId: string;
  epoch: number;
};

export type AsteroidChunkWorkerMainToWorkerMessage =
  | AsteroidChunkWorkerInitMsg
  | AsteroidChunkWorkerGenerateChunksMsg
  | AsteroidChunkWorkerForgetChunksMsg
  | AsteroidChunkWorkerSetEpochMsg;

// ── Worker → Main ───────────────────────────────────────────────────

export type AsteroidChunkWorkerGeneratedMsg = {
  type: "generated";
  fieldId: string;
  epoch: number;
  chunk: AsteroidChunkData;
};

export type AsteroidChunkWorkerErrorMsg = {
  type: "error";
  fieldId?: string;
  epoch?: number;
  message: string;
  stack?: string;
};

export type AsteroidChunkWorkerWorkerToMainMessage =
  | AsteroidChunkWorkerGeneratedMsg
  | AsteroidChunkWorkerErrorMsg;
