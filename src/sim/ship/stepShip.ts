import { Quaternion, Vector3 } from "three";
import { sweptSphereCollide, type CelestialCollider, type SweptHit } from "@/sim/celestialCollision";
import { assistDeltaV, decoupledDeltaV, type AssistLimits, type BodyAxes } from "./flightAssist";
import { DEFAULT_FLIGHT_TUNING, speedLimitKmps, type FlightTuning } from "./flightTuning";
import type { ShipInput } from "./shipInput";
import type { ShipState } from "./shipState";

/** Plain struct the caller fills before stepping; reused every frame. */
export interface ShipStepEnv {
  tuning: Readonly<FlightTuning>;
  /** Steering multiplier (reduced during transit drive). */
  steerMult: number;
  /** Autopilot heading override; ignored unless `hasDesiredForward`. */
  hasDesiredForward: boolean;
  desiredForwardX: number;
  desiredForwardY: number;
  desiredForwardZ: number;
  desiredForwardRateRadPerS: number;
  /** Module multipliers: main + strafe thrust; retro + grip; final speed limit; stop distance. */
  accelerationMult: number;
  decelerationMult: number;
  speedMult: number;
  stopDistanceMult: number;
  /** Dev override of the speed limit, km/s; < 0 = off. Hard clamp, thrust scaled up to match. */
  speedLimitOverrideKmps: number;
  /** Propellant gate (resourceStep): scales every translational thrust limit, 0 = none. */
  thrustScale: number;
  /** Angular-acceleration authority, 0..1. */
  angularScale: number;
  /** Transit-drive velocity, km/s, added on top of normal flight. */
  transitVelX: number;
  transitVelY: number;
  transitVelZ: number;
  /** Positions are refreshed by the caller; r = 0 marks an unused slot. */
  colliders: readonly CelestialCollider[];
  hullRadiusKm: number;
}

export function createShipStepEnv(tuning: Readonly<FlightTuning> = DEFAULT_FLIGHT_TUNING): ShipStepEnv {
  return {
    tuning,
    steerMult: 1,
    hasDesiredForward: false,
    desiredForwardX: 0,
    desiredForwardY: 0,
    desiredForwardZ: 0,
    desiredForwardRateRadPerS: 0,
    accelerationMult: 1,
    decelerationMult: 1,
    speedMult: 1,
    stopDistanceMult: 1,
    speedLimitOverrideKmps: -1,
    thrustScale: 1,
    angularScale: 1,
    transitVelX: 0,
    transitVelY: 0,
    transitVelZ: 0,
    colliders: [],
    hullRadiusKm: 0,
  };
}

const DEG = Math.PI / 180;
const _quat = new Quaternion();
const _axis = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _step = new Vector3();
const _v0 = new Vector3();
const _autopilotTarget = new Vector3();
const _autopilotAxis = new Vector3();
const _lim: AssistLimits = { main: 0, retro: 0, strafe: 0, grip: 0 };
const _vBody: BodyAxes = { f: 0, r: 0, u: 0 };
const _set: BodyAxes = { f: 0, r: 0, u: 0 };
const _dv: BodyAxes = { f: 0, r: 0, u: 0 };

/** Move `v` toward `target` by at most `maxDelta`. */
function approach(v: number, target: number, maxDelta: number): number {
  const d = target - v;
  return d > maxDelta ? v + maxDelta : d < -maxDelta ? v - maxDelta : target;
}

/** Body axes of `q`: right is −X (the model's +X is its left). */
export function shipBodyAxes(q: Quaternion, fwd: Vector3, right: Vector3, up: Vector3): void {
  fwd.set(0, 0, 1).applyQuaternion(q);
  right.set(-1, 0, 0).applyQuaternion(q);
  up.set(0, 1, 0).applyQuaternion(q);
}

/**
 * Advance the ship one fixed step (semi-implicit Euler). Returns the celestial hit (posKm
 * already clamped to the entry point) or null. The hit object is module-scoped; consume it
 * immediately.
 */
