/**
 * Transit drive (docs/M3_GAMEPLAY_PLAN.md §5.5): one pure model on the fixed step. The same
 * speed law (`transitLaw`) flies the live leg and the predictor, so fuel, heat and ETA agree
 * by construction. Transit is a scalar speed along the ship's nose, added to stepShip's
 * velocity; fuel per km/s of delivered speed change plus per km covered, braking and distance
 * fuel reserved before any speed is bought (the law sees leg fuel minus perKm × aim distance).
 */
import { Vector3 } from "three";
import { frameOriginKm, resolveFramePositionKm, type FrameId } from "@/sim/frames";
import { heatAfter, throttleScale, type ShipResourceState } from "./resourceStep";
import type { ResourceTuning } from "./resourceTuning";
import type { ShipState } from "./shipState";

/** Drive acceleration, km/s² (fiction: inertial compensation). */
export const TRANSIT_ACCEL_KMPS2 = 800;
export const TRANSIT_SPOOL_TIME_S = 3.0;
/** Steering rate multiplier while the drive carries speed. */
export const TRANSIT_STEER_MULT = 0.6;
const AUTOPILOT_ROT_RATE = 3.0;
const SPOOL_TRACKING_ROT_RATE = 4.0;
/** Yaw/pitch input above this takes the ship off autopilot. */
const STEER_ABORT_INPUT = 0.2;
/** Hard safety sphere: radius + max(2 % R, 200 km) (the pre-M3.5 auto-brake standoff); routes add the atmosphere (`hazardKm`). */
const HARD_STANDOFF_FRAC = 0.02;
const HARD_STANDOFF_MIN_KM = 200;
/** A final-leg brake residue up to FINAL_CREEP_MAX_KM is crept (≤ FINAL_CREEP_KMPS) to within FINAL_PRECISION_KM. */
const FINAL_PRECISION_KM = 0.1;
const FINAL_CREEP_KMPS = 2;
const FINAL_CREEP_MAX_KM = 5;
/** Proximity braking aims this fraction short of the hard sphere. */
const OBSTRUCTION_MARGIN = 0.97;
const MAX_LEGS = 2;
/** A target point this close above a body's surface (or atmosphere top) is inside it, km. */
const TARGET_INSIDE_MARGIN_KM = 20;
/** Field arrival (D11): a body with an anchored field is reached in its field from beyond this, km. */
export const FIELD_ARRIVAL_SWITCH_KM = 50_000;
/** ...arriving this far from the field anchor on the approach side, inside its full-density core, km. */
export const FIELD_ARRIVAL_DEPTH_KM = 1_500;

export type TransitPhase = "idle" | "spooling" | "accelerating" | "coasting" | "decelerating";

export type TransitTarget = {
  id: string;
  name: string;
  /** LIVE array (body / field anchor) in system km, or relative to `frameId` when set. */
  positionKm: readonly number[];
  frameId?: FrameId;
  /** Stand-off from the target point, km, on the approach side. */
  arrivalOffsetKm?: number;
  /** A body with an anchored asteroid field: from beyond `FIELD_ARRIVAL_SWITCH_KM` the trip ends in the field. */
  field?: TransitFieldArrival;
};

export interface TransitFieldArrival {
  /** LIVE field anchor, system km. */
  positionKm: readonly number[];
  name: string;
}

/** A celestial body as transit sees it: LIVE position array (ephemeris rewrites it in place). */
export interface TransitBody {
  id: string;
  name: string;
  pos: readonly number[];
  radiusKm: number;
  /** Top of the atmosphere above `radiusKm`, km (0 when airless). */
  atmosphereTopKm?: number;
}

/** A leg's aim: a live base point (optionally frame-relative) plus a fixed system-axes offset. */
export interface TransitLeg {
  base: readonly number[];
  frameId: FrameId | undefined;
  ox: number;
  oy: number;
  oz: number;
  /** Planned length at planning time, km (budget split for later legs). */
  plannedKm: number;
}

export interface TransitInputs {
  owned: boolean;
  /** Mining holds the drive idle. */
  blocked: boolean;
  /** max(|yaw|, |pitch|) of this frame's input. */
  steer: number;
  target: TransitTarget | null;
  coolingMult: number;
  /** Aim-point velocity relative to the ship's frame, km per EXECUTED second (prediction only). */
  aimVelX: number;
  aimVelY: number;
  aimVelZ: number;
  /** Dev speed override: transit is neither billed nor capped by fuel. */
  freeFlight: boolean;
}

/** Refusal for a target the ship already stands at (the HUD hides it; no toast). */
export const ALREADY_THERE = "Already at the destination";
/** A full-power torch can't light inside air (VFX plan §5.6.4): climb above the drive's fade first. */
export const IN_ATMOSPHERE = "Climb out of the atmosphere";

/** A clearance waypoint may lengthen the route at most this much over the direct line (+ 10 clearance radii, so a short hop round a body keeps working: M3.5's standoff → lunar field hop). */
const ROUTE_MAX_DETOUR = 1.5;

export interface TransitEvents {
  refused: number;
  refusal: string | null;
  arrived: number;
  aborted: number;
  autopilotOff: number;
  proximity: number;
  proximityId: string;
  legDone: number;
  stoppedShort: number;
  stopReason: string;
}

export interface TransitPlan {
  ok: boolean;
  reason: string | null;
  manual: boolean;
  legCount: number;
  legs: TransitLeg[];
  viaBodyId: string | null;
  viaName: string | null;
  /** The route ends in the target body's asteroid field (D11), not at the body's standoff. */
  fieldArrival: boolean;
  etaS: number;
  /** Total propellant the route spends, kg (ordinary first; braking may fall back to protected). */
  fuelKg: number;
  arrivalOrdinaryKg: number;
  protectedKg: number;
  peakKmps: number;
  peakHeat01: number;
  endHeat01: number;
  /** A leg's peak was capped by fuel (coast phase): slower than the ideal flip-and-burn. */
  fuelLimited: boolean;
  idealEtaS: number;
  idealFuelKg: number;
  /** Lower-bound fuel the route needs (distance fuel + the slowest allowed peak), kg; 0 until predicted. */
  needKg: number;
  directKm: number;
  pathKm: number;
  steps: number;
}

