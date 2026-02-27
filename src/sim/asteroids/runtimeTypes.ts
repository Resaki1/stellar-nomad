export type ChunkCoord = { x: number; y: number; z: number };

export type AsteroidChunkModelInstances = {
  modelId: string;
  count: number;

  /**
   * Local positions in meters relative to the chunk origin (NOT relative to world origin).
   * Since local render space is 1 unit ~= 1 meter, these can be used directly for instancing.
   */
  positionsM: Float32Array; // count * 3

  /**
   * Quaternion per instance (x, y, z, w).
   */
  quaternions: Float32Array; // count * 4

  /**
   * Desired radius in meters per instance.
   */
  radiiM: Float32Array; // count

  /**
   * Stable per-instance ID (deterministic based on chunk seed + local index).
   * Preps for mining / damage / destruction deltas later.
   */
  instanceIds: Uint32Array; // count

  maxRadiusM: number;
};

export type AsteroidChunkData = {
  key: string;
  fieldId: string;

  coord: ChunkCoord;

  /**
   * Chunk origin in km relative to the field anchor.
   */
  originKm: [number, number, number];

  /**
   * AABB in km relative to the field anchor.
   */
  aabbMinKm: [number, number, number];
  aabbMaxKm: [number, number, number];

  /**
   * Instances grouped by modelId.
   */
  instancesByModel: Record<string, AsteroidChunkModelInstances>;

  /**
   * Max radius across all instances in this chunk.
   */
  maxRadiusM: number;
};

export function makeChunkKey(fieldId: string, coord: ChunkCoord): string {
  return `${fieldId}:${coord.x},${coord.y},${coord.z}`;
}
