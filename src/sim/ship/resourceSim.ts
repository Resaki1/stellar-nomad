/**
 * Deterministic scripted run of `stepShip` + `stepShipResources` with an explicit frame
 * pacing (no rendering). Backs `__test.resources.simulate` (M3.2 gates V1/V2/V3).
 * Time is counted in integer ticks of 1/1440 s so 30/60/144 Hz pacing is exact.
 */
import { Vector3 } from "three";
import { frameOriginKm, frameSoiKm, isFrameId } from "@/sim/frames";
import { getFlightTuning } from "./flightTuning";
import { DEFAULT_RESOURCE_TUNING, getEffectiveTuning, type ResourceTuning } from "./resourceTuning";
import { defaultShipConfig } from "@/save/defaults";
import { getItemDef, type ItemEffect } from "@/data/content";
import { aggregateEffects, applyModifiers, coolingMultOf, equipTuning, miningHeatMultOf } from "./loadout";
import {
  createResourceRequests,
  createShipResourceState,
  propellantGate,
  stepShipResources,
  unconvertedUnits,
  worstStepKg,
  type ResourceMeter,
} from "./resourceStep";
import { createShipInput, type ShipInput } from "./shipInput";
import { FIXED_DT, MAX_FRAME_DT } from "./shipConstants";
import { createShipState, setShipAbsolutePosition } from "./shipState";
import { updateShipFrame } from "./shipFrame";
import { createShipStepEnv, shipBodyAxes, stepShip } from "./stepShip";

const TICKS_PER_S = 1440;
const STEP_TICKS = TICKS_PER_S * FIXED_DT;

export interface ResourceSegment extends Partial<ShipInput> {
  label?: string;
  seconds: number;
  mining?: boolean;
  repair?: boolean;
  /** At segment start: begin a processing batch of this many feedstock units. */
  startBatchUnits?: number;
  /** At segment start: cancel the batch (reports the refund). */
  cancelBatch?: boolean;
  /** At segment start: an external body-axis velocity change [right, up, forward], m/s (a contact bounce). */
  kickBodyMps?: [number, number, number];
}

export interface ResourceScript {
  segments: ResourceSegment[];
  /** Render rate; must divide 1440 (30, 60, 144, …). */
  frameHz?: number;
  /** One long frame of `hitchS` at this executed time (s); capped at MAX_FRAME_DT like the game. */
  hitchAtS?: number;
  hitchS?: number;
  start?: {
    ordinaryKg?: number;
    protectedKg?: number;
    heat01?: number;
    boostCharge?: number;
    velocityBodyMps?: [number, number, number];
    /** Start just outside this frame's SOI, coasting inward at `velocityBodyMps[2]` along −x. */
    frameEdge?: string;
  };
  /** Heat/fuel trace every N steps (default 12). */
  sampleEvery?: number;
  /** Equipment multipliers as `updateShipRequests` derives them (1 = starter). */
  miningHeatMult?: number;
  /** Equipped item ids: the table and request multipliers come from the effective config (gate d). */
  equipped?: string[];
  coolingMult?: number;
}

export interface ResourceSample {
  t: number;
  ordinaryKg: number;
  protectedKg: number;
  heat01: number;
  capacitor01: number;
  speedMps: number;
  tripped: boolean;
  processingScale: number;
  miningScale: number;
}

export interface ResourceSegmentResult {
  label: string;
  steps: number;
  meter: ResourceMeter;
  start: ResourceSample;
  end: ResourceSample;
  maxHeat01: number;
  /** Executed seconds into the segment at which each threshold was first crossed. */
  firstWarnS: number | null;
  firstThrottleS: number | null;
  firstTripS: number | null;
  firstOver100S: number | null;
  firstDamageS: number | null;
  firstTankFullS: number | null;
  /** Lowest thrust gate seen (1 = full authority). */
  minThrustScale: number;
  refundUnits: number | null;
  frameSwitches: number;
  trace: ResourceSample[];
}

