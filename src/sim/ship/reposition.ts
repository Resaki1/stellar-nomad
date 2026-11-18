/**
 * Runtime reposition requests (M3.6). Recovery and dev warps both go through Spaceship's one
 * `applyReposition`, which resets every motion/camera/input/physics buffer. `holdUntilReady`
 * keeps the simulation paused until the arrival area has streamed in.
 */
import { holdSavedPose } from "@/sim/shipPersistence";
import { setSimPaused } from "@/sim/simPause";
import type { FrameId } from "@/sim/frames";

export interface RepositionRequest {
  frameId: FrameId;
  relKm: [number, number, number];
  /** null keeps the current heading. */
  quaternion: [number, number, number, number] | null;
  holdUntilReady: boolean;
}

export const ARRIVAL_PAUSE = "arrival";
/** Give up waiting for the arrival area after this long (the near field then runs on what is loaded). */
export const ARRIVAL_TIMEOUT_MS = 10_000;

export const repositionState = {
  pending: null as RepositionRequest | null,
  /** Applied repositions (harness / tests). */
  applied: 0,
  /** performance.now() of the reposition the arrival gate is waiting on, or 0. */
  arrivalSince: 0,
  arrivalFrames: 0,
  /** Last arrival wait, ms (harness). */
  lastArrivalMs: 0,
};

export function requestReposition(req: RepositionRequest): void {
  repositionState.pending = req;
  if (req.holdUntilReady) setSimPaused(true, ARRIVAL_PAUSE);
}

export function takeReposition(): RepositionRequest | null {
  const r = repositionState.pending;
  repositionState.pending = null;
  return r;
}

export function beginArrival(now: number): void {
  repositionState.arrivalSince = now;
  repositionState.arrivalFrames = 0;
}

export function endArrival(now: number): void {
  if (repositionState.arrivalSince > 0) repositionState.lastArrivalMs = now - repositionState.arrivalSince;
  repositionState.arrivalSince = 0;
  setSimPaused(false, ARRIVAL_PAUSE);
  holdSavedPose(false);
}

/** World switch / unmount: never leave the sim paused for an arrival that will not happen. */
export function resetReposition(): void {
  repositionState.pending = null;
  repositionState.arrivalSince = 0;
  setSimPaused(false, ARRIVAL_PAUSE);
  holdSavedPose(false);
}
