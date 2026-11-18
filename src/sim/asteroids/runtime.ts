import type {
  AsteroidChunkData,
  AsteroidChunkModelInstances,
} from "./runtimeTypes";

/** World-state view of destroyed asteroids (sim/world/asteroidDeltas.ts). */
export interface DestroyedAsteroidLookup {
  chunk(fieldId: string, chunkKey: string): ReadonlySet<number>;
  unchunked(fieldId: string): ReadonlySet<number>;
}

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

  /** Filters destroyed instances out of chunks as they load. */
  private readonly destroyed: DestroyedAsteroidLookup | null;

  private readonly chunkHandleByKey = new Map<string, number>();
  private readonly chunkKeyByHandle: Array<string | undefined> = [];
  private readonly freeChunkHandles: number[] = [];
  private nextChunkHandle = 1;

  private readonly modelSlotById = new Map<string, number>();
  private readonly modelIdBySlot: Array<string | undefined> = [];

  /**
   * Listeners notified when a chunk's data changes (instance destroyed, etc.).
   * Used by AsteroidField to keep its GPU slots in sync when an `asteroid.destroyed`
   * world event removes an instance.
   */
  private readonly chunkUpdateListeners = new Set<
    (chunkKey: string, chunk: AsteroidChunkData) => void
  >();

  /** Throttle instanceId collision warnings in dev mode. */
  private collisionCount = 0;

  onChunkUpdate(
    listener: (chunkKey: string, chunk: AsteroidChunkData) => void
  ): () => void {
    this.chunkUpdateListeners.add(listener);
    return () => {
      this.chunkUpdateListeners.delete(listener);
    };
  }

  private notifyChunkUpdate(chunkKey: string, chunk: AsteroidChunkData): void {
    this.chunkUpdateListeners.forEach((fn) => fn(chunkKey, chunk));
  }

  constructor(fieldId: string, destroyed?: DestroyedAsteroidLookup | null) {
    this.fieldId = fieldId;
    this.destroyed = destroyed ?? null;
  }

  getChunkCount(): number {
    return this.chunks.size;
  }

  getIndexedInstanceCount(): number {
    return this.instanceIndex.size;
  }

  /**
   * Remove a destroyed instance from the loaded chunks and notify listeners. Only the
   * `asteroid.destroyed` world-event listener calls this; gameplay submits `asteroid.destroy`.
   */
  destroyInstance(chunkKey: string, instanceId: number): AsteroidChunkData | null {
    const updatedChunk = this.removeInstance(chunkKey, instanceId);
    if (updatedChunk) this.notifyChunkUpdate(updatedChunk.key, updatedChunk);
    return updatedChunk;
  }

  getChunk(chunkKey: string): AsteroidChunkData | undefined {
    return this.chunks.get(chunkKey);
  }

  hasChunk(chunkKey: string): boolean {
    return this.chunks.has(chunkKey);
  }

  /**
   * Instance ids are 32-bit hashes unique per chunk, not per field: MEASURED ~1.7 expected
   * birthday pairs among luna_belt's ~120k loaded rocks. So the index is keyed by chunk + id.
   */
  private indexKey(chunkHandle: number, instanceId: number): number {
    return chunkHandle * POW2_32 + (instanceId >>> 0);
  }

  /** Resolve an instance to its current location in `chunkKey`; null if not loaded. */
  getInstanceLocation(chunkKey: string, instanceId: number): AsteroidInstanceLocation | null {
    const handle = this.chunkHandleByKey.get(chunkKey);
    if (handle === undefined) return null;
    const key = this.indexKey(handle, instanceId);
    const packed = this.instanceIndex.get(key);
    if (packed === undefined) return null;

    const { modelSlot, localIndex } = unpackInstanceRef(packed);
    const chunk = this.chunks.get(chunkKey);
    const modelId = this.modelIdBySlot[modelSlot];
    const modelInstances = chunk && modelId ? chunk.instancesByModel[modelId] : undefined;
    if (!modelInstances || localIndex >= modelInstances.count) {
      this.instanceIndex.delete(key);
      return null;
    }
    return { fieldId: this.fieldId, chunkKey, modelId: modelId as string, localIndex };
  }

  /**
   * Remove a single asteroid instance from the runtime and return the updated chunk data if present.
   * Returns null when the instance is not currently loaded.
   */
  removeInstance(chunkKey: string, instanceId: number): AsteroidChunkData | null {
    const loc = this.getInstanceLocation(chunkKey, instanceId);
    if (!loc) return null;

    const chunk = this.chunks.get(loc.chunkKey);
    const chunkHandle = this.chunkHandleByKey.get(loc.chunkKey);
    const modelSlot = this.modelSlotById.get(loc.modelId);
    if (!chunk || chunkHandle === undefined || modelSlot === undefined) return null;

    const instances = chunk.instancesByModel[loc.modelId];
    if (!instances || loc.localIndex >= instances.count) return null;

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
        this.indexKey(chunkHandle, movedId),
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

    this.instanceIndex.delete(this.indexKey(chunkHandle, removedId));
    this.chunks.set(loc.chunkKey, updatedChunk);

    return updatedChunk;
  }

  /**
   * Add/replace a chunk and (re)build instanceId -> location index entries for it.
   */
  upsertChunk(chunk: AsteroidChunkData): void {
    if (this.chunks.has(chunk.key)) this.removeChunk(chunk.key);

    // Filter destroyed instances so they don't respawn when the worker regenerates a chunk.
    const inChunk = this.destroyed?.chunk(this.fieldId, chunk.key);
    const unchunked = this.destroyed?.unchunked(this.fieldId);
    const filteredChunk =
      inChunk && unchunked && (inChunk.size > 0 || unchunked.size > 0)
        ? this.filterDestroyedFromChunk(chunk, inChunk, unchunked)
        : chunk;

    const chunkHandle = this.allocateChunkHandle(filteredChunk.key);

    this.chunks.set(filteredChunk.key, filteredChunk);
    this.indexChunk(filteredChunk, chunkHandle);
  }

  private filterDestroyedFromChunk(
    chunk: AsteroidChunkData,
    inChunk: ReadonlySet<number>,
    unchunked: ReadonlySet<number>,
  ): AsteroidChunkData {

    let changed = false;
    const nextInstancesByModel: Record<string, AsteroidChunkModelInstances> = {
      ...chunk.instancesByModel,
    };

    for (const modelId in chunk.instancesByModel) {
      const inst = chunk.instancesByModel[modelId];
      const ids = inst.instanceIds;
      const count = inst.count;

      if (count === 0) continue;

      // Quick scan: if nothing in this model is destroyed, keep as-is.
      let anyRemoved = false;
      for (let i = 0; i < count; i++) {
        const id = ids[i] >>> 0;
        if (inChunk.has(id) || unchunked.has(id)) {
          anyRemoved = true;
          break;
        }
      }
      if (!anyRemoved) continue;

      changed = true;

      // Count kept instances.
      let keepCount = 0;
      for (let i = 0; i < count; i++) {
        const id = ids[i] >>> 0;
        if (!inChunk.has(id) && !unchunked.has(id)) keepCount++;
      }

      if (keepCount === 0) {
        nextInstancesByModel[modelId] = {
          ...inst,
          count: 0,
          positionsM: new Float32Array(0),
          quaternions: new Float32Array(0),
          radiiM: new Float32Array(0),
          instanceIds: new Uint32Array(0),
          maxRadiusM: 0,
        };
        continue;
      }

      const nextPositions = new Float32Array(keepCount * 3);
      const nextQuats = new Float32Array(keepCount * 4);
      const nextRadii = new Float32Array(keepCount);
      const nextIds = new Uint32Array(keepCount);

      let write = 0;
      let maxR = 0;

      for (let i = 0; i < count; i++) {
        const id = ids[i] >>> 0;
        if (inChunk.has(id) || unchunked.has(id)) continue;

        const srcPos = i * 3;
        const dstPos = write * 3;
        nextPositions[dstPos] = inst.positionsM[srcPos];
        nextPositions[dstPos + 1] = inst.positionsM[srcPos + 1];
        nextPositions[dstPos + 2] = inst.positionsM[srcPos + 2];

        const srcQuat = i * 4;
        const dstQuat = write * 4;
        nextQuats[dstQuat] = inst.quaternions[srcQuat];
        nextQuats[dstQuat + 1] = inst.quaternions[srcQuat + 1];
        nextQuats[dstQuat + 2] = inst.quaternions[srcQuat + 2];
        nextQuats[dstQuat + 3] = inst.quaternions[srcQuat + 3];

        const r = inst.radiiM[i];
        nextRadii[write] = r;
        if (r > maxR) maxR = r;

        nextIds[write] = id;

        write++;
      }

      nextInstancesByModel[modelId] = {
        ...inst,
        count: keepCount,
        positionsM: nextPositions,
        quaternions: nextQuats,
        radiiM: nextRadii,
        instanceIds: nextIds,
        maxRadiusM: maxR,
      };
    }

    if (!changed) return chunk;

    return {
      ...chunk,
      instancesByModel: nextInstancesByModel,
      maxRadiusM: this.computeChunkMaxRadius(nextInstancesByModel),
    };
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
        const key = this.indexKey(chunkHandle, id);
        const packed = packInstanceRef(chunkHandle, slot, i);

        if (IS_DEV) {
          const prev = this.instanceIndex.get(key);
          if (prev !== undefined && prev !== packed) {
            this.collisionCount++;
            if (this.collisionCount <= 5) {
               
              console.warn("[AsteroidRuntime] instanceId collision within one chunk", {
                fieldId: this.fieldId,
                instanceId: id,
                prev,
                next: packed,
                totalCollisions: this.collisionCount,
              });
            } else if (this.collisionCount === 6) {
               
              console.warn("[AsteroidRuntime] Suppressing further collision warnings.");
            }
          }
        }

        this.instanceIndex.set(key, packed);
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
        const key = this.indexKey(chunkHandle, ids[i] >>> 0);
        const expected = packInstanceRef(chunkHandle, slot, i);
        if (this.instanceIndex.get(key) === expected) this.instanceIndex.delete(key);
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
  readonly destroyed: DestroyedAsteroidLookup | null;

  // Debug ID to verify instance identity
  readonly instanceId = Math.random().toString(36).slice(2, 8);

  constructor(destroyed?: DestroyedAsteroidLookup | null) {
    this.destroyed = destroyed ?? null;
  }

  getOrCreateFieldRuntime(fieldId: string): AsteroidFieldRuntime {
    const existing = this.fields.get(fieldId);
    if (existing) {
      return existing;
    }

    const rt = new AsteroidFieldRuntime(fieldId, this.destroyed);
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
   * Iterate over all field runtimes. Use for operations that need to scan all fields.
   */
  forEachField(callback: (fieldRuntime: AsteroidFieldRuntime, fieldId: string) => void): void {
    this.fields.forEach((rt, id) => callback(rt, id));
  }

  /**
   * Get all field IDs currently registered.
   */
  getFieldIds(): string[] {
    return Array.from(this.fields.keys());
  }

  /**
   * Get the number of registered fields.
   */
  getFieldCount(): number {
    return this.fields.size;
  }
}
