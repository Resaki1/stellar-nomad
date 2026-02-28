import { atom } from "jotai";
import { isCargoFullAtom } from "@/store/cargo";
import type { AsteroidInstanceLocation } from "@/sim/asteroids/runtime";

export const TARGET_FOCUS_TIME_S = 3;

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
  /** Mining laser heat from 0 to 1 (1 = overheated). */
  laserHeat: number;
  /** True when the laser has overheated and is still cooling down. */
  isOverheated: boolean;
};

export const miningStateAtom = atom<MiningState>({
  targetedAsteroid: null,
  targetingTimeS: 0,
  isFocused: false,
  isMining: false,
  miningProgress: 0,
  laserHeat: 0,
  isOverheated: false,
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
  return Math.min(state.targetingTimeS / TARGET_FOCUS_TIME_S, 1);
});

/** Action atom: start mining */
export const startMiningAtom = atom(null, (get, set) => {
  const state = get(miningStateAtom);
  const cargoFull = get(isCargoFullAtom);
  if (!state.isFocused || state.isMining || cargoFull || state.isOverheated) return;
  set(miningStateAtom, { ...state, isMining: true, miningProgress: 0 });
});

/** Action atom: cancel mining */
export const cancelMiningAtom = atom(null, (get, set) => {
  const state = get(miningStateAtom);
  if (!state.isMining) return;
  set(miningStateAtom, { ...state, isMining: false, miningProgress: 0 });
});
