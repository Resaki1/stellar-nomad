import type {
  AsteroidChunkData,
  AsteroidChunkModelInstances,
} from "./runtimeTypes";

const POW2_20 = 1_048_576; // 2^20
const POW2_32 = 4_294_967_296; // 2^32

const MAX_LOCAL_INDEX = POW2_20 - 1;
const MAX_MODEL_SLOT = 4_095; // 12 bits
const MAX_CHUNK_HANDLE = 2_097_151; // 21 bits

const IS_DEV = process.env.NODE_ENV !== "production";

type PackedInstanceRef = number;

function packInstanceRef(
  chunkHandle: number,
  modelSlot: number,
  localIndex: number
): PackedInstanceRef {
  if (IS_DEV) {
    if (
      !Number.isInteger(chunkHandle) ||
      chunkHandle < 1 ||
      chunkHandle > MAX_CHUNK_HANDLE
    ) {
      throw new Error(
        `[AsteroidRuntime] Invalid chunkHandle=${chunkHandle} (expected 1..${MAX_CHUNK_HANDLE}).`
      );
    }
    if (
      !Number.isInteger(modelSlot) ||
      modelSlot < 0 ||
      modelSlot > MAX_MODEL_SLOT
    ) {
      throw new Error(
        `[AsteroidRuntime] Invalid modelSlot=${modelSlot} (expected 0..${MAX_MODEL_SLOT}).`
      );
    }
    if (
      !Number.isInteger(localIndex) ||
      localIndex < 0 ||
      localIndex > MAX_LOCAL_INDEX
    ) {
      throw new Error(
        `[AsteroidRuntime] Invalid localIndex=${localIndex} (expected 0..${MAX_LOCAL_INDEX}).`
      );
    }
  }

  // 53-bit-safe packing: [chunkHandle:21][modelSlot:12][localIndex:20]
  return chunkHandle * POW2_32 + modelSlot * POW2_20 + localIndex;
}

function unpackInstanceRef(ref: PackedInstanceRef): {
  chunkHandle: number;
  modelSlot: number;
  localIndex: number;
} {
  const chunkHandle = Math.floor(ref / POW2_32);
  const rem = ref - chunkHandle * POW2_32;
  const modelSlot = Math.floor(rem / POW2_20);
  const localIndex = rem - modelSlot * POW2_20;

  return { chunkHandle, modelSlot, localIndex };
}

export type AsteroidInstanceLocation = {
  fieldId: string;
  chunkKey: string;
  modelId: string;
  localIndex: number;
};

export class AsteroidFieldRuntime {
  readonly fieldId: string;

  /**
   * Authoritative set of currently loaded chunks for this field.
   */
  readonly chunks = new Map<string, AsteroidChunkData>();

  /**
   * instanceId (uint32) -> packed location ref into the loaded chunk set.
   */
  private readonly instanceIndex = new Map<number, PackedInstanceRef>();

  private readonly chunkHandleByKey = new Map<string, number>();
  private readonly chunkKeyByHandle: Array<string | undefined> = [];
  private readonly freeChunkHandles: number[] = [];
  private nextChunkHandle = 1;

  private readonly modelSlotById = new Map<string, number>();
  private readonly modelIdBySlot: Array<string | undefined> = [];

  constructor(fieldId: string) {
    this.fieldId = fieldId;
  }

  getChunkCount(): number {
    return this.chunks.size;
  }

  getIndexedInstanceCount(): number {
    return this.instanceIndex.size;
  }

  getChunk(chunkKey: string): AsteroidChunkData | undefined {
    return this.chunks.get(chunkKey);
  }

  hasChunk(chunkKey: string): boolean {
    return this.chunks.has(chunkKey);
  }

  /**
   * Resolve an instanceId to its current location inside the loaded chunk set.
   * Returns null if not currently loaded/known.
   */
  getInstanceLocation(instanceId: number): AsteroidInstanceLocation | null {
    const packed = this.instanceIndex.get(instanceId >>> 0);
    if (packed === undefined) return null;

    const { chunkHandle, modelSlot, localIndex } = unpackInstanceRef(packed);

    const chunkKey = this.chunkKeyByHandle[chunkHandle];
    if (!chunkKey) {
      this.instanceIndex.delete(instanceId >>> 0);
      return null;
    }

    const chunk = this.chunks.get(chunkKey);
    if (!chunk) {
      this.instanceIndex.delete(instanceId >>> 0);
      return null;
    }

    const modelId = this.modelIdBySlot[modelSlot];
    if (!modelId) {
      this.instanceIndex.delete(instanceId >>> 0);
      return null;
    }

    const modelInstances = chunk.instancesByModel[modelId];
    if (!modelInstances || localIndex >= modelInstances.count) {
      this.instanceIndex.delete(instanceId >>> 0);
      return null;
    }

    return { fieldId: this.fieldId, chunkKey, modelId, localIndex };
  }