export interface ResourceSimResult {
  frameHz: number;
  framesRun: number;
  stepsRun: number;
  droppedS: number;
  segments: ResourceSegmentResult[];
  final: ResourceSample & { committedKg: number; batchActive: boolean; heatDamage01: number };
}

export function simulateResources(script: ResourceScript): ResourceSimResult {
  let t: Readonly<ResourceTuning> = getEffectiveTuning();
  const req = createResourceRequests();
  req.miningHeatMult = script.miningHeatMult ?? 1;
  req.coolingMult = script.coolingMult ?? 1;
  if (script.equipped) {
    const effects: ItemEffect[] = [];
    for (const id of script.equipped) effects.push(...(getItemDef(id)?.effects ?? []));
    const cfg = applyModifiers(defaultShipConfig(), aggregateEffects(effects));
    t = equipTuning(getEffectiveTuning(), cfg, { ...DEFAULT_RESOURCE_TUNING });
    req.miningHeatMult = script.miningHeatMult ?? miningHeatMultOf(cfg);
    req.coolingMult = script.coolingMult ?? coolingMultOf(cfg);
  }
  const ft = getFlightTuning();
  const ship = createShipState();
  const env = createShipStepEnv(ft);
  const input = createShipInput();
  const st = script.start ?? {};
  const res = createShipResourceState(st.ordinaryKg ?? t.tankKg, st.protectedKg ?? t.recoveryAllowanceKg);
  res.heat01 = st.heat01 ?? 0;
  if (st.boostCharge !== undefined) ship.boostCharge = st.boostCharge;
  res.capacitor01 = ship.boostCharge;
  const fwd = new Vector3(), right = new Vector3(), up = new Vector3();
  if (st.frameEdge && isFrameId(st.frameEdge)) {
    const o = frameOriginKm(st.frameEdge, new Vector3());
    setShipAbsolutePosition(ship, { x: o.x + frameSoiKm(st.frameEdge) + 0.3, y: o.y, z: o.z });
    ship.prevPosKm.copy(ship.posKm);
  }
  shipBodyAxes(ship.quat, fwd, right, up);
  if (st.velocityBodyMps) {
    const [r, u, f] = st.velocityBodyMps;
    ship.velKmps.copy(fwd).multiplyScalar(f / 1000).addScaledVector(right, r / 1000).addScaledVector(up, u / 1000);
    if (st.frameEdge) ship.velKmps.set(-Math.hypot(r, u, f) / 1000, 0, 0);
  }

  const hz = script.frameHz ?? 60;
  const frameTicks = Math.round(TICKS_PER_S / hz);
  if (frameTicks * hz !== TICKS_PER_S) throw new Error(`[resourceSim] frameHz ${hz} must divide ${TICKS_PER_S}`);
  const hitchAt = script.hitchAtS !== undefined ? Math.round(script.hitchAtS * TICKS_PER_S) : -1;
  const hitchTicks = Math.round(Math.min(script.hitchS ?? 0, 10) * TICKS_PER_S);
  const capTicks = Math.round(MAX_FRAME_DT * TICKS_PER_S);
  const every = Math.max(1, Math.floor(script.sampleEvery ?? 12));
  const gate = { thrust: 1, angular: 1 };
  const worstKg = worstStepKg(ft, t, 1, 1, FIXED_DT);

  let tick = 0;
  let acc = 0;
  let frames = 0;
  let droppedTicks = 0;
  let stepsRun = 0;
  const sample = (time: number): ResourceSample => {
    return {
      t: time,
      ordinaryKg: res.ordinaryKg,
      protectedKg: res.protectedKg,
      heat01: res.heat01,
      capacitor01: res.capacitor01,
      speedMps: ship.velKmps.length() * 1000,
      tripped: res.miningTripped,
      processingScale: res.processingScale,
      miningScale: res.miningScale,
    };
  };

  const segments: ResourceSegmentResult[] = [];
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
    req.miningBeam = seg.mining ?? false;
    req.repair = seg.repair ?? false;
    req.repairPerS = req.repair ? t.repairPerS : 0;

    let refundUnits: number | null = null;
    if (seg.startBatchUnits && seg.startBatchUnits > 0 && !res.processing.active) {
      const p = res.processing;
      p.active = true;
      p.id = `sim-${segments.length}`;
      p.recipeId = "hydrate_propellant";
      p.inputId = "hydrates";
      p.units = Math.floor(seg.startBatchUnits);
      p.elapsedS = 0;
      p.committedKg = 0;
    }
    if (seg.cancelBatch && res.processing.active) {
      refundUnits = unconvertedUnits(res.processing.units, res.processing.committedKg, t.processingKgPerUnit);
      res.processing.active = false;
    }
    if (seg.kickBodyMps) {
      shipBodyAxes(ship.quat, fwd, right, up);
      const [r, u, f] = seg.kickBodyMps;
      ship.velKmps.addScaledVector(fwd, f / 1000).addScaledVector(right, r / 1000).addScaledVector(up, u / 1000);
    }

    const m0: ResourceMeter = { ...res.meter };
    const startTick = tick;
    const endTick = tick + Math.round(seg.seconds * TICKS_PER_S);
    const start = sample(tick / TICKS_PER_S);
    const trace: ResourceSample[] = [start];
    let maxHeat = res.heat01;
    let firstWarn: number | null = null, firstThrottle: number | null = null, firstTrip: number | null = null;
    let firstOver: number | null = null, firstDamage: number | null = null, firstFull: number | null = null;
    let minGate = 1;
    let switches = 0;
    let segSteps = 0;
    while (tick < endTick) {
      let ft2 = tick === hitchAt ? hitchTicks : frameTicks;
      if (ft2 > capTicks) {
        droppedTicks += ft2 - capTicks;
        ft2 = capTicks;
      }
      tick += ft2;
      acc += ft2;
      frames++;
      while (acc >= STEP_TICKS) {
        acc -= STEP_TICKS;
        propellantGate(res, worstKg, t, gate);
        env.thrustScale = gate.thrust;
        env.angularScale = gate.angular;
        if (gate.thrust < minGate) minGate = gate.thrust;
        const dmg0 = res.meter.heatDamage01;
        stepShip(ship, input, env, FIXED_DT);
        stepShipResources(res, ship, req, t, FIXED_DT);
        stepsRun++;
        segSteps++;
        const ts = (segSteps * FIXED_DT);
        if (res.heat01 > maxHeat) maxHeat = res.heat01;
        if (firstWarn === null && res.heat01 >= t.heatWarn01) firstWarn = ts;
        if (firstThrottle === null && res.heatScale < 1) firstThrottle = ts;
        if (firstTrip === null && res.miningTripped) firstTrip = ts;
        if (firstOver === null && res.heat01 > 1) firstOver = ts;
        if (firstDamage === null && res.meter.heatDamage01 > dmg0) firstDamage = ts;
        if (firstFull === null && res.tankFull) firstFull = ts;
        if (segSteps % every === 0) trace.push(sample(startTick / TICKS_PER_S + ts));
      }
      if (st.frameEdge && updateShipFrame(ship) !== null) switches++;
    }
    const meter = {} as ResourceMeter;
    for (const k of Object.keys(m0) as (keyof ResourceMeter)[]) meter[k] = res.meter[k] - m0[k];
    segments.push({
      label: seg.label ?? `seg${segments.length}`,
      steps: segSteps,
      meter,
      start,
      end: sample(tick / TICKS_PER_S),
      maxHeat01: maxHeat,
      firstWarnS: firstWarn,
      firstThrottleS: firstThrottle,
      firstTripS: firstTrip,
      firstOver100S: firstOver,
      firstDamageS: firstDamage,
      firstTankFullS: firstFull,
      minThrustScale: minGate,
      refundUnits,
      frameSwitches: switches,
      trace,
    });
  }

  return {
    frameHz: hz,
    framesRun: frames,
    stepsRun,
    droppedS: droppedTicks / TICKS_PER_S,
    segments,
    final: { ...sample(tick / TICKS_PER_S), committedKg: res.processing.committedKg, batchActive: res.processing.active, heatDamage01: res.meter.heatDamage01 },
  };
}