export interface TransitRuntime {
  phase: TransitPhase;
  /** Written by the keyboard; tap = pressed while the drive carries speed. */
  keyHeld: boolean;
  keyTapped: boolean;
  /** A refusal waits for the key to be released before the next attempt. */
  awaitRelease: boolean;
  spoolSteps: number;
  /** Next-leg spool runs without the key. */
  autoSpool: boolean;
  speedKmps: number;
  velX: number;
  velY: number;
  velZ: number;
  autopilot: boolean;
  /** Abort / manual brake: decelerate to rest whatever the law says. */
  stopping: boolean;
  target: TransitTarget | null;
  legs: TransitLeg[];
  legCount: number;
  legIndex: number;
  legBudgetKg: number;
  legSpentKg: number;
  legPeakKmps: number;
  legProximitySeen: boolean;
  /** The leg has started braking (phase label and re-acceleration hysteresis). */
  braking: boolean;
  /** Braking within the arrival tolerance: brake to rest, then the leg counts as arrived. */
  arriving: boolean;
  viaBodyId: string | null;
  /** The route ends in the target body's field: that body is an obstacle, not the destination. */
  fieldArrival: boolean;
  /** Current aim (system km) and distance to it, refreshed each burn step. */
  aimX: number;
  aimY: number;
  aimZ: number;
  distKm: number;
  hasDesiredForward: boolean;
  dfX: number;
  dfY: number;
  dfZ: number;
  desiredRateRadPerS: number;
  spoolFx: number;
  spoolFy: number;
  spoolFz: number;
  /** This step's delivered speed change (km/s) and heat input (kW): the resource step bills them. */
  stepDvKmps: number;
  /** Distance the drive carries the ship this step, km (billed per `transitKgPerKm`). */
  stepKm: number;
  stepHeatKW: number;
  totalKg: number;
  bodies: readonly TransitBody[];
  ev: TransitEvents;
}

function createLeg(): TransitLeg {
  return { base: [0, 0, 0], frameId: undefined, ox: 0, oy: 0, oz: 0, plannedKm: 0 };
}

export function createTransitPlan(): TransitPlan {
  return {
    ok: false, reason: null, manual: false, legCount: 0, legs: [createLeg(), createLeg()], viaBodyId: null, viaName: null, fieldArrival: false,
    etaS: 0, fuelKg: 0, arrivalOrdinaryKg: 0, protectedKg: 0, peakKmps: 0, peakHeat01: 0, endHeat01: 0, fuelLimited: false,
    idealEtaS: 0, idealFuelKg: 0, needKg: 0, directKm: 0, pathKm: 0, steps: 0,
  };
}

export function createTransitInputs(): TransitInputs {
  return { owned: false, blocked: false, steer: 0, target: null, coolingMult: 1, aimVelX: 0, aimVelY: 0, aimVelZ: 0, freeFlight: false };
}

export function createTransitRuntime(): TransitRuntime {
  return {
    phase: "idle", keyHeld: false, keyTapped: false, awaitRelease: false, spoolSteps: 0, autoSpool: false,
    speedKmps: 0, velX: 0, velY: 0, velZ: 0, autopilot: false, stopping: false, target: null,
    legs: [createLeg(), createLeg()], legCount: 0, legIndex: 0, legBudgetKg: 0, legSpentKg: 0, legPeakKmps: 0, legProximitySeen: false, braking: false, arriving: false,
    viaBodyId: null, fieldArrival: false, aimX: 0, aimY: 0, aimZ: 0, distKm: 0,
    hasDesiredForward: false, dfX: 0, dfY: 0, dfZ: 1, desiredRateRadPerS: 0, spoolFx: 0, spoolFy: 0, spoolFz: 1,
    stepDvKmps: 0, stepKm: 0, stepHeatKW: 0, totalKg: 0, bodies: [],
    ev: { refused: 0, refusal: null, arrived: 0, aborted: 0, autopilotOff: 0, proximity: 0, proximityId: "", legDone: 0, stoppedShort: 0, stopReason: "" },
  };
}

/** Back to idle at rest (death, teleport, drive removed). Never used to hide a running leg's speed. */
export function resetTransit(rt: TransitRuntime): void {
  rt.phase = "idle";
  rt.spoolSteps = 0;
  rt.autoSpool = false;
  rt.speedKmps = rt.velX = rt.velY = rt.velZ = 0;
  rt.autopilot = false;
  rt.stopping = false;
  rt.keyTapped = false;
  rt.awaitRelease = rt.keyHeld;
  rt.legCount = 0;
  rt.legIndex = 0;
  rt.hasDesiredForward = false;
  rt.desiredRateRadPerS = 0;
  rt.stepDvKmps = rt.stepKm = rt.stepHeatKW = 0;
}

export const spoolStepsFor = (dt: number): number => Math.round(TRANSIT_SPOOL_TIME_S / dt);

/** Distance fuel of a stop from `v` (continuous, so it bounds the discrete stop), kg. */
function stopDistKg(v: number, t: Readonly<ResourceTuning>): number {
  return ((v * v) / (2 * TRANSIT_ACCEL_KMPS2)) * t.transitKgPerKm;
}

/** Propellant the leg must keep for braking from `speedKmps`, kg (manoeuvring thrust may not touch it). */
export function transitReserveKg(rt: Readonly<TransitRuntime>, t: Readonly<ResourceTuning>): number {
  if (rt.speedKmps <= 0) return 0;
  const distKg = rt.autopilot ? rt.distKm * t.transitKgPerKm : stopDistKg(rt.speedKmps, t);
  return rt.speedKmps * t.transitKgPerKmps * (1 + t.transitReserveMargin) + distKg;
}

/** Distance covered while braking from `v` at `q` km/s per step (exact for the discrete step). */
export function brakeDistKm(v: number, q: number, dt: number): number {
  if (v <= 0) return 0;
  const n = Math.ceil(v / q - 1e-6) - 1;
  return n > 0 ? dt * (n * v - (q * n * (n + 1)) / 2) : 0;
}

/** Set when the last `transitLaw` call wanted more speed than the fuel reserve allows. */
let _lawFuelCapped = false;

