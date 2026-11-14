import { MathUtils, Quaternion, Vector3 } from "three";
import { logLimit } from "@/helpers/math";
import { sweptSphereCollide, type CelestialCollider, type SweptHit } from "@/sim/celestialCollision";
import { MAX_ROT_SPEED, SHIP_HANDLING } from "./shipConstants";
import type { ShipInput } from "./shipInput";
import type { ShipState } from "./shipState";

/** Plain struct the caller fills before stepping; reused every frame. */
export interface ShipStepEnv {
  /** Steering multiplier (reduced during transit drive). */
  steerMult: number;
  /** Autopilot heading override; ignored unless `hasDesiredForward`. */
  hasDesiredForward: boolean;
  desiredForwardX: number;
  desiredForwardY: number;
  desiredForwardZ: number;
  desiredForwardRateRadPerS: number;
  accelerationMult: number;
  decelerationMult: number;
  maxSpeedKmps: number;
  /** Transit-drive velocity, km/s, added on top of normal flight. */
  transitVelX: number;
  transitVelY: number;
  transitVelZ: number;
  /** Positions are refreshed by the caller; r = 0 marks an unused slot. */
  colliders: readonly CelestialCollider[];
  hullRadiusKm: number;
}

export function createShipStepEnv(): ShipStepEnv {
  return {
    steerMult: 1,
    hasDesiredForward: false,
    desiredForwardX: 0,
    desiredForwardY: 0,
    desiredForwardZ: 0,
    desiredForwardRateRadPerS: 0,
    accelerationMult: 1,
    decelerationMult: 1,
    maxSpeedKmps: 0,
    transitVelX: 0,
    transitVelY: 0,
    transitVelZ: 0,
    colliders: [],
    hullRadiusKm: 0,
  };
}

const _quat = new Quaternion();
const _xAxis = new Vector3(1, 0, 0);
const _yAxis = new Vector3(0, 1, 0);
const _vel = new Vector3();
const _transitVel = new Vector3();
const _autopilotTarget = new Vector3();
const _autopilotAxis = new Vector3();

/**
 * Advance the ship one fixed step. Returns the celestial hit (posKm already clamped to
 * the entry point) or null. The hit object is module-scoped; consume it immediately.
 */
export function stepShip(state: ShipState, input: ShipInput, env: ShipStepEnv, dt: number): SweptHit | null {
  state.prevPosKm.copy(state.posKm);
  state.prevQuat.copy(state.quat);
  state.prevVRoll = state.vRoll;
  state.prevVPitch = state.vPitch;

  const steerMult = env.steerMult;
  const handling = SHIP_HANDLING * steerMult;
  const maxRot = MAX_ROT_SPEED * steerMult;

  if (input.yaw) {
    state.vRoll = logLimit(state.vRoll + input.yaw * handling * dt, Math.PI / 6 * steerMult);
    state.yawRate = MathUtils.clamp(state.yawRate + input.yaw * handling * dt, -maxRot, maxRot);
  } else {
    state.vRoll = MathUtils.lerp(state.vRoll, 0, SHIP_HANDLING * dt);
    state.yawRate -= state.yawRate * SHIP_HANDLING * dt;
  }

  if (input.pitch) {
    state.vPitch = logLimit(state.vPitch + input.pitch * handling * dt, Math.PI / 6 * steerMult);
    state.pitchRate = MathUtils.clamp(state.pitchRate + input.pitch * handling * dt, -maxRot, maxRot);
  } else {
    state.vPitch = MathUtils.lerp(state.vPitch, 0, SHIP_HANDLING * dt);
    state.pitchRate -= state.pitchRate * SHIP_HANDLING * dt;
  }

  _quat.setFromAxisAngle(_yAxis, -state.yawRate * dt);
  state.quat.multiply(_quat);
  _quat.setFromAxisAngle(_xAxis, state.pitchRate * dt);
  state.quat.multiply(_quat);
  state.quat.normalize();

  const fwd = state.forward;
  fwd.set(0, 0, 1).applyQuaternion(state.quat);

  // Autopilot (TransitTicker): rotate toward desiredForward at a capped rate.
  if (env.hasDesiredForward) {
    _autopilotTarget.set(env.desiredForwardX, env.desiredForwardY, env.desiredForwardZ);
    if (_autopilotTarget.lengthSq() > 0) {
      _autopilotTarget.normalize();
      const dot = Math.max(-1, Math.min(1, fwd.dot(_autopilotTarget)));
      const angle = Math.acos(dot);
      if (angle > 1e-4) {
        const maxStep = env.desiredForwardRateRadPerS * dt;
        const step = Math.min(angle, maxStep);
        _autopilotAxis.crossVectors(fwd, _autopilotTarget);
        if (_autopilotAxis.lengthSq() > 1e-12) {
          _autopilotAxis.normalize();
          _quat.setFromAxisAngle(_autopilotAxis, step);
          state.quat.premultiply(_quat);
          state.quat.normalize();
          fwd.set(0, 0, 1).applyQuaternion(state.quat);
        }
        // Kill residual angular velocity so autopilot holds the heading.
        state.yawRate *= 0.5;
        state.pitchRate *= 0.5;
      }
    }
  }

  const isAccelerating = input.throttle > state.speed;
  const responseMult = isAccelerating ? env.accelerationMult : env.decelerationMult;
  const baseAlpha = 1 - Math.pow(0.99, dt * 60);
  const speedAlpha = Math.min(1, baseAlpha * responseMult);
  state.speed = MathUtils.lerp(state.speed, input.throttle, speedAlpha);

  _vel.copy(fwd).multiplyScalar(env.maxSpeedKmps * state.speed * dt);
  state.posKm.add(_vel);

  _transitVel.set(env.transitVelX, env.transitVelY, env.transitVelZ);
  if (_transitVel.lengthSq() > 0) {
    _transitVel.multiplyScalar(dt);
    state.posKm.add(_transitVel);
  }

  // Swept test: transit can move >100,000 km per step, so a point test would tunnel.
  if (env.colliders.length > 0) {
    const p0 = state.prevPosKm;
    const p1 = state.posKm;
    const hit = sweptSphereCollide(
      p0.x, p0.y, p0.z,
      p1.x, p1.y, p1.z,
      env.colliders,
      env.hullRadiusKm,
    );
    if (hit) {
      p1.set(
        p0.x + (p1.x - p0.x) * hit.t,
        p0.y + (p1.y - p0.y) * hit.t,
        p0.z + (p1.z - p0.z) * hit.t,
      );
      return hit;
    }
  }
  return null;
}
