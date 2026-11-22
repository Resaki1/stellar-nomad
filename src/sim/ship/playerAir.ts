import { createAmbient } from "@/sim/atmosphere";

/**
 * The player ship's ambient air, written once per frame by `Spaceship.tsx` after the
 * origin is placed (the `transitDriveBuffer` pattern: a plain object, never React state).
 * Read by the wind audio, the drive's fuel law and the exhaust.
 */
export const playerAir = {
  ambient: createAmbient(),
  /** |v_ship − v_air| in m/s (co-rotating atmosphere, VFX plan §6). Inertial speed in vacuum. */
  airspeedMps: 0,
  /** Air-relative ship velocity, m/s, game axes. */
  relVelX: 0,
  relVelY: 0,
  relVelZ: 0,
};