/**
 * The speed law, per fixed step: accelerate while the remaining distance still allows the
 * discrete stop AND the fuel left after this step still pays for that stop (plus margin);
 * else coast; else brake. `fuelKg` = ordinary fuel the leg may still spend; `accelScale` is
 * the heat throttle (braking is never throttled). Returns the new speed, km/s.
 */
export function transitLaw(dKm: number, v: number, fuelKg: number, accelScale: number, braking: boolean, t: Readonly<ResourceTuning>, dt: number): number {
  const q = TRANSIT_ACCEL_KMPS2 * dt;
  const c = t.transitKgPerKmps;
  const cap = c > 0 ? (Math.max(0, fuelKg) + c * v) / (c * (2 + t.transitReserveMargin)) : Infinity;
  const want = v + q * Math.max(0, Math.min(1, accelScale));
  const v1 = Math.min(want, cap);
  _lawFuelCapped = cap < want && accelScale > 0;
  // Once braking, re-accelerate only on real slack (a receding target), not the sub-step residue.
  const slack = braking ? 4 * v1 * dt : 0;
  if (v1 > v && dKm - v1 * dt >= brakeDistKm(v1, q, dt) + slack) return v1;
  if (v <= 0) return 0;
  if (dKm - v * dt >= brakeDistKm(v, q, dt)) return v;
  return brakeStep(v, q);
}

/** One braking step; a float residue of the summed steps snaps to rest (else it coasts at 1e-14 km/s). */
export function brakeStep(v: number, q: number): number {
  const v1 = v - q;
  return v1 > q * 1e-6 ? v1 : 0;
}

/** A braking leg this close to its aim is arriving: brake to rest (a receding aim would be chased forever). */
export function arrivalTolKm(peakKmps: number, dt: number): number {
  return Math.max(1, 3 * peakKmps * dt);
}

/** Ideal flip-and-burn fuel for a leg, kg (budget split between legs). */
function idealLegKg(dKm: number, t: Readonly<ResourceTuning>): number {
  const d = Math.max(0, dKm);
  return 2 * t.transitKgPerKmps * Math.sqrt(TRANSIT_ACCEL_KMPS2 * d) + t.transitKgPerKm * d;
}

// Step scratch (stepTransit); planning and prediction use their own (engage plans mid-step).
const _b = new Vector3();
const _c = new Vector3();
const _s = new Vector3();
const _aim = new Vector3();
const _dir = new Vector3();
const _pA = new Vector3();
const _pB = new Vector3();
const _pC = new Vector3();
const _pS = new Vector3();
const _pAim = new Vector3();
const _pDir = new Vector3();

export function resolveLegAim(leg: Readonly<TransitLeg>, out: Vector3): Vector3 {
  resolveFramePositionKm(leg.base, leg.frameId, out);
  return out.set(out.x + leg.ox, out.y + leg.oy, out.z + leg.oz);
}

function hardRadiusKm(b: Readonly<TransitBody>): number {
  return b.radiusKm + Math.max(b.radiusKm * HARD_STANDOFF_FRAC, HARD_STANDOFF_MIN_KM);
}

/** Route hazard shell: the hard sphere above the atmosphere (Earth 6,671 km, Luna 1,937 km). */
export function hazardKm(b: Readonly<TransitBody>): number {
  return hardRadiusKm(b) + (b.atmosphereTopKm ?? 0);
}

/**
 * Distance along unit `dir` from `p` to the entry of a body's hard sphere, km (Infinity if clear).
 * With `aim` (autopilot) a planned leg may descend to its lower end, so the sphere shrinks to
 * 0.99 × the nearer of ship and aim, and entries beyond the aim (`aimKm`) are not obstructions.
 */
export function obstructionKm(p: Vector3, dir: Vector3, bodies: readonly TransitBody[], skipId: string | null, hitOut?: { id: string }, aim?: Vector3, aimKm = Infinity): number {
  let best = Infinity;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    if (b.id === skipId) continue;
    const tx = b.pos[0] - p.x, ty = b.pos[1] - p.y, tz = b.pos[2] - p.z;
    const along = tx * dir.x + ty * dir.y + tz * dir.z;
    if (along <= 0) continue;
    let r = hardRadiusKm(b);
    if (aim) r = Math.min(r, 0.99 * Math.hypot(tx, ty, tz), 0.99 * Math.hypot(b.pos[0] - aim.x, b.pos[1] - aim.y, b.pos[2] - aim.z));
    const perp2 = tx * tx + ty * ty + tz * tz - along * along;
    if (perp2 > r * r) continue;
    const entry = along - Math.sqrt(r * r - perp2);
    if (entry >= aimKm) continue;
    if (entry < best) {
      best = entry;
      if (hitOut) hitOut.id = b.id;
    }
  }
  return best;
}

/** Closest distance from point c to segment s→e. */
function segDist(s: Vector3, e: Vector3, cx: number, cy: number, cz: number): number {
  const ex = e.x - s.x, ey = e.y - s.y, ez = e.z - s.z;
  const l2 = ex * ex + ey * ey + ez * ez;
  let k = l2 > 0 ? ((cx - s.x) * ex + (cy - s.y) * ey + (cz - s.z) * ez) / l2 : 0;
  k = Math.max(0, Math.min(1, k));
  return Math.hypot(s.x + ex * k - cx, s.y + ey * k - cy, s.z + ez * k - cz);
}

/**
 * Segment clearance radius (B6/B7): the hazard shell, lowered to the leg's lower end. A line may
 * descend to its lower endpoint but never below the hazard shell in between (symmetric in the ends).
 */
function clearRadiusKm(b: Readonly<TransitBody>, from: Vector3, to: Vector3): number {
  const d0 = Math.hypot(from.x - b.pos[0], from.y - b.pos[1], from.z - b.pos[2]);
  const d1 = Math.hypot(to.x - b.pos[0], to.y - b.pos[1], to.z - b.pos[2]);
  return Math.min(hazardKm(b), d0 * 0.999, d1 * 0.999);
}

