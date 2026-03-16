import type {
  AsteroidChunkData,
  ChunkCoord,
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
  /** Streaming config so the worker can run the full planning loop. */
  streaming: {
    loadRadiusKm: number;
    maxActiveChunks: number;
    drawRadiusKm: number;
  };
};

export type AsteroidChunkWorkerGenerateMsg = {
  type: "generate";
  fieldId: string;
  coord: ChunkCoord;
  epoch: number;
};

export type AsteroidChunkWorkerSetEpochMsg = {
  type: "setEpoch";
  fieldId: string;
  epoch: number;
};

/**
 * Sent every streaming tick from the main thread. Contains the player
 * position in field-local km so the worker can run the full chunk
 * planning computation (triple loop + sort + wanted set + unloads).
 */
export type AsteroidChunkWorkerStreamingTickMsg = {
  type: "streamingTick";
  fieldId: string;
  epoch: number;
  /** Player position in field-local km. */
  px: number;
  py: number;
  pz: number;
};

export type AsteroidChunkWorkerMainToWorkerMessage =
  | AsteroidChunkWorkerInitMsg
  | AsteroidChunkWorkerGenerateMsg
  | AsteroidChunkWorkerSetEpochMsg
  | AsteroidChunkWorkerStreamingTickMsg;

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

/**
 * Result of the worker-side streaming tick. Contains the full planning
 * output so the main thread just applies the results without any heavy
 * computation.
 */
export type AsteroidChunkWorkerStreamingResultMsg = {
  type: "streamingResult";
  fieldId: string;
  epoch: number;
  /** Keys the worker considers wanted (closest N chunks). */
  wantedKeys: string[];
  /** Keys that are beyond draw radius (should be removed from rendering). */
  removeRenderKeys: string[];
  /**
   * Distance per wanted key (same order as wantedKeys).
   * Main thread uses these for LOD tier assignment.
   */
  wantedDists: Float64Array;
};

export type AsteroidChunkWorkerWorkerToMainMessage =
  | AsteroidChunkWorkerGeneratedMsg
  | AsteroidChunkWorkerErrorMsg
  | AsteroidChunkWorkerStreamingResultMsg;
