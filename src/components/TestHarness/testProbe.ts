/**
 * Shared state between the in-Canvas `TestFrameProbe` and the `__test` harness.
 * Plain mutable object: written per frame, read by async harness code.
 */
export const testProbe: {
  /** Rendered R3F frames since load. */
  frames: number;
  /** The live renderer, for resident-resource counts. Null until the Canvas mounts. */
  renderer: { info: { memory: { textures: number; geometries: number } } } | null;
} = {
  frames: 0,
  renderer: null,
};
