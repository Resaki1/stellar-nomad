import { Quaternion, Vector3 } from "three";
import { STARTING_POSITION_KM, STARTING_ROTATION_QUAT } from "@/sim/celestialConstants";
import { SYSTEM_FRAME_ID, frameOriginKm, selectFrame, type FrameId } from "@/sim/frames";

/** Fixed-step ship simulation state. Mutated in place by `stepShip`. */
export interface ShipState {
  /** Reference frame that `posKm` / `prevPosKm` are relative to. */
  frameId: FrameId;
  /** FRAME-RELATIVE position, km. */
  posKm: Vector3;
  /** Derived system-frame position, km; recomputed by the orchestrator after stepping. */
  absPosKm: Vector3;
  quat: Quaternion;
  /** Previous-step snapshots, for render interpolation (prevPosKm is frame-relative). */
  prevPosKm: Vector3;
  prevQuat: Quaternion;
  yawRate: number;
  pitchRate: number;
  /** Visual model tilt (roll from yaw input, pitch), radians. */
  vRoll: number;
  vPitch: number;
  prevVRoll: number;
  prevVPitch: number;
  /** Current speed fraction 0..1 of max. */
  speed: number;
  /** World-forward (+Z rotated by quat) as of the last step. */
  forward: Vector3;
}

export function createShipState(): ShipState {
  const p = STARTING_POSITION_KM;
  const q = STARTING_ROTATION_QUAT;
  const abs = new Vector3(p[0], p[1], p[2]);
  const frameId = selectFrame(abs, SYSTEM_FRAME_ID);
  const rel = abs.clone().sub(frameOriginKm(frameId, new Vector3()));
  return {
    frameId,
    posKm: rel.clone(),
    absPosKm: abs,
    quat: new Quaternion(q[0], q[1], q[2], q[3]),
    prevPosKm: rel,
    prevQuat: new Quaternion(q[0], q[1], q[2], q[3]),
    yawRate: 0,
    pitchRate: 0,
    vRoll: 0,
    vPitch: 0,
    prevVRoll: 0,
    prevVPitch: 0,
    speed: 0,
    forward: new Vector3(0, 0, 1),
  };
}

/** Zero all motion (rates, speed, visual tilt) and make prev = current. Used by dev warp. */
export function resetShipMotion(state: ShipState): void {
  state.speed = 0;
  state.yawRate = 0;
  state.pitchRate = 0;
  state.vRoll = 0;
  state.vPitch = 0;
  state.prevVRoll = 0;
  state.prevVPitch = 0;
  state.prevPosKm.copy(state.posKm);
  state.prevQuat.copy(state.quat);
}

const _origin = new Vector3();

/** absPosKm = posKm + current frame origin. */
export function updateShipAbsolute(state: ShipState): void {
  state.absPosKm.copy(state.posKm).add(frameOriginKm(state.frameId, _origin));
}

/** Place the ship at a system-frame position, resolving its frame (no hysteresis). */
export function setShipAbsolutePosition(state: ShipState, absKm: { x: number; y: number; z: number }): void {
  state.frameId = selectFrame(absKm, SYSTEM_FRAME_ID);
  frameOriginKm(state.frameId, _origin);
  state.posKm.set(absKm.x - _origin.x, absKm.y - _origin.y, absKm.z - _origin.z);
  state.absPosKm.set(absKm.x, absKm.y, absKm.z);
}
