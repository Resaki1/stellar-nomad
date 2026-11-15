import type { ShipInput } from "@/sim/ship/shipInput";
import { createShipInput } from "@/sim/ship/shipInput";
import { getFlightTuning } from "@/sim/ship/flightTuning";
import { playerInput } from "./playerInput";

/** The input sampled this frame, for readers outside the ship (autopilot abort). */
export const lastShipInput: ShipInput = createShipInput();

const axis = (pos: boolean, neg: boolean): number => (pos === neg ? 0 : pos ? 1 : -1);
const clamp1 = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v);

/** Fill `out` from the device buffer. Called once per frame by the ship orchestrator; `dt` ramps the throttle. */
export function sampleShipInput(out: ShipInput, dt: number): void {
  const p = playerInput;
  const h = p.held;
  const decoupled = p.decoupled;

  if (!decoupled) {
    const ramp = dt / getFlightTuning().throttleRampS;
    if (h.accelerate) p.throttle = Math.min(1, p.throttle + ramp);
    if (h.decelerate) p.throttle = Math.max(0, p.throttle - ramp);
  }
  if (h.brake) p.throttle = 0;
  if (h.accelerate || h.strafeLeft || h.strafeRight || h.strafeUp || h.strafeDown) {
    p.brakeLatched = false;
  }

  const pitch = clamp1(axis(h.pitchUp, h.pitchDown) + p.stickPitch + p.mousePitch);
  out.pitch = clamp1((p.invertPitch ? -pitch : pitch) + p.aimPitch);
  out.yaw = clamp1(axis(h.yawRight, h.yawLeft) + p.stickYaw + p.mouseYaw + p.aimYaw);
  out.roll = axis(h.rollRight, h.rollLeft);
  out.strafeX = axis(h.strafeRight, h.strafeLeft);
  out.strafeY = axis(h.strafeUp, h.strafeDown);
  out.boost = h.boost;
  out.decoupled = decoupled;
  // Decoupled has no forward set-point: W is direct main thrust and S (no reverse channel) brakes.
  out.throttle = decoupled ? (h.accelerate ? 1 : 0) : p.throttle;
  out.brake = h.brake || p.brakeLatched || (decoupled && h.decelerate);

  Object.assign(lastShipInput, out);
}