  /**
   * Remove a single asteroid instance from the runtime and return the updated chunk data if present.
   * Returns null when the instance is not currently loaded.
   */
  removeInstance(instanceId: number): AsteroidChunkData | null {
    const loc = this.getInstanceLocation(instanceId);
    if (!loc) return null;

    const chunk = this.chunks.get(loc.chunkKey);
    if (!chunk) {
      this.instanceIndex.delete(instanceId >>> 0);
      return null;
    }

    const chunkHandle = this.chunkHandleByKey.get(loc.chunkKey);
    const modelSlot = this.modelSlotById.get(loc.modelId);

    if (chunkHandle === undefined || modelSlot === undefined) {
      this.instanceIndex.delete(instanceId >>> 0);
      return null;
    }

    const instances = chunk.instancesByModel[loc.modelId];
    if (!instances || loc.localIndex >= instances.count) {
      this.instanceIndex.delete(instanceId >>> 0);
      return null;
    }

    const removedId = instances.instanceIds[loc.localIndex] >>> 0;
    const lastIndex = instances.count - 1;
    const nextCount = Math.max(0, instances.count - 1);

    // Swap-delete to keep arrays dense, then trim to the new count.
    const positions = instances.positionsM.slice();
    const quaternions = instances.quaternions.slice();
    const radii = instances.radiiM.slice();
    const ids = instances.instanceIds.slice();

    if (loc.localIndex !== lastIndex) {
      const lastPos = lastIndex * 3;
      const dstPos = loc.localIndex * 3;

      positions[dstPos] = positions[lastPos];
      positions[dstPos + 1] = positions[lastPos + 1];
      positions[dstPos + 2] = positions[lastPos + 2];

      const lastQuat = lastIndex * 4;
      const dstQuat = loc.localIndex * 4;

      quaternions[dstQuat] = quaternions[lastQuat];
      quaternions[dstQuat + 1] = quaternions[lastQuat + 1];
      quaternions[dstQuat + 2] = quaternions[lastQuat + 2];
      quaternions[dstQuat + 3] = quaternions[lastQuat + 3];

      radii[loc.localIndex] = radii[lastIndex];

      const movedId = ids[lastIndex] >>> 0;
      ids[loc.localIndex] = movedId;
      this.instanceIndex.set(
        movedId,
        packInstanceRef(chunkHandle, modelSlot, loc.localIndex)
      );
    }

    const trimmedPositions = positions.slice(0, nextCount * 3);
    const trimmedQuaternions = quaternions.slice(0, nextCount * 4);
    const trimmedRadii = radii.slice(0, nextCount);
    const trimmedIds = ids.slice(0, nextCount);

    const updatedInstances: AsteroidChunkModelInstances = {
      ...instances,
      count: nextCount,
      positionsM: trimmedPositions,
      quaternions: trimmedQuaternions,
      radiiM: trimmedRadii,
      instanceIds: trimmedIds,
      maxRadiusM: instances.maxRadiusM,
    };

    const updatedInstancesByModel = {
      ...chunk.instancesByModel,
      [loc.modelId]: updatedInstances,
    };

    const updatedChunk: AsteroidChunkData = {
      ...chunk,
      instancesByModel: updatedInstancesByModel,
      maxRadiusM: this.computeChunkMaxRadius(updatedInstancesByModel),
    };

    this.instanceIndex.delete(removedId);
    this.chunks.set(loc.chunkKey, updatedChunk);

    return updatedChunk;
  }

  /**
   * Add/replace a chunk and (re)build instanceId -> location index entries for it.
   */
  upsertChunk(chunk: AsteroidChunkData): void {
    if (this.chunks.has(chunk.key)) this.removeChunk(chunk.key);

    const chunkHandle = this.allocateChunkHandle(chunk.key);

    this.chunks.set(chunk.key, chunk);
    this.indexChunk(chunk, chunkHandle);
  }

  /**
   * Remove a chunk and its associated instanceId index entries.
   */
  removeChunk(chunkKey: string): void {
    const chunk = this.chunks.get(chunkKey);
    if (!chunk) return;

    const chunkHandle = this.chunkHandleByKey.get(chunkKey);
    if (chunkHandle !== undefined) {
      this.unindexChunk(chunk, chunkHandle);
      this.freeChunkHandle(chunkKey, chunkHandle);
    }

    this.chunks.delete(chunkKey);
  }

  /**
   * Remove all chunks and clear the instance index.
   * Model slot mapping is kept to avoid churn.
   */
  clear(): void {
    if (this.chunks.size === 0 && this.instanceIndex.size === 0) return;

    this.chunks.clear();
    this.instanceIndex.clear();

    this.chunkHandleByKey.clear();
    this.chunkKeyByHandle.length = 0;
    this.freeChunkHandles.length = 0;
    this.nextChunkHandle = 1;
  }

