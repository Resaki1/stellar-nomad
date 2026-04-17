// ---------------------------------------------------------------------------
// Transit Drive — real-physics acceleration/deceleration through the solar system.
//
// No teleportation. The drive adds a true velocity vector to the ship.
// Phases: idle → spooling (hold key) → accelerating → decelerating → idle
// ---------------------------------------------------------------------------

import { atom } from "jotai";
import { modulesAtom } from "@/store/modules";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Drive acceleration in km/s^2 (~81,600 g — handwaved by inertial compensation). */
export const TRANSIT_ACCEL_KMPS2 = 800;

/** Time in seconds the player must hold the transit key to engage. */
export const TRANSIT_SPOOL_TIME_S = 3.0;

/** Steering rate multiplier during transit (fraction of normal).
 *  Keeps the "heavy freight train" feel without making turns unresponsive,
 *  since velocity direction tracks ship forward during acceleration. */
export const TRANSIT_STEER_MULT = 0.6;

/** When velocity magnitude drops below this during deceleration, drive disengages. */
const TRANSIT_DISENGAGE_SPEED_KMPS = 0.5; // just above normal max (0.4 km/s)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransitPhase =
  | "idle"
  | "spooling"
  | "accelerating"
  | "decelerating";

export type TransitTarget = {
  id: string;
  name: string;
  positionKm: [number, number, number];
  /** Stand-off distance (km) — autopilot aims this far short of the center. */
  arrivalOffsetKm?: number;
};

export type TransitState = {
  phase: TransitPhase;
  /** Spool-up progress 0..1 while holding the transit key. */
  spoolProgress: number;
  /** Current velocity magnitude in km/s (for HUD display). */
  velocityKmps: number;
  /** Peak velocity reached during this transit (for comms). */
  peakVelocityKmps: number;
  /** Targeted destination (if any — enables autopilot). */
  target: TransitTarget | null;
  /** Distance remaining to target in km (null if no target). */
  distanceToTargetKm: number | null;
  /** Estimated time to arrival in seconds (null if no target). */
  etaS: number | null;
};

const DEFAULT_TRANSIT: TransitState = {
  phase: "idle",
  spoolProgress: 0,
  velocityKmps: 0,
  peakVelocityKmps: 0,
  target: null,
  distanceToTargetKm: null,
  etaS: null,
};

export const transitStateAtom = atom<TransitState>(DEFAULT_TRANSIT);

// ---------------------------------------------------------------------------
// Mutable buffer — written by TransitTicker at frame rate, read by Spaceship.
// This avoids per-frame atom writes for the velocity vector.
// ---------------------------------------------------------------------------

export const transitDriveBuffer = {
  /** Current transit velocity vector in km/s. Zero when idle. */
  velocityKmps: { x: 0, y: 0, z: 0 },
  /** Current phase (mirrors atom but accessible without subscription). */
  phase: "idle" as TransitPhase,
  /** Whether the transit key is currently held (written by KeyboardControls). */
  keyHeld: false,
  /** Spool accumulator in seconds (written by TransitTicker). */
  spoolAccS: 0,
  /** Whether autopilot is active (target was set when drive engaged). */
  autopilot: false,
  /** Autopilot target position in km (copied when drive engages). */
  autopilotTargetKm: { x: 0, y: 0, z: 0 },
  /** Whether the transit key was tapped (pressed and released) since last frame.
   *  Used to trigger manual deceleration. Written by KeyboardControls, consumed by TransitTicker. */
  keyTapped: false,
  /** Ship forward direction (written by Spaceship.tsx each frame). */
  shipForward: null as { x: number; y: number; z: number } | null,
  /** Ship position in km (written by Spaceship.tsx each frame). */
  shipPosKm: null as { x: number; y: number; z: number } | null,
  /** Heading override for Spaceship.tsx: when non-null, Spaceship slerps ship
   *  quaternion toward this direction (overrides player steering). Used for
   *  autopilot auto-align during spool and continuous course correction. */
  desiredForward: null as { x: number; y: number; z: number } | null,
  /** Max slerp rate (rad/s) when desiredForward override is active. */
  desiredForwardRateRadPerS: 0,
  /** Ship forward direction snapshotted at spool start (for smooth auto-align lerp). */
  spoolStartForward: null as { x: number; y: number; z: number } | null,
};

// ---------------------------------------------------------------------------
// Derived: is transit drive owned?
// ---------------------------------------------------------------------------

export const transitDriveOwnedAtom = atom((get) => {
  const modules = get(modulesAtom);
  return modules.ownedModules.includes("special_transit_drive");
});

// ---------------------------------------------------------------------------
// Targeted POI for autopilot
// ---------------------------------------------------------------------------

export const targetedPOIAtom = atom<TransitTarget | null>(null);

/**
 * Calculate transit time for a symmetric flip-and-burn at constant acceleration.
 * d = a * t^2 / 4  →  t = 2 * sqrt(d / a)
 */
export function calcTransitTimeS(distanceKm: number): number {
  if (distanceKm <= 0) return 0;
  return 2 * Math.sqrt(distanceKm / TRANSIT_ACCEL_KMPS2);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Reset transit state to idle (e.g. on death, or drive unequipped). */
export const resetTransitAtom = atom(null, (_get, set) => {
  transitDriveBuffer.velocityKmps = { x: 0, y: 0, z: 0 };
  transitDriveBuffer.phase = "idle";
  transitDriveBuffer.spoolAccS = 0;
  transitDriveBuffer.autopilot = false;
  transitDriveBuffer.keyTapped = false;
  set(transitStateAtom, { ...DEFAULT_TRANSIT });
});
