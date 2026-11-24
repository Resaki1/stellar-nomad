import { Quaternion, Vector3, type PerspectiveCamera } from "three";
import { getCameraTuning } from "./cameraTuning";
import { listenerOrientationBuffer } from "@/audio/spatial";

/** What a camera rig sees of the ship each frame (docs/FLIGHT_MODEL_PLAN.md §4). */
export interface ShipPose {
  position: Vector3;
  /** Rendered (interpolated) orientation. */
  quaternion: Quaternion;
}

export interface ShipMotion {
  /** Body-axis acceleration over the last frame's fixed steps, m/s². */
  accelRight: number;
  accelUp: number;
  accelForward: number;
  /** Speed / speed limit, capped by the caller. */
  speedFrac: number;
  boosting: boolean;
  freeLook: boolean;
  /** Free-look orbit target, radians (+yaw right, +pitch up). */
  freeLookYaw: number;
  freeLookPitch: number;
  /** New shake impulse consumed this frame (0 = none). */
  shakeSignal: number;
  /** Shake is `performance.now()`-seeded, so it is skipped in benchmarks. */
  benchMode: boolean;
}

/** Chase rig now, cockpit rig later. */
export interface CameraRig {
  update(camera: PerspectiveCamera, pose: ShipPose, motion: ShipMotion, dt: number): void;
  /** Next update jumps straight to the rest pose: no swing (warp, respawn, world load, test scenes). */
  snap(): void;
  resetShake(): void;
}

/** Rig state for the test harness; written every update. */
export const cameraProbe = {
  /** Spring lag as a rotation vector in ship axes (+X left, +Y up, +Z forward), degrees. */
  lagVecDeg: [0, 0, 0] as [number, number, number],
  lagDeg: 0,
  /** Free-look orbit applied this frame, degrees. */
  orbitDeg: [0, 0] as [number, number],
  /** Total angle between the view direction (before shake) and the ship's orientation. */
  offsetDeg: 0,
  fovDeg: 0,
  snaps: 0,
};

const SHAKE_DECAY_RATE = 3.0;
const SHAKE_MAX_OFFSET = 0.8; // metres
const SHAKE_MAX_ANGLE = 0.025; // radians
const MAX_LAG_RAD = Math.PI / 3;
const RAD2DEG = 180 / Math.PI;
/** prefers-reduced-motion: no FOV pulse, give-way or shake, and a shorter swing. */
const REDUCED_LAG_S = 0.03;
let reducedMotion = false;
if (typeof window !== "undefined" && window.matchMedia) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotion = mq.matches;
  mq.addEventListener("change", (e) => (reducedMotion = e.matches));
}

const _xAxis = new Vector3(1, 0, 0);
const _yAxis = new Vector3(0, 1, 0);
const _flip = new Quaternion().setFromAxisAngle(_yAxis, Math.PI);
const _dq = new Quaternion();
const _lagQ = new Quaternion();
const _tmpQ = new Quaternion();
const _viewQ = new Quaternion();
const _axis = new Vector3();
const _u = new Vector3();
const _target = new Vector3();
const _offset = new Vector3();
const _shakeOffset = new Vector3();

/** Exact critically damped step toward a target moving at constant rate `u` (steady lag = −2u/ω). */
function springRamp(d: Vector3, w: Vector3, u: Vector3, omega: number, dt: number): void {
  const k = Math.exp(-omega * dt);
  for (let i = 0; i < 3; i++) {
    const ui = u.getComponent(i);
    const e0 = d.getComponent(i) + (2 * ui) / omega;
    const v0 = w.getComponent(i) - ui;
    const c = v0 + omega * e0;
    d.setComponent(i, (e0 + c * dt) * k - (2 * ui) / omega);
    w.setComponent(i, (v0 - omega * c * dt) * k + ui);
  }
}

