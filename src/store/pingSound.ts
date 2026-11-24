/**
 * The ping cue, heard from the pinged place: played a few metres out along the direction from the
 * ship (the chase listener sits at the ship, audio/spatial.ts), so it pans without any distance loss.
 */
import { Vector3 } from "three";
import { playAudio } from "@/audio/voices";
import { getLocalPlayerShip } from "@/sim/entities";
import { resolveFramePositionKm, type FrameId } from "@/sim/frames";

const CUE_DISTANCE_M = 20;
const _p = new Vector3();

export function playPingCue(frameId: string | undefined, positionKm: readonly [number, number, number]): void {
  const ship = getLocalPlayerShip();
  if (ship) {
    resolveFramePositionKm(positionKm as [number, number, number], frameId as FrameId | undefined, _p);
    _p.sub(ship.absPosKm);
  }
  if (!ship || _p.lengthSq() < 1e-12) _p.set(0, 0, -1);
  _p.setLength(CUE_DISTANCE_M);
  playAudio("hud.ping", { positionM: { x: _p.x, y: _p.y, z: _p.z } });
}