  private allocateChunkHandle(chunkKey: string): number {
    let handle: number;

    if (this.freeChunkHandles.length > 0) {
      handle = this.freeChunkHandles.pop() as number;
    } else {
      handle = this.nextChunkHandle++;
    }

    if (IS_DEV && handle > MAX_CHUNK_HANDLE) {
      throw new Error(
        `[AsteroidRuntime] Too many concurrent chunk handles (handle=${handle}).`
      );
    }

    this.chunkHandleByKey.set(chunkKey, handle);
    this.chunkKeyByHandle[handle] = chunkKey;

    return handle;
  }

  private freeChunkHandle(chunkKey: string, chunkHandle: number): void {
    this.chunkHandleByKey.delete(chunkKey);
    this.chunkKeyByHandle[chunkHandle] = undefined;
    this.freeChunkHandles.push(chunkHandle);
  }

  private getOrCreateModelSlot(modelId: string): number {
    const existing = this.modelSlotById.get(modelId);
    if (existing !== undefined) return existing;

    const slot = this.modelIdBySlot.length;

    if (IS_DEV && slot > MAX_MODEL_SLOT) {
      throw new Error(
        `[AsteroidRuntime] Too many distinct asteroid models for slot packing (slot=${slot}).`
      );
    }

    this.modelSlotById.set(modelId, slot);
    this.modelIdBySlot[slot] = modelId;

    return slot;
  }

  private indexChunk(chunk: AsteroidChunkData, chunkHandle: number): void {
    const instancesByModel = chunk.instancesByModel;

    for (const modelId in instancesByModel) {
      const instances = instancesByModel[modelId];
      const slot = this.getOrCreateModelSlot(modelId);

      const ids = instances.instanceIds;
      const count = instances.count;

      if (IS_DEV && ids.length !== count) {
        throw new Error(
          `[AsteroidRuntime] instanceIds length mismatch for modelId=${modelId} (len=${ids.length}, count=${count}).`
        );
      }

      for (let i = 0; i < count; i++) {
        const id = ids[i] >>> 0;
        const packed = packInstanceRef(chunkHandle, slot, i);

        if (IS_DEV) {
          const prev = this.instanceIndex.get(id);
          if (prev !== undefined && prev !== packed) {
            // eslint-disable-next-line no-console
            console.warn("[AsteroidRuntime] instanceId collision detected", {
              fieldId: this.fieldId,
              instanceId: id,
              prev,
              next: packed,
            });
          }
        }

        this.instanceIndex.set(id, packed);
      }
    }
  }

  private unindexChunk(chunk: AsteroidChunkData, chunkHandle: number): void {
    const instancesByModel = chunk.instancesByModel;

    for (const modelId in instancesByModel) {
      const instances = instancesByModel[modelId];

      const slot = this.modelSlotById.get(modelId);
      if (slot === undefined) continue;

      const ids = instances.instanceIds;
      const count = instances.count;

      for (let i = 0; i < count; i++) {
        const id = ids[i] >>> 0;
        const expected = packInstanceRef(chunkHandle, slot, i);
        const current = this.instanceIndex.get(id);

        if (current === expected) this.instanceIndex.delete(id);
      }
    }
  }

  private computeChunkMaxRadius(
    instancesByModel: Record<string, AsteroidChunkModelInstances>
  ): number {
    let maxRadius = 0;

    for (const modelId in instancesByModel) {
      const inst = instancesByModel[modelId];
      if (inst.count === 0) continue;

      // Scan radii; chunks are small so linear scan is fine here.
      for (let i = 0; i < inst.count; i++) {
        const r = inst.radiiM[i];
        if (r > maxRadius) maxRadius = r;
      }
    }

    return maxRadius;
  }
}

export class AsteroidSystemRuntime {
  private readonly fields = new Map<string, AsteroidFieldRuntime>();

  getOrCreateFieldRuntime(fieldId: string): AsteroidFieldRuntime {
    const existing = this.fields.get(fieldId);
    if (existing) return existing;

    const rt = new AsteroidFieldRuntime(fieldId);
    this.fields.set(fieldId, rt);
    return rt;
  }

  getFieldRuntime(fieldId: string): AsteroidFieldRuntime | undefined {
    return this.fields.get(fieldId);
  }

  removeFieldRuntime(fieldId: string): void {
    const rt = this.fields.get(fieldId);
    if (!rt) return;

    rt.clear();
    this.fields.delete(fieldId);
  }

  clear(): void {
    this.fields.forEach((rt) => rt.clear());
    this.fields.clear();
  }

  /**
   * Convenience: global lookup when caller does not know the field.
   * O(number_of_fields) — use sparingly.
   */
  findInstanceLocation(instanceId: number): AsteroidInstanceLocation | null {
    let found: AsteroidInstanceLocation | null = null;

    this.fields.forEach((rt) => {
      if (found) return;
      const loc = rt.getInstanceLocation(instanceId);
      if (loc) found = loc;
    });

    return found;
  }
}
