import { signalAudioActionAtom } from "./audioSignals";
import { atom } from "jotai";
import { savedAtom } from "@/store/savedAtom";
import { isCargoFullAtom } from "@/store/cargo";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import type { AsteroidInstanceLocation } from "@/sim/asteroids/runtime";

export const TARGET_FOCUS_TIME_S = 3;

/** Effective focus window after applying scanner.lockSpeedMultiplier. */
export const effectiveTargetFocusTimeSAtom = atom((get) => {
  const mult = get(effectiveShipConfigAtom).scannerLockSpeedMult;
  return TARGET_FOCUS_TIME_S * mult;
});

export type TargetedAsteroid = {
  instanceId: number;
  location: AsteroidInstanceLocation;
  /** Distance to asteroid in meters */
  distanceM: number;
  /** World position in local render units (meters) */
  positionLocal: [number, number, number];
  /** Asteroid radius in meters */
  radiusM: number;
};

export type MiningState = {
  /** Currently targeted asteroid (within range, being aimed at / softly locked) */
  targetedAsteroid: TargetedAsteroid | null;
  /** Time in seconds that current asteroid has been targeted */
  targetingTimeS: number;
  /** Whether the asteroid is fully focused (targeted for TARGET_FOCUS_TIME_S) */
  isFocused: boolean;
  /** Whether mining is currently in progress */
  isMining: boolean;
  /** Mining progress from 0 to 1 */
  miningProgress: number;
  /** Ship thermal store 0..1 (shared with boost and processing; the laser trips at 1). */
  laserHeat: number;
  /** The laser's over-temperature trip, until the beam is off and heat is below 100 %. */
  isOverheated: boolean;
  /** Close inspection of the target, 0..1 (0 = not inspecting). */
  inspectProgress: number;
};

export const miningStateAtom = atom<MiningState>({
  targetedAsteroid: null,
  targetingTimeS: 0,
  isFocused: false,
  isMining: false,
  miningProgress: 0,
  laserHeat: 0,
  isOverheated: false,
  inspectProgress: 0,
});

/** Close-inspection intent (M3.3): MiningSystem advances it on the locked target, HUD starts it. */
export const inspectControl = { requested: false, targetId: -1, progress: 0 };

/** Start inspecting the locked rock (refused silently when nothing is locked). */
export const startInspectionAtom = atom(null, (get): boolean => {
  const s = get(miningStateAtom);
  if (!s.targetedAsteroid || !s.isFocused || s.isMining) return false;
  inspectControl.requested = true;
  inspectControl.targetId = s.targetedAsteroid.instanceId;
  inspectControl.progress = 0;
  return true;
});

export const cancelInspectionAtom = atom(null, () => {
  inspectControl.requested = false;
  inspectControl.progress = 0;
});

/**
 * Derived atom: show the targeting indicator whenever we have a target and we're not focused yet.
 * (No hidden 1s dead zone; fixes “stuck at 0 then jumps”.)
 */
export const showTargetingIndicatorAtom = atom((get) => {
  const state = get(miningStateAtom);
  return state.targetedAsteroid !== null && !state.isFocused;
});

/** Derived atom: targeting progress from 0..1 across the full focus window */
export const targetingProgressAtom = atom((get) => {
  const state = get(miningStateAtom);
  if (!state.targetedAsteroid) return 0;
  const focusTime = get(effectiveTargetFocusTimeSAtom);
  return Math.min(state.targetingTimeS / focusTime, 1);
});

/** Action atom: start mining */
export const startMiningAtom = atom(null, (get, set) => {
  const state = get(miningStateAtom);
  const cargoFull = get(isCargoFullAtom);
  if (!state.isFocused || state.isMining || cargoFull || state.isOverheated) return;
  set(miningStateAtom, { ...state, isMining: true, miningProgress: 0 });
  set(laserInterlockAtom, false);
});

/** Action atom: cancel mining */
export const cancelMiningAtom = atom(null, (get, set) => {
  const state = get(miningStateAtom);
  if (!state.isMining) return;
  set(miningStateAtom, { ...state, isMining: false, miningProgress: 0 });
});

// ---------------------------------------------------------------------------
// Ping bracket candidates (nearby mineable asteroids for HUD overlay)
// ---------------------------------------------------------------------------

export type PingCandidate3D = {
  instanceId: number;
  /** World-local position X (render-space meters). */
  x: number;
  /** World-local position Y (render-space meters). */
  y: number;
  /** World-local position Z (render-space meters). */
  z: number;
  /** Asteroid radius in meters. */
  radiusM: number;
};

