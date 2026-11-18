/**
 * Deterministic scripted transit: the real `stepTransit` → `stepShip` → `stepShipResources`
 * chain at an explicit frame pacing, in the system frame with scripted bodies and target.
 * Backs `__test.gameplay.transit.simulate` (M3.5 gates V9). Ticks of 1/1440 s, as resourceSim.
 */
import { Vector3 } from "three";
import { SYSTEM_FRAME_ID } from "@/sim/frames";
import type { CelestialCollider } from "@/sim/celestialCollision";
import { getFlightTuning } from "./flightTuning";
import { getEffectiveTuning } from "./resourceTuning";
import { createResourceRequests, createShipResourceState, propellantGate, stepShipResources, worstStepKg } from "./resourceStep";
import { createShipInput } from "./shipInput";
import { FIXED_DT, MAX_FRAME_DT, SHIP_HULL_RADIUS_KM } from "./shipConstants";
import { createShipState, updateShipAbsolute } from "./shipState";
import { createShipStepEnv, stepShip } from "./stepShip";
import {
  createTransitInputs,
  createTransitPlan,
  createTransitRuntime,
  planTransit,
  stepTransit,
  transitReserveKg,
  TRANSIT_STEER_MULT,
  type TransitPhase,
  type TransitPlan,
  type TransitTarget,
} from "./transitDrive";

const TICKS_PER_S = 1440;
const STEP_TICKS = TICKS_PER_S * FIXED_DT;

export interface TransitScript {
  /** Ship start, system km. */
  shipKm?: [number, number, number];
  /** Initial nose; default +z. */
  facing?: [number, number, number];
  /** null = manual transit (no autopilot). */
  target?: { positionKm: [number, number, number]; velKmps?: [number, number, number]; arrivalOffsetKm?: number; id?: string; name?: string; fieldKm?: [number, number, number] } | null;
  bodies?: { id: string; posKm: [number, number, number]; radiusKm: number; atmosphereTopKm?: number }[];
  ordinaryKg?: number;
  protectedKg?: number;
  heat01?: number;
  frameHz?: number;
  hitchAtS?: number;
  hitchS?: number;
  /** Plan only (route checks over many pairs): the result carries `plan` alone. */
  planOnly?: boolean;
  /** Key held this long from t = 0 (default spool + 0.5 s). */
  holdKeyS?: number;
  /** Tap the key once `phase` has run for `afterS` (abort / manual brake); "spooling" releases the key instead. */
  tapAt?: { phase: TransitPhase; afterS?: number };
  maxS?: number;
  /** Hold full strafe while the drive is in this phase (manoeuvring against the braking reserve). */
  strafeIn?: TransitPhase;
  /** Dev speed override (transit unbilled, uncapped by fuel). */
  freeFlight?: boolean;
  /** Tank capacity override, kg (an Auxiliary Tank loadout); default the effective tuning's. */
  tankKg?: number;
}

export interface TransitSimResult {
  frameHz: number;
  frames: number;
  steps: number;
  droppedS: number;
  plan: TransitPlan;
  engaged: boolean;
  refusal: string | null;
  /** Executed seconds from the engage step to the end of the trip (idle). */
  etaS: number | null;
  fuelKg: number;
  transitKg: number;
  thrustKg: number;
  ordinaryKg: number;
  protectedKg: number;
  minOrdinaryKg: number;
  peakHeat01: number;
  endHeat01: number;
  peakKmps: number;
  endSpeedKmps: number;
  shipSpeedMps: number;
  finalAimDistKm: number;
  /** Min distance to each body's centre over the run, km. */
  minBodyDistKm: Record<string, number>;
  hit: string | null;
  /** First executed second of each phase. */
  phaseAt: Partial<Record<TransitPhase, number>>;
  /** Fuel left (ordinary + protected) when a phase was first entered, and at the abort tap. */
  tapS: number | null;
  speedAtTapKmps: number | null;
  events: { arrived: number; aborted: number; legDone: number; stoppedShort: number; proximity: number };
  legCount: number;
  endPhase: TransitPhase;
  final: { posKm: number[]; speedKmps: number; ordinaryKg: number; protectedKg: number; heat01: number };
}

