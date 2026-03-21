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

    for (let i = 0; i < count; i++) {
      let slot: number;
      if (this.freeSlots.length > 0) {
        slot = this.freeSlots.pop()!;
      } else {
        slot = this.highWaterMark++;
      }
      slots[i] = slot;

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
    this.inputAttr.needsUpdate = true;
    return true;
  }

  /**
   * Free all slots owned by a chunk (write radius=0 to mark dead).
   */
  freeChunk(chunkKey: string): void {
    const slots = this.chunkSlots.get(chunkKey);
    if (!slots) return;

    const d = this.data;
    for (let i = 0; i < slots.length; i++) {
      d[slots[i] * FLOATS_PER_SLOT + 3] = 0;
      this.freeSlots.push(slots[i]);
    }

    this.chunkSlots.delete(chunkKey);
    this.inputAttr.needsUpdate = true;
  }

  /**
   * Clear everything — used when flying far away (hard-clear path).
   */
  clear(): void {
    this.data.fill(0);
    this.freeSlots.length = 0;
    this.chunkSlots.clear();
    this.highWaterMark = 0;
    this.inputAttr.needsUpdate = true;
  }

  /** Check if a chunk is already allocated. */
  hasChunk(chunkKey: string): boolean {
    return this.chunkSlots.has(chunkKey);
  }
}
