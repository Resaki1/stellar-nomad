/** The local player's ship pose in the active save (frame-relative). */
import { Vector3 } from "three";
import { getActiveSave, getLocalPlayerState, registerCollector } from "@/save/activeSave";
import type { ShipPose } from "@/save/types";
import { SYSTEM_FRAME_ID, frameOriginKm, isFrameId, selectFrame, type FrameId } from "@/sim/frames";
import type { ShipState } from "@/sim/ship/shipState";

const _origin = new Vector3();
/** Set while an operation-committed pose waits for its teleport; the live ship is stale until then. */
let poseHeld = false;

export function holdSavedPose(on: boolean): void {
  poseHeld = on;
}

/** Frame-relative pose for a system-frame position, km, at the current ephemeris instant. */
export function relativePose(absKm: readonly [number, number, number]): { frameId: FrameId; positionKm: [number, number, number] } {
  const frameId = selectFrame({ x: absKm[0], y: absKm[1], z: absKm[2] }, SYSTEM_FRAME_ID);
  frameOriginKm(frameId, _origin);
  return { frameId, positionKm: [absKm[0] - _origin.x, absKm[1] - _origin.y, absKm[2] - _origin.z] };
}

export function loadShipState(): ShipPose | null {
  if (!getActiveSave()) return null;
  const pose = getLocalPlayerState().ship;
  return pose && isFrameId(pose.frameId) ? pose : null;
}

/** System-frame position of a saved pose, km, at the current ephemeris instant. */
export function persistedAbsoluteKm(saved: ShipPose): [number, number, number] {
  frameOriginKm(saved.frameId, _origin);
  const p = saved.positionKm;
  return [p[0] + _origin.x, p[1] + _origin.y, p[2] + _origin.z];
}

/** Sample the live ship into the save at every flush. Returns the unregister function. */
export function collectShipPose(ship: ShipState): () => void {
  return registerCollector(() => {
    if (poseHeld) return;
    const player = getLocalPlayerState();
    const pose = player.ship ?? { frameId: ship.frameId, positionKm: [0, 0, 0], quaternion: [0, 0, 0, 1] };
    pose.frameId = ship.frameId;
    pose.positionKm[0] = ship.posKm.x;
    pose.positionKm[1] = ship.posKm.y;
    pose.positionKm[2] = ship.posKm.z;
    pose.quaternion[0] = ship.quat.x;
    pose.quaternion[1] = ship.quat.y;
    pose.quaternion[2] = ship.quat.z;
    pose.quaternion[3] = ship.quat.w;
    player.ship = pose;
  });
}