/** First body (nearest the start) whose clearance sphere the segment enters, or -1. */
function firstBlocker(s: Vector3, e: Vector3, bodies: readonly TransitBody[], skipId: string | null): number {
  let hit = -1;
  let hitAlong = Infinity;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    if (b.id === skipId) continue;
    if (segDist(s, e, b.pos[0], b.pos[1], b.pos[2]) >= clearRadiusKm(b, s, e)) continue;
    const along = Math.hypot(b.pos[0] - s.x, b.pos[1] - s.y, b.pos[2] - s.z);
    if (along < hitAlong) {
      hitAlong = along;
      hit = i;
    }
  }
  return hit;
}

export function targetBodyId(target: Readonly<TransitTarget> | null): string | null {
  if (!target) return null;
  const i = target.id.indexOf(":");
  return i >= 0 && (target.id.startsWith("body:") || target.id.startsWith("star:")) ? target.id.slice(i + 1) : null;
}

/** Arrival aim for target point P seen from `from`: `offset` short of P on the approach side. */
function arrivalAim(p: Vector3, from: Vector3, offset: number, out: Vector3): boolean {
  out.copy(p);
  if (offset <= 0) return true;
  const dx = from.x - p.x, dy = from.y - p.y, dz = from.z - p.z;
  const d = Math.hypot(dx, dy, dz);
  if (d <= offset) return false;
  const k = offset / d;
  out.set(p.x + dx * k, p.y + dy * k, p.z + dz * k);
  return true;
}

function setLeg(leg: TransitLeg, base: readonly number[], frameId: FrameId | undefined, baseAbs: Vector3, aim: Vector3, plannedKm: number): void {
  leg.base = base;
  leg.frameId = frameId;
  leg.ox = aim.x - baseAbs.x;
  leg.oy = aim.y - baseAbs.y;
  leg.oz = aim.z - baseAbs.z;
  leg.plannedKm = plannedKm;
}

/**
 * Route to a target from `ship` (system km): direct, or via ONE clearance waypoint beside the
 * first body that blocks the line (each leg stops outside every body's clearance sphere).
 * No general pathfinding: a second blocker refuses. Fills `out.legs/legCount/via*`.
 */
export function planRoute(out: TransitPlan, ship: Vector3, target: Readonly<TransitTarget>, bodies: readonly TransitBody[]): boolean {
  out.legCount = 0;
  out.viaBodyId = out.viaName = null;
  let p = resolveFramePositionKm(target.positionKm, target.frameId, _pC);
  const field = target.field && p.distanceTo(ship) > FIELD_ARRIVAL_SWITCH_KM ? target.field : null;
  out.fieldArrival = !!field;
  const basePos = field ? field.positionKm : target.positionKm;
  const baseFrame = field ? undefined : target.frameId;
  if (field) p = _pC.set(field.positionKm[0], field.positionKm[1], field.positionKm[2]);
  const skip = field ? null : targetBodyId(target);
  const offset = field ? FIELD_ARRIVAL_DEPTH_KM : target.arrivalOffsetKm ?? 0;
  if (!arrivalAim(p, ship, offset, _pA) || _pA.distanceTo(ship) < 1) return refuse(out, ALREADY_THERE);
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    if (b.id === skip) continue;
    const floor = b.radiusKm + (b.atmosphereTopKm ?? 0) + TARGET_INSIDE_MARGIN_KM;
    if (Math.hypot(_pA.x - b.pos[0], _pA.y - b.pos[1], _pA.z - b.pos[2]) < floor) return refuse(out, `Target inside ${b.name}`);
  }
  out.directKm = _pA.distanceTo(ship);
  const bi = firstBlocker(ship, _pA, bodies, skip);
  if (bi < 0) {
    setLeg(out.legs[0], basePos, baseFrame, p, _pA, out.directKm);
    out.legCount = 1;
    out.pathKm = out.directKm;
    return true;
  }
  const b = bodies[bi];
  const bx = b.pos[0], by = b.pos[1], bz = b.pos[2];
  // Push sideways from the body through the closest point of the blocked line.
  _pDir.subVectors(_pA, ship);
  const l2 = _pDir.lengthSq();
  const k = l2 > 0 ? ((bx - ship.x) * _pDir.x + (by - ship.y) * _pDir.y + (bz - ship.z) * _pDir.z) / l2 : 0;
  _pB.set(ship.x + _pDir.x * k - bx, ship.y + _pDir.y * k - by, ship.z + _pDir.z * k - bz);
  if (_pB.lengthSq() < 1e-6 * b.radiusKm * b.radiusKm) {
    _pB.set(-_pDir.z, 0, _pDir.x);
    if (_pB.lengthSq() < 1e-12) _pB.set(0, 1, 0);
  }
  _pB.normalize();
  const rc = hazardKm(b);
  let second = -1;
  for (let h = rc * 1.05, i = 0; i < 40; i++, h *= 1.15) {
    _pS.set(bx + _pB.x * h, by + _pB.y * h, bz + _pB.z * h); // waypoint W
    if (!arrivalAim(p, _pS, offset, _pAim)) continue;
    const l1 = _pS.distanceTo(ship), l2k = _pAim.distanceTo(_pS);
    // MEASURED: a target behind the Moon from Earth grew this waypoint to a 1.82M km path (4.9×
    // direct) that took the whole tank. A second blocker is not routed around: refuse instead.
    if (l1 + l2k > ROUTE_MAX_DETOUR * out.directKm + 10 * rc) break;
    if (firstBlocker(ship, _pS, bodies, null) >= 0) continue;
    second = firstBlocker(_pS, _pAim, bodies, skip);
    if (second >= 0) continue;
    _pC.set(bx, by, bz);
    setLeg(out.legs[0], b.pos, undefined, _pC, _pS, l1);
    resolveFramePositionKm(basePos, baseFrame, _pC);
    setLeg(out.legs[1], basePos, baseFrame, _pC, _pAim, l2k);
    out.legCount = 2;
    out.viaBodyId = b.id;
    out.viaName = b.name;
    out.pathKm = l1 + l2k;
    return true;
  }
  if (second >= 0 && bodies[second] !== b) return refuse(out, `Blocked by ${bodies[second].name}`);
  return refuse(out, `Blocked by ${b.name}`);
}

