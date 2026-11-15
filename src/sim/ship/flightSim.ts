/** Deterministic scripted flight through the real `stepShip` (no rendering). Backs `__test.flight.simulate`. */
import { Vector3 } from "three";
import { getFlightTuning } from "./flightTuning";
import { createShipInput, type ShipInput } from "./shipInput";
import { FIXED_DT } from "./shipConstants";
import { createShipState, type ShipState } from "./shipState";
import { createShipStepEnv, shipBodyAxes, stepShip, type ShipStepEnv } from "./stepShip";

export interface FlightSegment extends Partial<ShipInput> {
  label?: string;
  /** Fixed steps to run; `seconds` is converted with FIXED_DT when `steps` is absent. */
  steps?: number;
  seconds?: number;
}

export interface FlightScript {
  segments: FlightSegment[];
  /** Initial velocity in body axes [right, up, forward], m/s. */
  startVelocityBodyMps?: [number, number, number];
  startBoostCharge?: number;
  /** Trace every N steps (default 12 = 0.1 s); 1 for per-step traces. */
  sampleEvery?: number;
  env?: Partial<Pick<ShipStepEnv, "accelerationMult" | "decelerationMult" | "speedMult" | "stopDistanceMult" | "steerMult" | "speedLimitOverrideKmps">>;
}

export interface FlightSample {
  step: number;
  t: number;
  speedMps: number;
  /** [right, up, forward], m/s. */
  vBodyMps: [number, number, number];
  sideslipDeg: number;
  /** [pitch, yaw, roll] in ShipInput sign convention, deg/s. */
  ratesDegS: [number, number, number];
  /** Angle between the initial and current forward, deg. */
  headingDeg: number;
  distM: number;
  boostCharge: number;
  thrustMain: number;
  limitMps: number;
}

export interface FlightSegmentResult {
  label: string;
  steps: number;
  start: FlightSample;
  end: FlightSample;
  peakSideslipDeg: number;
  peakSpeedMps: number;
  trace: FlightSample[];
}

export interface FlightSimResult {
  dt: number;
  segments: FlightSegmentResult[];
  final: {
    posKm: number[];
    velKmps: number[];
    quat: number[];
    angVel: number[];
    boostCharge: number;
    boostIdleS: number;
    assist: string;
  };
}

const RAD = 180 / Math.PI;

export function simulateFlight(script: FlightScript): FlightSimResult {
  const ship: ShipState = createShipState();
  const env = createShipStepEnv(getFlightTuning());
  Object.assign(env, script.env ?? {});
  const input = createShipInput();
  const fwd0 = new Vector3();
  const right = new Vector3();
  const up = new Vector3();
  shipBodyAxes(ship.quat, fwd0, right, up);
  if (script.startVelocityBodyMps) {
    const [r, u, f] = script.startVelocityBodyMps;
    ship.velKmps.copy(fwd0).multiplyScalar(f / 1000).addScaledVector(right, r / 1000).addScaledVector(up, u / 1000);
  }
  if (script.startBoostCharge !== undefined) ship.boostCharge = script.startBoostCharge;
  const every = Math.max(1, Math.floor(script.sampleEvery ?? 12));
  let step = 0;
  let distM = 0;
  const fwd = new Vector3();

  const sample = (): FlightSample => {
    shipBodyAxes(ship.quat, fwd, right, up);
    const v = ship.velKmps;
    const f = v.dot(fwd) * 1000, r = v.dot(right) * 1000, u = v.dot(up) * 1000;
    const speed = v.length() * 1000;
    return {
      step,
      t: step * FIXED_DT,
      speedMps: speed,
      vBodyMps: [r, u, f],
      sideslipDeg: speed > 1e-6 ? Math.atan2(Math.hypot(r, u), f) * RAD : 0,
      ratesDegS: [-ship.angVel.x * RAD, -ship.angVel.y * RAD, ship.angVel.z * RAD],
      headingDeg: Math.acos(Math.max(-1, Math.min(1, fwd.dot(fwd0)))) * RAD,
      distM,
      boostCharge: ship.boostCharge,
      thrustMain: ship.thrustMain,
      limitMps: ship.speedLimitKmps * 1000,
    };
  };

  const segments: FlightSegmentResult[] = [];
  for (const seg of script.segments) {
    input.pitch = seg.pitch ?? 0;
    input.yaw = seg.yaw ?? 0;
    input.roll = seg.roll ?? 0;
    input.strafeX = seg.strafeX ?? 0;
    input.strafeY = seg.strafeY ?? 0;
    input.throttle = seg.throttle ?? 0;
    input.boost = seg.boost ?? false;
    input.brake = seg.brake ?? false;
    input.decoupled = seg.decoupled ?? false;
    const n = seg.steps ?? Math.round((seg.seconds ?? 0) / FIXED_DT);
    const start = sample();
    const trace: FlightSample[] = [start];
    let peakSlip = start.sideslipDeg;
    let peakSpeed = start.speedMps;
    for (let i = 0; i < n; i++) {
      stepShip(ship, input, env, FIXED_DT);
      distM += ship.posKm.distanceTo(ship.prevPosKm) * 1000;
      step++;
      const last = i === n - 1;
      if (last || (i + 1) % every === 0) {
        const s = sample();
        trace.push(s);
        if (s.sideslipDeg > peakSlip) peakSlip = s.sideslipDeg;
        if (s.speedMps > peakSpeed) peakSpeed = s.speedMps;
      }
    }
    segments.push({
      label: seg.label ?? `seg${segments.length}`,
      steps: n,
      start,
      end: trace[trace.length - 1],
      peakSideslipDeg: peakSlip,
      peakSpeedMps: peakSpeed,
      trace,
    });
  }

  return {
    dt: FIXED_DT,
    segments,
    final: {
      posKm: ship.posKm.toArray(),
      velKmps: ship.velKmps.toArray(),
      quat: ship.quat.toArray(),
      angVel: ship.angVel.toArray(),
      boostCharge: ship.boostCharge,
      boostIdleS: ship.boostIdleS,
      assist: ship.assist,
    },
  };
}