export function simulateTransit(script: TransitScript): TransitSimResult | Pick<TransitSimResult, "plan"> {
  const t = script.tankKg ? { ...getEffectiveTuning(), tankKg: script.tankKg } : getEffectiveTuning();
  const ft = getFlightTuning();
  const ship = createShipState();
  ship.frameId = SYSTEM_FRAME_ID;
  const sk = script.shipKm ?? [0, 0, 0];
  ship.posKm.set(sk[0], sk[1], sk[2]);
  ship.prevPosKm.copy(ship.posKm);
  const f = new Vector3(...(script.facing ?? [0, 0, 1])).normalize();
  ship.quat.setFromUnitVectors(new Vector3(0, 0, 1), f);
  ship.prevQuat.copy(ship.quat);
  ship.forward.copy(f);
  updateShipAbsolute(ship);
  const env = createShipStepEnv(ft);
  const input = createShipInput();
  const req = createResourceRequests();
  const res = createShipResourceState(script.ordinaryKg ?? t.tankKg, script.protectedKg ?? t.recoveryAllowanceKg);
  res.heat01 = script.heat01 ?? 0;
  res.capacitor01 = ship.boostCharge;
  const rt = createTransitRuntime();
  const bodies = (script.bodies ?? []).map((b) => ({ id: b.id, name: b.id, pos: [...b.posKm], radiusKm: b.radiusKm, atmosphereTopKm: b.atmosphereTopKm }));
  rt.bodies = bodies;
  const colliders: CelestialCollider[] = bodies.map((b) => ({ id: b.id, x: b.pos[0], y: b.pos[1], z: b.pos[2], r: b.radiusKm }));
  env.colliders = colliders;
  env.hullRadiusKm = SHIP_HULL_RADIUS_KM;
  const inp = createTransitInputs();
  inp.owned = true;
  inp.freeFlight = req.freeFlight = !!script.freeFlight;
  const tgtPos = script.target ? [...script.target.positionKm] : null;
  const tv = script.target?.velKmps ?? [0, 0, 0];
  const target: TransitTarget | null = script.target && tgtPos
    ? { id: script.target.id ?? "sim:target", name: script.target.name ?? "target", positionKm: tgtPos, arrivalOffsetKm: script.target.arrivalOffsetKm, field: script.target.fieldKm ? { positionKm: [...script.target.fieldKm], name: "field" } : undefined }
    : null;
  inp.target = target;
  inp.aimVelX = tv[0]; inp.aimVelY = tv[1]; inp.aimVelZ = tv[2];

  const plan = createTransitPlan();
  planTransit(plan, ship.absPosKm, target, rt.bodies, res, inp, t, FIXED_DT);
  const planOut = { ...plan, legs: plan.legs.slice(0, plan.legCount).map((l) => ({ ...l, base: [...l.base] })) };
  if (script.planOnly) return { plan: planOut };

  const hz = script.frameHz ?? 60;
  const frameTicks = Math.round(TICKS_PER_S / hz);
  if (frameTicks * hz !== TICKS_PER_S) throw new Error(`[transitSim] frameHz ${hz} must divide ${TICKS_PER_S}`);
  const hitchAt = script.hitchAtS !== undefined ? Math.round(script.hitchAtS * TICKS_PER_S) : -1;
  const hitchTicks = Math.round(Math.min(script.hitchS ?? 0, 10) * TICKS_PER_S);
  const capTicks = Math.round(MAX_FRAME_DT * TICKS_PER_S);
  const holdTicks = Math.round((script.holdKeyS ?? 3.5) * TICKS_PER_S);
  const endTicks = Math.round((script.maxS ?? 900) * TICKS_PER_S);
  const worstKg = worstStepKg(ft, t, 1, 1, FIXED_DT);
  const gate = { thrust: 1, angular: 1 };
  const total0 = res.ordinaryKg + res.protectedKg;
  const minBody: Record<string, number> = {};
  for (const b of bodies) minBody[b.id] = Infinity;
  const phaseAt: Partial<Record<TransitPhase, number>> = {};
  const aim = new Vector3();

  let tick = 0, acc = 0, frames = 0, steps = 0, dropped = 0;
  let engageStep = -1, endStep = -1;
  let peakHeat = res.heat01, peakV = 0, minOrd = res.ordinaryKg;
  let hit: string | null = null;
  let tapS: number | null = null, speedAtTap: number | null = null;
  let tapDone = false;
  let released = false;
  let phaseSince = -1;
  let lastPhase: TransitPhase = "idle";

  while (tick < endTicks) {
    // Frame-level input, as the keyboard and ephemeris deliver it.
    rt.keyHeld = !released && tick < holdTicks;
    input.strafeX = script.strafeIn && rt.phase === script.strafeIn ? 1 : 0;
    if (script.tapAt && !tapDone && phaseSince >= 0 && rt.phase === script.tapAt.phase && (steps - phaseSince) * FIXED_DT >= (script.tapAt.afterS ?? 0)) {
      tapDone = true;
      tapS = steps * FIXED_DT;
      speedAtTap = rt.speedKmps;
      if (script.tapAt.phase === "spooling") released = true;
      else rt.keyTapped = true;
      rt.keyHeld = !released && tick < holdTicks;
    }
    let ft2 = tick === hitchAt ? hitchTicks : frameTicks;
    if (ft2 > capTicks) {
      dropped += ft2 - capTicks;
      ft2 = capTicks;
    }
    tick += ft2;
    acc += ft2;
    frames++;
    if (tgtPos) for (let k = 0; k < 3; k++) tgtPos[k] += tv[k] * (ft2 / TICKS_PER_S);
    while (acc >= STEP_TICKS) {
      acc -= STEP_TICKS;
      stepTransit(rt, ship, inp, res, t, FIXED_DT);
      steps++;
      if (rt.phase !== lastPhase) {
        if (phaseAt[rt.phase] === undefined) phaseAt[rt.phase] = steps * FIXED_DT;
        phaseSince = steps;
        if (engageStep < 0 && rt.phase === "spooling") engageStep = steps - 1;
        if (rt.phase === "idle" && engageStep >= 0 && endStep < 0) endStep = steps;
        lastPhase = rt.phase;
      }
      if (endStep >= 0) break; // the trip is over: results are read at this step at every pacing
      env.transitVelX = rt.velX; env.transitVelY = rt.velY; env.transitVelZ = rt.velZ;
      env.steerMult = rt.speedKmps > 0 ? TRANSIT_STEER_MULT : 1;
      env.hasDesiredForward = rt.hasDesiredForward;
      env.desiredForwardX = rt.dfX; env.desiredForwardY = rt.dfY; env.desiredForwardZ = rt.dfZ;
      env.desiredForwardRateRadPerS = rt.desiredRateRadPerS;
      req.transitDvKmps = rt.stepDvKmps;
      req.transitKm = rt.stepKm;
      req.transitHeatKW = rt.stepHeatKW;
      req.reservedKg = transitReserveKg(rt, t);
      propellantGate(res, worstKg, t, gate, req.reservedKg);
      env.thrustScale = gate.thrust;
      env.angularScale = gate.angular;
      const h = stepShip(ship, input, env, FIXED_DT);
      if (h) {
        hit = h.body.id;
        break;
      }
      stepShipResources(res, ship, req, t, FIXED_DT);
      updateShipAbsolute(ship);
      if (res.heat01 > peakHeat) peakHeat = res.heat01;
      if (rt.speedKmps > peakV) peakV = rt.speedKmps;
      if (res.ordinaryKg < minOrd) minOrd = res.ordinaryKg;
      for (const b of bodies) {
        const d = Math.hypot(ship.absPosKm.x - b.pos[0], ship.absPosKm.y - b.pos[1], ship.absPosKm.z - b.pos[2]);
        if (d < minBody[b.id]) minBody[b.id] = d;
      }
    }
    if (hit || endStep >= 0 || (engageStep < 0 && tick >= holdTicks && rt.ev.refused > 0)) break;
  }
  const last = planOut.legs[planOut.legCount - 1];
  if (last && tgtPos) aim.set(tgtPos[0] + last.ox, tgtPos[1] + last.oy, tgtPos[2] + last.oz);
  return {
    frameHz: hz,
    frames,
    steps,
    droppedS: dropped / TICKS_PER_S,
    plan: planOut,
    engaged: engageStep >= 0,
    refusal: rt.ev.refusal,
    etaS: engageStep >= 0 && endStep >= 0 ? (endStep - engageStep) * FIXED_DT : null,
    fuelKg: total0 - res.ordinaryKg - res.protectedKg,
    transitKg: res.meter.transitKg,
    thrustKg: res.meter.thrustKg,
    ordinaryKg: res.ordinaryKg,
    protectedKg: res.protectedKg,
    minOrdinaryKg: minOrd,
    peakHeat01: peakHeat,
    endHeat01: res.heat01,
    peakKmps: peakV,
    endSpeedKmps: rt.speedKmps,
    shipSpeedMps: ship.velKmps.length() * 1000,
    finalAimDistKm: target ? aim.distanceTo(ship.absPosKm) : 0,
    minBodyDistKm: minBody,
    hit,
    phaseAt,
    tapS,
    speedAtTapKmps: speedAtTap,
    events: { arrived: rt.ev.arrived, aborted: rt.ev.aborted, legDone: rt.ev.legDone, stoppedShort: rt.ev.stoppedShort, proximity: rt.ev.proximity },
    legCount: planOut.legCount,
    endPhase: rt.phase,
    final: { posKm: ship.absPosKm.toArray(), speedKmps: rt.speedKmps, ordinaryKg: res.ordinaryKg, protectedKg: res.protectedKg, heat01: res.heat01 },
  };
}
