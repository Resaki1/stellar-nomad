/** Device → intent buffer. Plain mutable object: devices write it, the ship samples it once per frame. */

export const FLIGHT_ACTIONS = [
  "pitchUp",
  "pitchDown",
  "yawLeft",
  "yawRight",
  "rollLeft",
  "rollRight",
  "strafeLeft",
  "strafeRight",
  "strafeUp",
  "strafeDown",
  "accelerate",
  "decelerate",
  "boost",
  "brake",
  "toggleFlightAssist",
  "freeLook",
] as const;

export type FlightAction = (typeof FLIGHT_ACTIONS)[number];

export const playerInput = {
  /** Held state of each flight action (keyboard). */
  held: Object.fromEntries(FLIGHT_ACTIONS.map((a) => [a, false])) as Record<FlightAction, boolean>,
  /** Touch joystick, -1..1, pitch +1 = nose up before inversion. */
  stickYaw: 0,
  stickPitch: 0,
  /** Mouse virtual stick (mode A), after deadzone and curve, before inversion. */
  mouseYaw: 0,
  mousePitch: 0,
  /** Mouse aim controller (mode B) commands; inversion already applied to the mouse motion. */
  aimYaw: 0,
  aimPitch: 0,
  /** Persistent throttle set-point 0..1. */
  throttle: 0,
  decoupled: false,
  /** Set by a brake press; cleared by any translation input. */
  brakeLatched: false,
  invertPitch: false,
};

/** The pilot is steering or thrusting right now (any device). Free look is looking, not flying. */
export function flightInputActive(): boolean {
  const p = playerInput;
  for (const a of FLIGHT_ACTIONS) if (a !== "freeLook" && p.held[a]) return true;
  return p.throttle > 0 || Math.abs(p.stickYaw) + Math.abs(p.stickPitch) + Math.abs(p.mouseYaw) + Math.abs(p.mousePitch) +
    Math.abs(p.aimYaw) + Math.abs(p.aimPitch) > 0.05;
}

export function releaseHeldActions(): void {
  for (const a of FLIGHT_ACTIONS) playerInput.held[a] = false;
  playerInput.stickYaw = 0;
  playerInput.stickPitch = 0;
  playerInput.mouseYaw = 0;
  playerInput.mousePitch = 0;
  playerInput.aimYaw = 0;
  playerInput.aimPitch = 0;
}

/** Ship at rest with nothing commanded (loading gate, dev warp, respawn). Assist mode is kept. */
export function resetPlayerInput(): void {
  releaseHeldActions();
  playerInput.throttle = 0;
  playerInput.brakeLatched = false;
}

/** Step the throttle set-point (wheel, touch drag). */
export function nudgeThrottle(delta: number): void {
  playerInput.throttle = Math.min(1, Math.max(0, playerInput.throttle + delta));
  if (delta > 0) playerInput.brakeLatched = false;
}

/** One-shot actions fired on press. */
export function pressFlightAction(action: FlightAction): void {
  if (action === "toggleFlightAssist") playerInput.decoupled = !playerInput.decoupled;
  else if (action === "brake") {
    playerInput.throttle = 0;
    playerInput.brakeLatched = true;
  }
}
