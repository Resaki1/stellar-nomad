/** Per-frame pilot input; yaw/pitch are -1..1 steering, throttle is target speed 0..1. */
export interface ShipInput {
  yaw: number;
  pitch: number;
  throttle: number;
}
