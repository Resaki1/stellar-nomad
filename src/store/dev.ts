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
 * Override every body's sphere tessellation, or 0 for the per-tier authored value.
 *
 * ⚠ EXISTS AS A CONTROLLED EXPERIMENT, not a setting. The limb-bead investigation's
 * candidate is the sphere's POLYGONAL SILHOUETTE, and the only in-game way to change
 * the segment count was to cross a LOD threshold — which also swaps the texture tier
 * and the camera distance at the same time. Three variables at once cannot answer a
 * one-variable question. This moves the segment count on its own.
 *
 * 🔑 Sagitta (how far a regular N-gon's edge falls inside the true circle) is
 * `R(1 − cos(π/N))` ∝ 1/N², so 48 → 128 is a 7.1× change with nothing else moving.
 */
export const devSegmentsOverrideAtom = atom<number>(0);

/**
 * Override `AP_RES_SCALE` for the aerial-perspective march target, or 0 for the
 * authored 0.5. Changing it rebuilds the whole atmosphere pass, which is exactly what
 * makes it safe — every uniform derived from the march height is rebuilt with it.
 *
 * ⚠ Diagnostic. 1.0 costs 4x the marched pixels, 2.0 costs 16x.
 */
export const devApResScaleAtom = atom<number>(0);

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
