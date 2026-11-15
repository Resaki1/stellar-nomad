/** Mouse mode B (docs/FLIGHT_MODEL_PLAN.md §2): aim direction + ship orientation → pitch/yaw rate commands. Pure. */
import { Vector3, type Quaternion } from "three";
import type { FlightTuning } from "./flightTuning";
import { shipBodyAxes } from "./stepShip";

export const AIM_CONE_DEG = 25;
/** Linear-region gain, 1/s. Commands are held for a whole frame, so the rate is also capped at err/dt. */
const AIM_GAIN = 8;
/** Braking margin on the angular-acceleration limit so the sqrt profile never overshoots. */
const AIM_BRAKE_MARGIN = 0.8;
/** Below this error the command is exactly zero, so rotation ends exactly (stepShip snaps small rates). */
const AIM_DEADBAND_RAD = 0.005 * (Math.PI / 180);
const DEG = Math.PI / 180;

const _f = new Vector3();
const _r = new Vector3();
const _u = new Vector3();

export interface AimCommand {
  pitch: number;
  yaw: number;
}

/** Body components of a world direction: forward, right, up. */
export interface BodyDir {
  f: number;
  r: number;
  u: number;
}

export function toBody(out: BodyDir, q: Quaternion, x: number, y: number, z: number): BodyDir {
  shipBodyAxes(q, _f, _r, _u);
  out.f = _f.x * x + _f.y * y + _f.z * z;
  out.r = _r.x * x + _r.y * y + _r.z * z;
  out.u = _u.x * x + _u.y * y + _u.z * z;
  return out;
}

export function fromBody(out: Vector3, q: Quaternion, b: BodyDir): Vector3 {
  shipBodyAxes(q, _f, _r, _u);
  return out.set(
    _f.x * b.f + _r.x * b.r + _u.x * b.u,
    _f.y * b.f + _r.y * b.r + _u.y * b.u,
    _f.z * b.f + _r.z * b.r + _u.z * b.u,
  );
}

/** Normalise and clamp a body direction to `coneDeg` around the nose (+f). */
export function clampToCone(b: BodyDir, coneDeg = AIM_CONE_DEG): BodyDir {
  const len = Math.hypot(b.f, b.r, b.u) || 1;
  b.f /= len; b.r /= len; b.u /= len;
  const cone = coneDeg * DEG;
  if (b.f >= Math.cos(cone)) return b;
  const lat = Math.hypot(b.r, b.u);
  if (lat < 1e-12) {
    b.f = Math.cos(cone); b.r = Math.sin(cone); b.u = 0;
    return b;
  }
  const s = Math.sin(cone) / lat;
  b.r *= s; b.u *= s; b.f = Math.cos(cone);
  return b;
}

function axisCommand(err: number, maxRateDegS: number, alphaDegS2: number, dt: number): number {
  const a = Math.abs(err);
  const maxRate = maxRateDegS * DEG;
  if (a < AIM_DEADBAND_RAD || maxRate <= 0) return 0;
  let rate = Math.min(maxRate, AIM_GAIN * a, Math.sqrt(2 * alphaDegS2 * DEG * AIM_BRAKE_MARGIN * a));
  if (dt > 0) rate = Math.min(rate, a / dt);
  return (Math.sign(err) * rate) / maxRate;
}

/** Commands that turn the nose onto `target` (body-frame direction) and stop there. */
export function aimRateCommand(out: AimCommand, target: BodyDir, t: Readonly<FlightTuning>, dt = 0): AimCommand {
  const yawErr = Math.atan2(target.r, target.f);
  const pitchErr = Math.atan2(target.u, Math.hypot(target.f, target.r));
  out.yaw = axisCommand(yawErr, t.maxYawRateDegS, t.angularAccelDegS2, dt);
  out.pitch = axisCommand(pitchErr, t.maxPitchRateDegS, t.angularAccelDegS2, dt);
  return out;
}