export function stepShip(state: ShipState, input: ShipInput, env: ShipStepEnv, dt: number): SweptHit | null {
  const t = env.tuning;
  state.prevPosKm.copy(state.posKm);
  state.prevQuat.copy(state.quat);
  state.assist = input.decoupled ? "decoupled" : "coupled";

  // ── Rotation: rate command with an angular-acceleration limit (body axes) ──
  const steer = env.steerMult;
  const maxDw = t.angularAccelDegS2 * DEG * dt * env.angularScale;
  const w = state.angVel;
  const wx0 = w.x, wy0 = w.y, wz0 = w.z;
  w.x = approach(w.x, -input.pitch * t.maxPitchRateDegS * DEG * steer, maxDw);
  w.y = approach(w.y, -input.yaw * t.maxYawRateDegS * DEG * steer, maxDw);
  w.z = approach(w.z, input.roll * t.maxRollRateDegS * DEG * steer, maxDw);
  state.ctlDwRadps = Math.abs(w.x - wx0) + Math.abs(w.y - wy0) + Math.abs(w.z - wz0);
  const wLen = w.length();
  if (wLen > 0) {
    _axis.copy(w).divideScalar(wLen);
    _quat.setFromAxisAngle(_axis, wLen * dt);
    state.quat.multiply(_quat).normalize();
  }

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
        const step = Math.min(angle, env.desiredForwardRateRadPerS * dt);
        _autopilotAxis.crossVectors(fwd, _autopilotTarget);
        if (_autopilotAxis.lengthSq() > 1e-12) {
          _autopilotAxis.normalize();
          _quat.setFromAxisAngle(_autopilotAxis, step);
          state.quat.premultiply(_quat).normalize();
        }
        // Kill residual angular velocity so autopilot holds the heading.
        w.multiplyScalar(0.5);
      }
    }
  }
  shipBodyAxes(state.quat, fwd, _right, _up);

  // ── Boost capacitor ──
  // Boost is a sprint: full boosted main thrust to the boosted limit, whatever the throttle says.
  const boostDemand = input.boost && !input.brake;
  // No propellant, no boost: it would spend capacitor and heat for zero thrust.
  const boosting = boostDemand && state.boostCharge > 0 && env.thrustScale > 0;
  if (boosting) state.boostCharge = Math.max(0, state.boostCharge - dt / t.boostChargeS);
  // Holding boost on an empty capacitor still holds off the refill.
  if (boostDemand) {
    state.boostIdleS = 0;
  } else {
    state.boostIdleS += dt;
    if (state.boostIdleS >= t.boostRefillDelayS) {
      state.boostCharge = Math.min(1, state.boostCharge + dt / t.boostRefillS);
    }
  }
  state.boosting = boosting;

  // ── Limits (km/s², km/s) ──
  const baseLimit = speedLimitKmps(t, env.decelerationMult, env.speedMult, env.stopDistanceMult);
  const override = env.speedLimitOverrideKmps;
  const accelScale = override >= 0 && baseLimit > 0 ? Math.max(1, override / baseLimit) : 1;
  const boostMult = boosting ? t.boostThrustMult : 1;
  const gate = accelScale * env.thrustScale;
  _lim.main = (t.mainThrustMps2 / 1000) * env.accelerationMult * boostMult * gate;
  _lim.retro = (t.retroThrustMps2 / 1000) * env.decelerationMult * gate;
  _lim.strafe = (t.strafeThrustMps2 / 1000) * env.accelerationMult * gate;
  _lim.grip = (t.gripMps2 / 1000) * env.decelerationMult * gate;
  const vLimit = (override >= 0 ? override : baseLimit) * (boosting ? t.boostLimitMult : 1);
  state.speedLimitKmps = vLimit;

  // ── Translation ──
  const v = state.velKmps;
  _vBody.f = v.dot(fwd);
  _vBody.r = v.dot(_right);
  _vBody.u = v.dot(_up);
  if (input.brake) {
    _set.f = 0; _set.r = 0; _set.u = 0;
    assistDeltaV(_dv, _vBody, _set, _lim, dt, 1);
  } else if (input.decoupled) {
    decoupledDeltaV(_dv, boosting ? 1 : input.throttle, input.strafeX, input.strafeY, _lim, dt);
  } else {
    _set.r = input.strafeX * (t.strafeSpeedLimitMps / 1000);
    _set.u = input.strafeY * (t.strafeSpeedLimitMps / 1000);
    // Shrink forward so the total set-point stays within vLimit while strafing.
    const lat2 = _set.r * _set.r + _set.u * _set.u;
    const throttle = boosting ? 1 : Math.max(0, Math.min(1, input.throttle));
    _set.f = Math.min(throttle * vLimit, Math.sqrt(Math.max(0, vLimit * vLimit - lat2)));
    assistDeltaV(_dv, _vBody, _set, _lim, dt, Math.min(1, dt / t.velocityTimeConstantS));
  }
  _v0.copy(v);

  if (_dv.f !== 0 || _dv.r !== 0 || _dv.u !== 0) {
    const speed0 = v.length();
    v.addScaledVector(fwd, _dv.f).addScaledVector(_right, _dv.r).addScaledVector(_up, _dv.u);
    const speed1 = v.length();
    // Decoupled speed limit: thrust past it is cut. Coupled set-points are already bounded;
    // clamping there made full-throttle strafing fight the main engine every step.
    if (input.decoupled && !input.brake && speed1 > vLimit && speed1 > speed0) {
      v.multiplyScalar(Math.max(vLimit, speed0) / speed1);
    }
    // Exact rest: rebuilding v from body components leaves ~1e-20 residue otherwise.
    if (speed1 < 1e-6 && _set.f === 0 && _set.r === 0 && _set.u === 0 && !input.decoupled) v.set(0, 0, 0);
  }
  // Dev override: a hard cap, so lowering it takes effect at once (boost still raises it).
  if (override >= 0) {
    const s = v.length();
    if (s > vLimit) v.multiplyScalar(vLimit / s);
  }

  // From the velocity change that survived the clamps: exhaust, audio and the propellant meter.
  _v0.subVectors(v, _v0);
  const df = _v0.dot(fwd);
  state.ctlDvF = df;
  state.ctlDvR = _v0.dot(_right);
  state.ctlDvU = _v0.dot(_up);
  state.thrustMain = _lim.main > 0 && dt > 0 ? Math.min(1, Math.max(0, df / (_lim.main * dt))) : 0;

  state.posKm.addScaledVector(v, dt);
  if (env.transitVelX !== 0 || env.transitVelY !== 0 || env.transitVelZ !== 0) {
    _step.set(env.transitVelX, env.transitVelY, env.transitVelZ).multiplyScalar(dt);
    state.posKm.add(_step);
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