function refuse(out: TransitPlan, reason: string): false {
  out.ok = false;
  out.reason = reason;
  return false;
}

interface LegRun {
  steps: number;
  kg: number;
  ordinaryKg: number;
  protectedKg: number;
  heat01: number;
  peakHeat01: number;
  peakKmps: number;
  fuelCapped: boolean;
  stuck: boolean;
  timedOut: boolean;
}
const _run: LegRun = { steps: 0, kg: 0, ordinaryKg: 0, protectedKg: 0, heat01: 0, peakHeat01: 0, peakKmps: 0, fuelCapped: false, stuck: false, timedOut: false };

/** Spend for prediction exactly as `spendPropellant` does (ordinary, then protected). */
function predictSpend(r: LegRun, kg: number): void {
  const o = Math.min(kg, r.ordinaryKg);
  r.ordinaryKg -= o;
  r.protectedKg = Math.max(0, r.protectedKg - (kg - o));
  r.kg += kg;
}

/**
 * One leg through the SAME step functions the live drive runs (spool heat, `transitLaw`, the
 * resource step's heat law, its spend order). Only transit loads are assumed.
 */
function rolloutLeg(r: LegRun, spoolLeft: number, dKm: number, v0: number, brakingNow: boolean, budgetKg: number, stopping: boolean, t: Readonly<ResourceTuning>, inp: Readonly<TransitInputs>, dt: number, maxSteps: number): void {
  const q = TRANSIT_ACCEL_KMPS2 * dt;
  const c = t.transitKgPerKmps;
  let spent = 0;
  for (let i = 0; i < spoolLeft; i++) {
    r.heat01 = heatAfter(r.heat01, t.transitSpoolHeatKW, t, inp.coolingMult, dt);
    if (r.heat01 > r.peakHeat01) r.peakHeat01 = r.heat01;
    r.steps++;
  }
  let d = dKm, v = v0;
  let braking = brakingNow;
  for (let n = 0; ; n++) {
    if (n >= maxSteps) {
      r.timedOut = true;
      return;
    }
    if (!stopping && braking && d <= arrivalTolKm(r.peakKmps, dt)) stopping = true;
    const fuel = inp.freeFlight ? Infinity : Math.min(r.ordinaryKg, budgetKg - spent) - t.transitKgPerKm * Math.max(0, d);
    const v1 = stopping ? brakeStep(v, q) : transitLaw(d, v, fuel, throttleScale(r.heat01, t), braking, t, dt);
    if (_lawFuelCapped && !stopping) r.fuelCapped = true;
    if (v1 < v) braking = true;
    else if (v1 > v) braking = false;
    const dv = Math.abs(v1 - v);
    if (!inp.freeFlight) {
      const kg = dv * c + v1 * dt * t.transitKgPerKm;
      spent += kg;
      predictSpend(r, kg);
    }
    r.heat01 = heatAfter(r.heat01, (t.transitBurnHeatKW * dv) / q, t, inp.coolingMult, dt);
    if (r.heat01 > r.peakHeat01) r.peakHeat01 = r.heat01;
    d -= v1 * dt;
    r.steps++;
    if (v1 > r.peakKmps) r.peakKmps = v1;
    if (v1 <= 0) {
      if (v <= 0) r.stuck = true;
      return;
    }
    v = v1;
  }
}

/** Ordinary fuel leg `i` may spend: remaining ordinary split by ideal cost over the legs left. */
function legBudget(ordinaryKg: number, dNow: number, legs: readonly TransitLeg[], i: number, n: number, t: Readonly<ResourceTuning>): number {
  let sum = idealLegKg(dNow, t);
  const own = sum;
  for (let j = i + 1; j < n; j++) sum += idealLegKg(legs[j].plannedKm, t);
  return sum > 0 ? (ordinaryKg * own) / sum : ordinaryKg;
}

const _pVel = new Vector3();

/**
 * Predict the rest of a route from a state: current leg `legIndex` at `dKm`/`v0` with
 * `spoolLeft` spool steps still to run, then every later leg (spool + burn). Moving aims use
 * a 3-pass intercept on the aim velocity. Fills fuel/ETA/heat/balance; `ok` false with a
 * reason when a leg cannot finish within `transitMaxTripS`.
 */
export function predictRoute(
  out: TransitPlan, ship: Vector3, legIndex: number, spoolLeft: number, v0: number, braking: boolean, stopping: boolean,
  budgetLeftKg: number, res: { ordinaryKg: number; protectedKg: number; heat01: number },
  inp: Readonly<TransitInputs>, t: Readonly<ResourceTuning>, dt: number,
): boolean {
  const maxSteps = Math.ceil(t.transitMaxTripS / dt);
  const ss = spoolStepsFor(dt);
  _pVel.set(inp.aimVelX, inp.aimVelY, inp.aimVelZ);
  // Cheap range bound before the rollout: no leg can beat d / (fuel-capped peak speed).
  let dMax = 0, dSum = 0;
  for (let i = legIndex; i < out.legCount; i++) {
    dMax = Math.max(dMax, out.legs[i].plannedKm);
    dSum += out.legs[i].plannedKm;
  }
  out.needKg = inp.freeFlight ? 0 : routeNeedKg(out.legs, legIndex, out.legCount, t);
  const speedKg = res.ordinaryKg - t.transitKgPerKm * dSum;
  const vMax = inp.freeFlight || t.transitKgPerKmps <= 0 ? Infinity : speedKg / (t.transitKgPerKmps * (2 + t.transitReserveMargin));
  if (legIndex === 0 && v0 === 0 && (vMax <= 0 || dMax / vMax > 1.1 * t.transitMaxTripS)) return rangeRefusal(out, res.ordinaryKg, t);
  let eta = 0;
  let r = _run;
  // The final leg's aim moves; earlier legs are clearance points riding the blocker.
  for (let pass = 0; pass < 3; pass++) {
    r = resetRun(res);
    eta = 0;
    _pS.copy(ship);
    for (let i = legIndex; i < out.legCount; i++) {
      resolveLegAim(out.legs[i], _pAim);
      if (i === out.legCount - 1 && pass > 0) _pAim.addScaledVector(_pVel, out.etaS);
      const d = _pAim.distanceTo(_pS);
      const first = i === legIndex;
      const budget = first && budgetLeftKg >= 0 ? Math.min(budgetLeftKg, r.ordinaryKg) : legBudget(r.ordinaryKg, d, out.legs, i, out.legCount, t);
      const before = r.steps;
      rolloutLeg(r, first ? spoolLeft : ss, d, first ? v0 : 0, first && braking, budget, first && stopping, t, inp, dt, maxSteps);
      eta += (r.steps - before) * dt;
      if (r.timedOut || r.stuck) break;
      _pS.copy(_pAim);
    }
    out.etaS = eta;
    if (_pVel.lengthSq() === 0 || r.timedOut || r.stuck) break;
  }
  out.steps = r.steps;
  out.fuelKg = r.kg;
  out.arrivalOrdinaryKg = r.ordinaryKg;
  out.protectedKg = r.protectedKg;
  out.peakKmps = r.peakKmps;
  out.peakHeat01 = r.peakHeat01;
  out.endHeat01 = r.heat01;
  out.fuelLimited = r.fuelCapped;
  if (r.stuck) return refuse(out, res.heat01 >= 1 ? "Drive too hot" : NEEDS_FUEL);
  if (r.timedOut) return rangeRefusal(out, res.ordinaryKg, t);
  out.ok = true;
  out.reason = null;
  return true;
}

