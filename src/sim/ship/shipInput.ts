/**
 * Per-frame pilot intent (docs/FLIGHT_MODEL_PLAN.md §6). Signs: pitch +1 nose up, yaw +1 nose
 * right, roll +1 right wing down, strafeX +1 right, strafeY +1 up. `throttle` is the coupled
 * forward set-point (fraction of the speed limit); decoupled, it is main-engine thrust.
 */
export interface ShipInput {
  pitch: number;
  yaw: number;
  roll: number;
  strafeX: number;
  strafeY: number;
  throttle: number;
  boost: boolean;
  brake: boolean;
  decoupled: boolean;
}

export function createShipInput(): ShipInput {
  return { pitch: 0, yaw: 0, roll: 0, strafeX: 0, strafeY: 0, throttle: 0, boost: false, brake: false, decoupled: false };
}