/** Exact critically damped step toward a fixed target. */
function springTo(x: Vector3, v: Vector3, target: Vector3, omega: number, dt: number): void {
  const k = Math.exp(-omega * dt);
  for (let i = 0; i < 3; i++) {
    const e0 = x.getComponent(i) - target.getComponent(i);
    const v0 = v.getComponent(i);
    const c = v0 + omega * e0;
    x.setComponent(i, target.getComponent(i) + (e0 + c * dt) * k);
    v.setComponent(i, (v0 - omega * c * dt) * k);
  }
}

const smoothstep = (s: number): number => s * s * (3 - 2 * s);

export class ChaseRig implements CameraRig {
  private needsSnap = true;
  private readonly prevShipQ = new Quaternion();
  /** Lag rotation vector and camera angular velocity, ship axes. */
  private readonly lag = new Vector3();
  private readonly lagVel = new Vector3();
  /** Acceleration give-way, metres in ship axes. */
  private readonly accelOff = new Vector3();
  private readonly accelOffVel = new Vector3();
  private fov = 0;
  private orbitYaw = 0;
  private orbitPitch = 0;
  private wasFreeLook = false;
  private returnT = -1;
  private returnYaw = 0;
  private returnPitch = 0;
  private shakeIntensity = 0;

  snap(): void {
    this.needsSnap = true;
  }

  resetShake(): void {
    this.shakeIntensity = 0;
  }

  update(camera: PerspectiveCamera, pose: ShipPose, m: ShipMotion, dt: number): void {
    const t = getCameraTuning();
    const q = pose.quaternion;
    const rm = reducedMotion;
    const fovTarget = t.baseFovDeg + (rm ? 0 : 1) * Math.min(t.fovMaxExtraDeg, m.speedFrac * t.fovSpeedDeg + (m.boosting ? t.fovBoostDeg : 0));

    if (this.needsSnap) {
      this.needsSnap = false;
      this.lag.set(0, 0, 0);
      this.lagVel.set(0, 0, 0);
      this.accelOff.set(0, 0, 0);
      this.accelOffVel.set(0, 0, 0);
      this.prevShipQ.copy(q);
      this.fov = fovTarget;
      this.orbitYaw = this.orbitPitch = 0;
      this.returnT = -1;
      this.wasFreeLook = m.freeLook;
      this.shakeIntensity = 0;
      cameraProbe.snaps++;
    } else if (dt > 0) {
      // Ship rate from the rendered pose delta: the autopilot rotates the quaternion without angVel.
      _dq.copy(this.prevShipQ).invert().multiply(q);
      if (_dq.w < 0) _dq.set(-_dq.x, -_dq.y, -_dq.z, -_dq.w);
      const s = Math.sqrt(Math.max(0, 1 - _dq.w * _dq.w));
      if (s > 1e-10) _u.set(_dq.x, _dq.y, _dq.z).multiplyScalar((2 * Math.atan2(s, _dq.w)) / (s * dt));
      else _u.set(0, 0, 0);
      this.prevShipQ.copy(q);
      springRamp(this.lag, this.lagVel, _u, 1 / (rm ? Math.min(t.orientationLagS, REDUCED_LAG_S) : t.orientationLagS), dt);
      const len = this.lag.length();
      if (len > MAX_LAG_RAD) this.lag.multiplyScalar(MAX_LAG_RAD / len);

      // Ship axes: +X is left, so rightward acceleration pushes the camera toward +X.
      _target.set(m.accelRight, -m.accelUp, -m.accelForward).multiplyScalar(rm ? 0 : t.accelOffsetMPerMps2);
      const tl = _target.length();
      if (tl > t.accelOffsetMaxM) _target.multiplyScalar(t.accelOffsetMaxM / tl);
      springTo(this.accelOff, this.accelOffVel, _target, 1 / t.accelOffsetLagS, dt);

      this.fov += (fovTarget - this.fov) * (1 - Math.exp(-dt / t.fovLagS));
    }

    // Free look follows the mouse directly while held, then eases home over freeLookReturnS.
    if (m.freeLook) {
      this.orbitYaw = m.freeLookYaw;
      this.orbitPitch = m.freeLookPitch;
      this.returnT = -1;
    } else if (this.wasFreeLook) {
      this.returnT = 0;
      // Unlimited yaw: come home the short way round.
      this.returnYaw = Math.atan2(Math.sin(this.orbitYaw), Math.cos(this.orbitYaw));
      this.returnPitch = this.orbitPitch;
    }
    this.wasFreeLook = m.freeLook;
    if (this.returnT >= 0) {
      this.returnT += dt;
      const sN = Math.min(1, this.returnT / t.freeLookReturnS);
      const k = 1 - smoothstep(sN);
      this.orbitYaw = this.returnYaw * k;
      this.orbitPitch = this.returnPitch * k;
      if (sN >= 1) this.returnT = -1;
    }

    // view = ship · exp(lag) · orbit; the camera looks down its −Z, hence the flip.
    const lagLen = this.lag.length();
    if (lagLen > 0) _lagQ.setFromAxisAngle(_axis.copy(this.lag).divideScalar(lagLen), lagLen);
    else _lagQ.identity();
    _viewQ.copy(q).multiply(_lagQ);
    _viewQ.multiply(_tmpQ.setFromAxisAngle(_yAxis, -this.orbitYaw));
    _viewQ.multiply(_tmpQ.setFromAxisAngle(_xAxis, -this.orbitPitch));
    camera.quaternion.copy(_viewQ).multiply(_flip);
    // The audio listener faces where the camera faces (audio/spatial.ts, applied by the audio tick).
    listenerOrientationBuffer.x = camera.quaternion.x;
    listenerOrientationBuffer.y = camera.quaternion.y;
    listenerOrientationBuffer.z = camera.quaternion.z;
    listenerOrientationBuffer.w = camera.quaternion.w;

    _offset.set(0, -4, 11 + m.speedFrac * t.speedPullbackM).applyQuaternion(_viewQ);
    camera.position.copy(pose.position).sub(_offset);
    _offset.copy(this.accelOff).applyQuaternion(q);
    camera.position.add(_offset);

    if (Math.abs(camera.fov - this.fov) > 1e-6) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }

    const p = cameraProbe;
    p.lagVecDeg[0] = this.lag.x * RAD2DEG;
    p.lagVecDeg[1] = this.lag.y * RAD2DEG;
    p.lagVecDeg[2] = this.lag.z * RAD2DEG;
    p.lagDeg = lagLen * RAD2DEG;
    p.orbitDeg[0] = this.orbitYaw * RAD2DEG;
    p.orbitDeg[1] = this.orbitPitch * RAD2DEG;
    p.offsetDeg = q.angleTo(_viewQ) * RAD2DEG;
    p.fovDeg = this.fov;

    // Shake last.
    if (m.shakeSignal > 0 && !m.benchMode && !rm) {
      this.shakeIntensity = Math.min(1, this.shakeIntensity + m.shakeSignal);
    }
    if (this.shakeIntensity > 0.001) {
      const s = this.shakeIntensity;
      const tt = performance.now() * 0.001;
      const ox = Math.sin(tt * 37.7 + 1.3) * Math.cos(tt * 23.1);
      const oy = Math.sin(tt * 41.3 + 2.7) * Math.cos(tt * 29.7);
      const oz = Math.sin(tt * 31.1 + 4.1) * Math.cos(tt * 19.3);
      _shakeOffset.set(ox * SHAKE_MAX_OFFSET * s, oy * SHAKE_MAX_OFFSET * s, oz * SHAKE_MAX_OFFSET * 0.3 * s).applyQuaternion(_viewQ);
      camera.position.add(_shakeOffset);
      camera.quaternion.multiply(_tmpQ.setFromAxisAngle(_yAxis, Math.sin(tt * 43.7 + 0.5) * SHAKE_MAX_ANGLE * s));
      camera.quaternion.multiply(_tmpQ.setFromAxisAngle(_xAxis, Math.sin(tt * 47.3 + 3.2) * SHAKE_MAX_ANGLE * s));
      this.shakeIntensity *= Math.exp(-SHAKE_DECAY_RATE * dt);
    }
  }
}