/**
 * Fuel a route needs, kg: each leg's distance fuel + a coast peak of d/T, scaled up by the share
 * `legBudget` gives it (fuel splits by ideal cost, so a long final leg gets less than its need).
 */
function routeNeedKg(legs: readonly TransitLeg[], from: number, n: number, t: Readonly<ResourceTuning>): number {
  let sum = 0;
  for (let i = from; i < n; i++) sum += idealLegKg(legs[i].plannedKm, t);
  let need = 0;
  for (let i = from; i < n; i++) {
    const d = legs[i].plannedKm;
    const own = idealLegKg(d, t);
    const legNeed = t.transitKgPerKm * d + t.transitKgPerKmps * (2 + t.transitReserveMargin) * (d / t.transitMaxTripS);
    if (own > 0) need = Math.max(need, (legNeed * sum) / own);
  }
  return Math.ceil(need);
}

/** Refusal texts for a route the fuel cannot fly (the panel shows `needKg` against the tank). */
export const TANK_TOO_SMALL = "Tank too small";
export const NEEDS_FUEL = "Not enough fuel";

/** Max-trip refusal worded by cause: a full tank cannot fix a route that needs more than the tank holds. */
function rangeRefusal(out: TransitPlan, ordinaryKg: number, t: Readonly<ResourceTuning>): false {
  if (out.needKg > t.tankKg || ordinaryKg >= t.tankKg - 1e-6) return refuse(out, TANK_TOO_SMALL);
  return refuse(out, NEEDS_FUEL);
}

function resetRun(res: { ordinaryKg: number; protectedKg: number; heat01: number }): LegRun {
  const r = _run;
  r.steps = 0; r.kg = 0; r.ordinaryKg = res.ordinaryKg; r.protectedKg = res.protectedKg; r.heat01 = res.heat01;
  r.peakHeat01 = res.heat01; r.peakKmps = 0; r.fuelCapped = false; r.stuck = false; r.timedOut = false;
  return r;
}

/** Ideal (unlimited fuel) ETA and fuel of the planned legs, for the "slow leg" comparison. */
function fillIdeal(out: TransitPlan, t: Readonly<ResourceTuning>, dt: number): void {
  let eta = 0, kg = 0;
  for (let i = 0; i < out.legCount; i++) {
    eta += TRANSIT_SPOOL_TIME_S + 2 * Math.sqrt(out.legs[i].plannedKm / TRANSIT_ACCEL_KMPS2) + dt;
    kg += idealLegKg(out.legs[i].plannedKm, t);
  }
  out.idealEtaS = eta;
  out.idealFuelKg = kg;
}

/** Plan + predict a new trip from rest (engage, and the pre-engage preview). */
export function planTransit(
  out: TransitPlan, ship: Vector3, target: Readonly<TransitTarget> | null, bodies: readonly TransitBody[],
  res: Readonly<ShipResourceState>, inp: Readonly<TransitInputs>, t: Readonly<ResourceTuning>, dt: number,
): boolean {
  out.ok = false;
  out.reason = null;
  out.manual = !target;
  out.legCount = 0;
  out.viaBodyId = out.viaName = null;
  out.fieldArrival = false;
  out.etaS = out.fuelKg = out.peakKmps = out.needKg = 0;
  out.arrivalOrdinaryKg = res.ordinaryKg;
  out.protectedKg = res.protectedKg;
  out.peakHeat01 = out.endHeat01 = res.heat01;
  out.fuelLimited = false;
  if (res.ordinaryKg <= 0 && !inp.freeFlight) return refuse(out, "No fuel (reserve is for manoeuvring)");
  if (res.drive.powerFrac < 1 && !inp.freeFlight) return refuse(out, IN_ATMOSPHERE);
  if (!target) {
    out.ok = true;
    return true;
  }
  if (!planRoute(out, ship, target, bodies)) return false;
  fillIdeal(out, t, dt);
  return predictRoute(out, ship, 0, spoolStepsFor(dt), 0, false, false, -1, res, inp, t, dt);
}

