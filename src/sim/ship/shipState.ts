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
  /** Linear velocity, km/s, relative to `frameId` (carried over unchanged on a frame switch). */
  velKmps: Vector3;
  /** Angular velocity, rad/s, about body axes (+X left, +Y up, +Z forward). */
  angVel: Vector3;
  assist: AssistMode;
  /** Boost capacitor 0..1. */
  boostCharge: number;
  /** Seconds since boost was last drawn (refill starts after the delay). */
  boostIdleS: number;
  /** Last-step telemetry for views: main-engine use 0..1, boost firing, speed limit km/s. */
  thrustMain: number;
  boosting: boolean;
  speedLimitKmps: number;
  /** World-forward (+Z rotated by quat) as of the last step. */
  forward: Vector3;
}

export type AssistMode = "coupled" | "decoupled";

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
    velKmps: new Vector3(),
    angVel: new Vector3(),
    assist: "coupled",
    boostCharge: 1,
    boostIdleS: 0,
    thrustMain: 0,
    boosting: false,
    speedLimitKmps: 0,
    forward: new Vector3(0, 0, 1).applyQuaternion(new Quaternion(q[0], q[1], q[2], q[3])),
  };
}

/** Zero all motion and make prev = current (dev warp, respawn). Boost refills. */
export function resetShipMotion(state: ShipState): void {
  state.velKmps.set(0, 0, 0);
  state.angVel.set(0, 0, 0);
  state.boostCharge = 1;
  state.boostIdleS = 0;
  state.thrustMain = 0;
  state.boosting = false;
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
