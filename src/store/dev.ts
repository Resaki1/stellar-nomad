import { atom } from "jotai";
import type { SpeedUnit } from "@/sim/units";

/**
 * Dev-only overrides consumed by the Spaceship component.
 * These atoms are only written to from the Dev settings panel
 * (which is hidden in production builds) and the perf benchmark harness
 * (`src/components/space/perf/benchRunner.ts`).
 */

/**
 * A one-shot ship warp: position, and optionally orientation.
 *
 * Position-only warps leave the ship pointing wherever it was. The benchmark
 * harness always supplies `quaternion` — a repeatable measurement needs a
 * repeatable view, and the atmosphere/cloud cost depends heavily on how much of
 * the planet fills the screen.
 */
export type DevWarp = {
  positionKm: [number, number, number];
  /** Orientation as `[x, y, z, w]`. Omitted = keep the current heading. */
  quaternion?: [number, number, number, number];
};

/**
 * One-shot teleport: when non-null, Spaceship jumps to this pose and clears the
 * atom. Handled in Spaceship's useFrame, which also zeroes throttle, steering
 * rates and the transit drive so the resulting pose is fully settled.
 */
export const devTeleportAtom = atom<DevWarp | null>(null);

/**
 * Max speed override in m/s. When non-null, replaces SHIP_MAX_SPEED_KMPS.
 * null = use default (400 m/s).
 */
export const devMaxSpeedOverrideAtom = atom<number | null>(null);

/** Unit selected in the dev speed-override input. */
export const devSpeedUnitAtom = atom<SpeedUnit>("m/s");

/**
 * Benchmark mode. While true, the game suppresses everything that would make a
 * measurement irreproducible or that would leak benchmark state into the save:
 *
 * • ship-position persistence (`ship-state-v1`) — otherwise the harness's
 *   teleports become the player's next spawn point
 * • camera shake (wall-clock driven, so it never repeats)
 * • the per-frame `hudInfoAtom` write (drives HUD React re-renders)
 * • comms messages entering the queue (they arrive on wall-clock timers and pop
 *   a DOM overlay mid-measurement)
 *
 * NOT the same as `settingsIsOpenAtom`: that sets `frameloop="never"`, which
 * would stop the very loop we are trying to measure.
 */
export const benchModeAtom = atom(false);