/** Live preview while a leg runs (spool or burn): the rest of the route from the runtime state. */
export function predictFromRuntime(out: TransitPlan, rt: Readonly<TransitRuntime>, ship: Vector3, res: Readonly<ShipResourceState>, inp: Readonly<TransitInputs>, t: Readonly<ResourceTuning>, dt: number): boolean {
  out.manual = !rt.autopilot;
  out.legCount = rt.legCount;
  out.viaBodyId = rt.viaBodyId;
  out.fieldArrival = rt.fieldArrival;
  for (let i = 0; i < rt.legCount; i++) Object.assign(out.legs[i], rt.legs[i]);
  if (!rt.autopilot || rt.legCount === 0) {
    out.ok = true;
    out.reason = null;
    out.etaS = rt.speedKmps / (TRANSIT_ACCEL_KMPS2);
    out.fuelKg = rt.speedKmps * t.transitKgPerKmps + stopDistKg(rt.speedKmps, t);
    out.arrivalOrdinaryKg = Math.max(0, res.ordinaryKg - out.fuelKg);
    out.protectedKg = res.protectedKg;
    return true;
  }
  const spoolLeft = rt.phase === "spooling" ? Math.max(0, spoolStepsFor(dt) - rt.spoolSteps) : 0;
  const budget = rt.phase === "spooling" ? -1 : Math.max(0, rt.legBudgetKg - rt.legSpentKg);
  // B8: a spool starts from rest; the finished leg's braking flags must not reach the rollout.
  const burning = rt.phase !== "spooling";
  return predictRoute(out, ship, rt.legIndex, spoolLeft, rt.speedKmps, burning && rt.braking, burning && (rt.stopping || rt.arriving), budget, res, inp, t, dt);
}

// ── The live step ─────────────────────────────────────────────────────────────

const _plan = createTransitPlan();
const _hit = { id: "" };

function refuseEngage(rt: TransitRuntime, reason: string): void {
  rt.ev.refused++;
  rt.ev.refusal = reason;
  rt.awaitRelease = true;
}

function beginSpool(rt: TransitRuntime, ship: Readonly<ShipState>, auto: boolean): void {
  rt.phase = "spooling";
  rt.spoolSteps = 0;
  rt.autoSpool = auto;
  rt.braking = false;
  rt.arriving = false;
  rt.spoolFx = ship.forward.x;
  rt.spoolFy = ship.forward.y;
  rt.spoolFz = ship.forward.z;
}

function engage(rt: TransitRuntime, ship: Readonly<ShipState>, inp: Readonly<TransitInputs>, res: Readonly<ShipResourceState>, t: Readonly<ResourceTuning>, dt: number): void {
  if (!planTransit(_plan, _s, inp.target, rt.bodies, res, inp, t, dt)) {
    refuseEngage(rt, _plan.reason ?? "Transit refused");
    return;
  }
  rt.target = inp.target;
  rt.autopilot = !!inp.target;
  rt.stopping = false;
  rt.legCount = _plan.legCount;
  rt.legIndex = 0;
  rt.viaBodyId = _plan.viaBodyId;
  rt.fieldArrival = _plan.fieldArrival;
  for (let i = 0; i < _plan.legCount && i < MAX_LEGS; i++) Object.assign(rt.legs[i], _plan.legs[i]);
  rt.ev.refusal = null;
  beginSpool(rt, ship, false);
}

function beginLeg(rt: TransitRuntime, res: Readonly<ShipResourceState>, t: Readonly<ResourceTuning>): void {
  rt.phase = "accelerating";
  rt.legSpentKg = 0;
  rt.legPeakKmps = 0;
  rt.legProximitySeen = false;
  rt.braking = false;
  rt.arriving = false;
  if (!rt.autopilot) {
    rt.legBudgetKg = Infinity;
    return;
  }
  resolveLegAim(rt.legs[rt.legIndex], _aim);
  rt.legBudgetKg = legBudget(res.ordinaryKg, _aim.distanceTo(_s), rt.legs, rt.legIndex, rt.legCount, t);
}

/** Smoothstep slerp of the spool-start nose toward the aim, written as the heading override. */
function spoolAlign(rt: TransitRuntime, dt: number): void {
  _dir.subVectors(_aim, _s);
  if (_dir.lengthSq() === 0) return;
  _dir.normalize();
  _b.set(rt.spoolFx, rt.spoolFy, rt.spoolFz);
  const tr = Math.min(1, rt.spoolSteps / Math.max(1, spoolStepsFor(dt)));
  const k = tr * tr * (3 - 2 * tr);
  const dot = Math.max(-1, Math.min(1, _b.dot(_dir)));
  const ang = Math.acos(dot);
  if (dot > 0.9999 || Math.sin(ang) < 1e-6) _c.copy(_dir);
  else {
    const s = Math.sin(ang);
    _c.copy(_b).multiplyScalar(Math.sin((1 - k) * ang) / s).addScaledVector(_dir, Math.sin(k * ang) / s).normalize();
  }
  rt.hasDesiredForward = true;
  rt.dfX = _c.x;
  rt.dfY = _c.y;
  rt.dfZ = _c.z;
  rt.desiredRateRadPerS = SPOOL_TRACKING_ROT_RATE;
}

/** Leg over at rest. True when another leg follows (the caller starts its spool). */
function endLeg(rt: TransitRuntime, arrivedAtAim: boolean): boolean {
  rt.speedKmps = rt.velX = rt.velY = rt.velZ = 0;
  if (rt.autopilot && !rt.stopping && arrivedAtAim && rt.legIndex + 1 < rt.legCount) {
    rt.legIndex++;
    rt.ev.legDone++;
    return true;
  }
  if (rt.autopilot && !rt.stopping) {
    if (arrivedAtAim) rt.ev.arrived++;
    else rt.ev.stoppedShort++;
  }
  rt.phase = "idle";
  rt.awaitRelease = rt.keyHeld;
  rt.autopilot = false;
  rt.stopping = false;
  rt.legCount = 0;
  rt.hasDesiredForward = false;
  return false;
}

/**
 * One fixed step, BEFORE `stepShip` (which adds `vel*` to the position). Sets `stepDvKmps` /
 * `stepHeatKW` for the resource step that follows. No allocation.
 */
