/** Flight assist: body-axis velocity + command → body-axis Δv for one step. Pure. */

/** Acceleration limits for this step, km/s². */
export interface AssistLimits {
  main: number;
  retro: number;
  strafe: number;
  grip: number;
}

/** Body-axis triple: forward, right, up. */
export interface BodyAxes {
  f: number;
  r: number;
  u: number;
}

/** Below this error (km/s, 1 mm/s) an axis snaps exactly, so "at rest" is exactly zero. */
const SNAP_KMPS = 1e-6;

function axisDv(err: number, limPos: number, limNeg: number, dt: number, k: number): number {
  const dv = Math.abs(err) < SNAP_KMPS ? err : err * k;
  return Math.max(-limNeg * dt, Math.min(limPos * dt, dv));
}

/**
 * Drive the velocity toward a body-axis set-point. `smoothing` = dt/τ (≤ 1) softens the
 * approach so the assist does not chatter; 1 is bang-bang (brake). Sideways authority is
 * max(strafe, grip): that is what drags the velocity round to the nose in a turn.
 */
export function assistDeltaV(
  out: BodyAxes,
  v: Readonly<BodyAxes>,
  set: Readonly<BodyAxes>,
  lim: Readonly<AssistLimits>,
  dt: number,
  smoothing: number,
): BodyAxes {
  const side = Math.max(lim.strafe, lim.grip);
  out.f = axisDv(set.f - v.f, lim.main, lim.retro, dt, smoothing);
  out.r = axisDv(set.r - v.r, side, side, dt, smoothing);
  out.u = axisDv(set.u - v.u, side, side, dt, smoothing);
  return out;
}

/** Decoupled: direct thrust, no set-point. Forward is main engine only. */
export function decoupledDeltaV(
  out: BodyAxes,
  throttle: number,
  strafeX: number,
  strafeY: number,
  lim: Readonly<AssistLimits>,
  dt: number,
): BodyAxes {
  out.f = Math.max(0, throttle) * lim.main * dt;
  out.r = strafeX * lim.strafe * dt;
  out.u = strafeY * lim.strafe * dt;
  return out;
}
