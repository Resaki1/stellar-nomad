import type {
  AsteroidChunkData,
  ChunkCoord,
} from "@/sim/asteroids/runtimeTypes";
import type { AsteroidFieldDef, WeightedModelRef } from "@/sim/systemTypes";

export type AsteroidChunkWorkerInitMsg = {
  type: "init";
  fieldId: string;
  field: AsteroidFieldDef;
  models: WeightedModelRef[];
  chunkSizeKm: number;
  maxAsteroidsPerChunk: number;
  epoch: number;
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

export type AsteroidChunkWorkerMainToWorkerMessage =
  | AsteroidChunkWorkerInitMsg
  | AsteroidChunkWorkerGenerateMsg
  | AsteroidChunkWorkerSetEpochMsg;

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
