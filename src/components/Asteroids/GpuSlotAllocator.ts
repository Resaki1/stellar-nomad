import { StorageBufferAttribute } from "three/webgpu";

/**
 * Max instances per model type in the GPU allocator. Both near and far
 * tier compute shaders read from the same allocator buffer.
 */
export const MAX_INSTANCES_PER_MODEL = 4096 * 128; // 524288
import type { AsteroidChunkModelInstances } from "@/sim/asteroids/runtimeTypes";

/**
 * Floats per slot: vec4(pos.xyz, radius) + vec4(quat.xyzw) = 8 floats.
 * Stored as 2 x vec4 in the storage buffer.
 */
const FLOATS_PER_SLOT = 8;

/**
 * Manages GPU storage buffer slots for one asteroid model type.
 *
 * Writes instance data (pos, quat, radius) directly into the
 * StorageBufferAttribute's typed array on chunk add/remove, then
 * flags the buffer for upload via `needsUpdate`. The compute shader
 * reads this buffer every frame — dead slots have radius=0 and are
 * skipped by the indirect draw compaction.
 */
export class GpuSlotAllocator {
  readonly maxSlots: number;

  /** The StorageBufferAttribute backing the GPU input buffer. */
  readonly inputAttr: StorageBufferAttribute;

  /** Direct reference to the attribute's Float32Array for CPU-side writes. */
  private readonly data: Float32Array;

  /** Highest allocated slot index + 1. Compute dispatches this many threads. */
  highWaterMark = 0;

  /** Free slot indices available for reuse. */
  private freeSlots: number[] = [];

  /** Map from chunkKey → array of slot indices used by that chunk. */
  private chunkSlots = new Map<string, number[]>();

  /** Dirty slot range accumulated between flushes. */
  private _dirtyMin = Infinity;
  private _dirtyMax = -1;
  private _needsFullUpload = false;

  constructor(maxSlots: number) {
    this.maxSlots = maxSlots;

    // 2 vec4s per slot → count = maxSlots * 2, itemSize = 4 (vec4)
    this.inputAttr = new StorageBufferAttribute(maxSlots * 2, 4);
    this.data = this.inputAttr.array as Float32Array;
  }

  /**
   * Allocate slots for a chunk's instances and write their data.
   * Positions are field-local meters (chunkOrigin * 1000 + instancePos).
   * Returns false if the buffer can't fit all instances.
   */
  allocateChunk(
    chunkKey: string,
    originKm: [number, number, number],
    instances: AsteroidChunkModelInstances,
  ): boolean {
    // If chunk already allocated, free first
    if (this.chunkSlots.has(chunkKey)) {
      this.freeChunk(chunkKey);
    }

    const count = instances.count;
    if (count === 0) return true;

    // Check capacity before allocating — reject if we can't fit all instances.
    const available = this.freeSlots.length + (this.maxSlots - this.highWaterMark);
    if (available < count) return false;

    const slots: number[] = new Array(count);
    const ox = originKm[0] * 1000;
    const oy = originKm[1] * 1000;
    const oz = originKm[2] * 1000;

    const positions = instances.positionsM;
    const quaternions = instances.quaternions;
    const radii = instances.radiiM;
    const d = this.data;

    let minSlot = Infinity;
    let maxSlot = -1;

    for (let i = 0; i < count; i++) {
      let slot: number;
      if (this.freeSlots.length > 0) {
        slot = this.freeSlots.pop()!;
      } else {
        slot = this.highWaterMark++;
      }
      slots[i] = slot;

      if (slot < minSlot) minSlot = slot;
      if (slot > maxSlot) maxSlot = slot;

      const off = slot * FLOATS_PER_SLOT;
      const pi = i * 3;
      const qi = i * 4;

      // vec4(pos.xyz, radius)
      d[off]     = ox + positions[pi];
      d[off + 1] = oy + positions[pi + 1];
      d[off + 2] = oz + positions[pi + 2];
      d[off + 3] = radii[i];

      // vec4(quat.xyzw)
      d[off + 4] = quaternions[qi];
      d[off + 5] = quaternions[qi + 1];
      d[off + 6] = quaternions[qi + 2];
      d[off + 7] = quaternions[qi + 3];
    }

    this.chunkSlots.set(chunkKey, slots);
    if (minSlot < this._dirtyMin) this._dirtyMin = minSlot;
    if (maxSlot > this._dirtyMax) this._dirtyMax = maxSlot;
    return true;
  }

  /**
   * Free all slots owned by a chunk (write radius=0 to mark dead).
   */
  freeChunk(chunkKey: string): void {
    const slots = this.chunkSlots.get(chunkKey);
    if (!slots) return;

    const d = this.data;
    let minSlot = Infinity;
    let maxSlot = -1;

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      d[slot * FLOATS_PER_SLOT + 3] = 0;
      this.freeSlots.push(slot);
      if (slot < minSlot) minSlot = slot;
      if (slot > maxSlot) maxSlot = slot;
    }

    this.chunkSlots.delete(chunkKey);
    if (minSlot < this._dirtyMin) this._dirtyMin = minSlot;
    if (maxSlot > this._dirtyMax) this._dirtyMax = maxSlot;
  }

  /**
   * Clear everything — used when flying far away (hard-clear path).
   */
  clear(): void {
    this.data.fill(0);
    this.freeSlots.length = 0;
    this.chunkSlots.clear();
    this.highWaterMark = 0;
    this._dirtyMin = Infinity;
    this._dirtyMax = -1;
    this._needsFullUpload = true;
  }

  /**
   * Flush pending CPU writes to the GPU buffer. Call once per frame
   * before compute dispatch. Coalesces all dirty slots into a single
   * partial writeBuffer (or a full upload after clear()).
   */
  flushToGpu(): void {
    if (this._needsFullUpload) {
      this.inputAttr.clearUpdateRanges();
      this.inputAttr.needsUpdate = true;
      this._needsFullUpload = false;
      this._dirtyMin = Infinity;
      this._dirtyMax = -1;
      return;
    }
    if (this._dirtyMax < 0) return;

    this.inputAttr.clearUpdateRanges();
    const minOff = this._dirtyMin * FLOATS_PER_SLOT;
    const maxOff = (this._dirtyMax + 1) * FLOATS_PER_SLOT;
    this.inputAttr.addUpdateRange(minOff, maxOff - minOff);
    this.inputAttr.needsUpdate = true;
    this._dirtyMin = Infinity;
    this._dirtyMax = -1;
  }

  /** Check if a chunk is already allocated. */
  hasChunk(chunkKey: string): boolean {
    return this.chunkSlots.has(chunkKey);
  }
}
