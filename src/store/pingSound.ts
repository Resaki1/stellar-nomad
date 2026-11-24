/**
 * The ping cue, heard from the pinged place: played a few metres out along the direction from the
 * ship (the chase listener sits at the ship and turns with the camera, audio/spatial.ts), so it
 * pans without any distance loss. Equal-power stereo has no front/back cue, so a ping behind the
 * view is also muffled: the voice's low-pass closes from 20 kHz (side/ahead) to 900 Hz (straight behind), just under the cue's 1,180 Hz
 * fundamental. MEASURED: 2 kHz changed nothing, 600 Hz cost 16 dB, 900 Hz costs 6 dB and reads clearly darker.
 */
import { Vector3 } from "three";
import { getEngine } from "@/audio/engine";
import { applyListenerOrientation, listenerOrientationBuffer } from "@/audio/spatial";
import { playAudio, type PlayOptions } from "@/audio/voices";
import { getLocalPlayerShip } from "@/sim/entities";
import { resolveFramePositionKm, type FrameId } from "@/sim/frames";

const CUE_DISTANCE_M = 20;
const BEHIND_CUTOFF_HZ = 900;
const OPEN_CUTOFF_HZ = 20000;
const _p = new Vector3();

/** Options for a ping heard from world direction `dir` (any length): position and the behind muffle. */
export function pingCueOptions(dir: { x: number; y: number; z: number }): PlayOptions {
  _p.set(dir.x, dir.y, dir.z);
  if (_p.lengthSq() < 1e-12) _p.set(0, 0, -1);
  _p.setLength(CUE_DISTANCE_M);
  // Camera forward = q·(0,0,−1); d = cos(angle off the view axis).
  const { x, y, z, w } = listenerOrientationBuffer;
  const fx = -(2 * (x * z + w * y)), fy = -(2 * (y * z - w * x)), fz = -(1 - 2 * (x * x + y * y));
  const d = (fx * _p.x + fy * _p.y + fz * _p.z) / CUE_DISTANCE_M;
  const cutoff = d >= 0 ? OPEN_CUTOFF_HZ : BEHIND_CUTOFF_HZ * (OPEN_CUTOFF_HZ / BEHIND_CUTOFF_HZ) ** (1 + d);
  return { positionM: { x: _p.x, y: _p.y, z: _p.z }, initialCutoffHz: cutoff };
}

export function playPingCue(frameId: string | undefined, positionKm: readonly [number, number, number]): void {
  const ship = getLocalPlayerShip();
  const dir = new Vector3(0, 0, -1);
  if (ship) {
    resolveFramePositionKm(positionKm as [number, number, number], frameId as FrameId | undefined, dir);
    dir.sub(ship.absPosKm);
  }
  // Turn the listener to the current view first: the tick may be up to 66 ms behind.
  const e = getEngine();
  if (e) applyListenerOrientation(e.ctx, true);
  playAudio("hud.ping", pingCueOptions(dir));
}
