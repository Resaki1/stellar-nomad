/** The local player's ship pose in the active save (frame-relative). */
import { Vector3 } from "three";
import { getActiveSave, getLocalPlayerState, registerCollector } from "@/save/activeSave";
import type { ShipPose } from "@/save/types";
import { frameOriginKm, isFrameId } from "@/sim/frames";
import type { ShipState } from "@/sim/ship/shipState";

const _origin = new Vector3();

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
