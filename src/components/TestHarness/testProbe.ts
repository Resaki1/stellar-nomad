import type { Camera, Scene } from "three";

/**
 * Shared state between the in-Canvas `TestFrameProbe` and the `__test` harness.
 * Plain mutable object: written per frame, read by async harness code.
 */
export const testProbe: {
  /** Rendered R3F frames since load. */
  frames: number;
  /** Dev hooks run at priority 0 with the R3F clock timestamp, after the sim clock and ship. */
  frameHooks: Set<(frameMs: number) => void>;
  /** The live renderer, for resident-resource counts. Null until the Canvas mounts. */
  renderer: { info: { memory: { textures: number; geometries: number } } } | null;
  scene: Scene | null;
  /** The rendered view camera (local scene), for camera-relative audio probes. */
  camera: Camera | null;
  /** Player ship sim pose (system-frame km, frame-relative km, quaternion xyzw), fixed steps run. */
  ship: {
    posKm: [number, number, number];
    frameId: string;
    relPosKm: [number, number, number];
    quat: [number, number, number, number];
    steps: number;
    frameSwitches: number;
    /** Frame-relative velocity km/s, body angular velocity rad/s, assist mode, boost 0..1, limit km/s. */
    velKmps: [number, number, number];
    angVel: [number, number, number];
    assist: string;
    boostCharge: number;
    speedLimitKmps: number;
  };
} = {
  ship: { posKm: [0, 0, 0], frameId: "", relPosKm: [0, 0, 0], quat: [0, 0, 0, 1], steps: 0, frameSwitches: 0, velKmps: [0, 0, 0], angVel: [0, 0, 0], assist: "coupled", boostCharge: 1, speedLimitKmps: 0 },
  frames: 0,
  frameHooks: new Set(),
  renderer: null,
  scene: null,
  camera: null,
};