/**
 * Mutable shared buffer written by MiningSystem every frame.
 * Read by PingBrackets3D in useFrame — world-space positions for 3D rendering.
 */
export const pingWorldBuffer: {
  candidates: PingCandidate3D[];
  generation: number;
} = { candidates: [], generation: 0 };

/** MiningSystem's beam request for the next fixed steps; the resource step grants the work. */
export const miningBeamRequest = { on: false };

// ---------------------------------------------------------------------------
// Mining-completed signal — incremented by MiningSystem each time an asteroid
// is fully mined. GameCommsTriggers watches this to fire comms messages.
// ---------------------------------------------------------------------------

export const asteroidMinedSignalAtom = atom(0);

/** Lifetime count of asteroids the player has ever mined (persists; a session signal is above). */
export const asteroidsMinedLifetimeAtom = savedAtom("player", "minedLifetime", 0);

// ---------------------------------------------------------------------------
// Pulse Mining mode
// ---------------------------------------------------------------------------

/** Pulse mining cycle constants. */
export const PULSE_ON_S = 1.5;
export const PULSE_OFF_S = 0.5;
export const PULSE_CYCLE_S = PULSE_ON_S + PULSE_OFF_S;

/** Whether pulse mining mode is currently selected (toggled by player). */
export const pulseMiningActiveAtom = atom(false);

/** Toggle pulse mining mode on/off. */
export const togglePulseMiningAtom = atom(null, (get, set) => {
  set(pulseMiningActiveAtom, !get(pulseMiningActiveAtom));
  set(signalAudioActionAtom, "click.soft");
});

/**
 * Mutable shared state for the pulse mining cycle timer.
 * Written by MiningSystem each frame. Read by the beam visual.
 * `beamOn` indicates whether the laser is currently firing in the pulse cycle.
 */
export const pulseCycleBuffer: {
  timer: number;
  beamOn: boolean;
  /** Pulse mode is cycling this frame (the beam draws a real pulse train, VFX plan B3). */
  pulsing: boolean;
} = { timer: 0, beamOn: true, pulsing: false };

/**
 * The player's beam as fired this frame (VFX plan §2 B1): straight along the ship's forward
 * axis from the mining socket, ending on the first rock surface it meets. Read by the HUD
 * (miss feedback) and the impact VFX (§3). Local-scene metres.
 */
/** Set when the ship's AI cut the laser (beam off target too long); cleared when mining restarts. */
export const laserInterlockAtom = atom(false);

export const miningBeamView = {
  on: false,
  /** Ends on a rock surface (any rock). */
  hit: { value: false },
  /** That surface is the locked target: mining progresses. */
  onTarget: false,
  /** Safety hold: the path crosses a station, depot or pilot, so the laser is not firing. */
  hold: false,
  start: [0, 0, 0] as [number, number, number],
  end: [0, 0, 0] as [number, number, number],
  /** Outward surface normal at the hit. */
  normal: [0, 0, 1] as [number, number, number],
  /** The rock hit (any), for impact VFX that ride the rock. */
  rock: { fieldId: "", chunkKey: "", instanceId: -1 },
  /** Hit point in FIELD-local metres (static for a rock; scene metres drift with the origin). */
  pointField: [0, 0, 0] as [number, number, number],
  power: 1,
};

// ---------------------------------------------------------------------------
// Shared mining (FIRST_EXPEDITION_PLAN WP5)
// ---------------------------------------------------------------------------

/**
 * The host's latest progress feed for this pilot's locked rock (written by the session client,
 * read by MiningSystem each frame). `partners`: the other pilots' work as a fraction of the rock.
 */
export const sharedMiningFeed = { fieldId: "", chunkKey: "", instanceId: -1, partners: 0, beams: 0, atMs: -Infinity };
/** An older feed counts for nothing (the host sends ~5 Hz while the rock is being mined). */
export const SHARED_FEED_FRESH_MS = 1000;

export interface SharedMining {
  /** Beams on the locked rock now, this pilot's included (0 outside a shared mine). */
  beams: number;
  /** The partners' share of the locked rock, 0..1. */
  partnersFraction: number;
}

/** HUD state for shared mining, committed at the mining UI rate only when it changes. */
export const sharedMiningAtom = atom<SharedMining>({ beams: 0, partnersFraction: 0 });