export function stepTransit(rt: TransitRuntime, ship: Readonly<ShipState>, inp: Readonly<TransitInputs>, res: Readonly<ShipResourceState>, t: Readonly<ResourceTuning>, dt: number): void {
  rt.stepDvKmps = 0;
  rt.stepKm = 0;
  rt.stepHeatKW = 0;
  const tap = rt.keyTapped;
  rt.keyTapped = false;
  if (!inp.owned) {
    if (rt.phase !== "idle") resetTransit(rt);
    return;
  }
  frameOriginKm(ship.frameId, _s).add(ship.posKm);

  if (rt.phase === "idle") {
    rt.hasDesiredForward = false;
    if (!rt.keyHeld) rt.awaitRelease = false;
    else if (!rt.awaitRelease && !inp.blocked) engage(rt, ship, inp, res, t, dt);
    if (rt.phase === "idle") return;
  }

  if (rt.phase === "spooling") {
    if ((!rt.autoSpool && !rt.keyHeld) || (rt.autoSpool && tap)) {
      if (rt.autoSpool) rt.ev.aborted++;
      endLegAbort(rt);
      return;
    }
    rt.spoolSteps++;
    rt.stepHeatKW = t.transitSpoolHeatKW;
    if (rt.autopilot) {
      resolveLegAim(rt.legs[rt.legIndex], _aim);
      rt.aimX = _aim.x; rt.aimY = _aim.y; rt.aimZ = _aim.z;
      rt.distKm = _aim.distanceTo(_s);
      spoolAlign(rt, dt);
    } else rt.hasDesiredForward = false;
    if (rt.spoolSteps >= spoolStepsFor(dt)) beginLeg(rt, res, t);
    return;
  }

  // ── Burn phases ──
  if (tap) {
    if (rt.autopilot) {
      rt.autopilot = false;
      rt.stopping = true;
      rt.ev.aborted++;
    } else rt.stopping = !rt.stopping;
  }
  if (rt.autopilot && inp.steer > STEER_ABORT_INPUT) {
    rt.autopilot = false;
    if (rt.phase === "decelerating") rt.stopping = true;
    rt.ev.autopilotOff++;
  }
  _dir.copy(ship.forward);
  if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, 1);
  _dir.normalize();
  let d = Infinity;
  if (rt.autopilot) {
    resolveLegAim(rt.legs[rt.legIndex], _aim);
    rt.aimX = _aim.x; rt.aimY = _aim.y; rt.aimZ = _aim.z;
    d = _aim.distanceTo(_s);
    rt.distKm = d;
  }
  const obs = rt.autopilot
    ? obstructionKm(_s, _dir, rt.bodies, rt.fieldArrival ? null : targetBodyId(rt.target), _hit, _aim, d) * OBSTRUCTION_MARGIN
    : obstructionKm(_s, _dir, rt.bodies, null, _hit) * OBSTRUCTION_MARGIN;
  const dEff = Math.min(d, obs);
  const v = rt.speedKmps;
  const q = TRANSIT_ACCEL_KMPS2 * dt;
  // Manual flight has no aim: it reserves its stop's distance fuel and brakes once ordinary fuel
  // only pays the stop (coasting bills per km), so the protected allowance stays untouched.
  if (!rt.autopilot && !inp.freeFlight && v > 0 && res.ordinaryKg <= v * t.transitKgPerKmps + stopDistKg(v, t)) rt.stopping = true;
  const fuel = inp.freeFlight ? Infinity : Math.min(res.ordinaryKg, rt.legBudgetKg - rt.legSpentKg) - (rt.autopilot ? t.transitKgPerKm * d : stopDistKg(v, t));
  if (rt.autopilot && !rt.stopping && rt.braking && d <= arrivalTolKm(rt.legPeakKmps, dt)) rt.arriving = true;
  let v1 = rt.stopping || rt.arriving ? brakeStep(v, q) : transitLaw(dEff, v, fuel, throttleScale(res.heat01, t), rt.braking, t, dt);
  // Discrete braking parks the ship up to the arrival tolerance short (measured 1.9 km at the survey
  // site: outside its 2 km G range), so the final leg creeps the rest.
  if (v1 <= 0 && rt.autopilot && !rt.stopping && rt.legIndex + 1 >= rt.legCount && d > FINAL_PRECISION_KM && d <= Math.min(FINAL_CREEP_MAX_KM, arrivalTolKm(rt.legPeakKmps, dt)) && obs >= d && fuel > 0) v1 = Math.min(FINAL_CREEP_KMPS, d / dt);
  if (!rt.stopping && obs < d && v1 < v && !rt.legProximitySeen && transitLaw(d, v, fuel, 1, rt.braking, t, dt) >= v) {
    rt.legProximitySeen = true;
    rt.ev.proximity++;
    rt.ev.proximityId = _hit.id;
  }
  const dv = Math.abs(v1 - v);
  rt.speedKmps = v1;
  rt.stepDvKmps = dv;
  rt.stepKm = v1 * dt;
  rt.stepHeatKW = (t.transitBurnHeatKW * dv) / q;
  const stepKg = dv * t.transitKgPerKmps + rt.stepKm * t.transitKgPerKm;
  rt.legSpentKg += stepKg;
  rt.totalKg += stepKg;
  if (v1 > rt.legPeakKmps) rt.legPeakKmps = v1;
  if (v1 < v) rt.braking = true;
  else if (v1 > v) rt.braking = false;
  rt.phase = v1 > v ? "accelerating" : v1 < v || rt.braking ? "decelerating" : "coasting";
  rt.velX = _dir.x * v1;
  rt.velY = _dir.y * v1;
  rt.velZ = _dir.z * v1;
  if (rt.autopilot) {
    _dir.subVectors(_aim, _s);
    if (_dir.lengthSq() > 0) {
      _dir.normalize();
      rt.hasDesiredForward = true;
      rt.dfX = _dir.x; rt.dfY = _dir.y; rt.dfZ = _dir.z;
      rt.desiredRateRadPerS = AUTOPILOT_ROT_RATE;
    }
  } else rt.hasDesiredForward = false;
  if (v1 <= 0) {
    // This step moves nothing more: `d` is the final miss distance.
    const arrived = rt.arriving || d <= arrivalTolKm(rt.legPeakKmps, dt);
    if (!arrived) rt.ev.stopReason = obs < d ? "Obstacle ahead" : throttleScale(res.heat01, t) <= 0 ? "Drive too hot" : "Out of fuel";
    if (endLeg(rt, arrived)) beginSpool(rt, ship, true);
  }
}

function endLegAbort(rt: TransitRuntime): void {
  rt.phase = "idle";
  rt.awaitRelease = rt.keyHeld;
  rt.spoolSteps = 0;
  rt.autoSpool = false;
  rt.autopilot = false;
  rt.stopping = false;
  rt.legCount = 0;
  rt.hasDesiredForward = false;
}
