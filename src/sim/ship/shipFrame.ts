import { Vector3 } from "three";
import { frameOriginKm, selectFrame, type FrameId } from "@/sim/frames";
import { updateShipAbsolute, type ShipState } from "./shipState";

const _delta = new Vector3();
const _next = new Vector3();

/**
 * Once per rendered frame, after the substeps: refresh `absPosKm`, re-select the frame
 * and rebase posKm/prevPosKm by the same origin delta on a change (absolute position is
 * unchanged). The transit velocity is NOT converted: the drive keeps only |v| and
 * re-aims along shipForward, so adding a frame-velocity delta would just change speed.
 * Returns the previous frame id on a switch, else null.
 */
export function updateShipFrame(state: ShipState): FrameId | null {
  updateShipAbsolute(state);
  const next = selectFrame(state.absPosKm, state.frameId);
  if (next === state.frameId) return null;
  const prev = state.frameId;
  frameOriginKm(prev, _delta).sub(frameOriginKm(next, _next));
  state.posKm.add(_delta);
  state.prevPosKm.add(_delta);
  state.frameId = next;
  updateShipAbsolute(state);
  return prev;
}
