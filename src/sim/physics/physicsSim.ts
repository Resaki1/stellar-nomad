/** Scripted flight through the real stepShip + a PRIVATE near field, no rendering. Backs `__test.physics.simulate`. */
import { Quaternion, Vector3 } from "three";
import { SYSTEM_FRAME_ID } from "@/sim/frames";
import { getFlightTuning } from "@/sim/ship/flightTuning";
import type { FlightSegment } from "@/sim/ship/flightSim";
import { FIXED_DT } from "@/sim/ship/shipConstants";
import { createShipInput } from "@/sim/ship/shipInput";
import { createShipState } from "@/sim/ship/shipState";
import { createShipStepEnv, shipBodyAxes, stepShip, type ShipStepEnv } from "@/sim/ship/stepShip";
import { NearField, nearField, physicsWorldConfig, type NearFieldColliderId, type StepOwner } from "./nearField";
import { loadRapierFactory } from "./rapierBackend";
import { asteroidColliderShape, ensureModelHull, getAsteroidColliderModel } from "./asteroidColliders";
import { ImpactTracker, impactDamageFractionOf } from "./impactDamage";
import { getPhysicsTuning } from "./physicsTuning";
import type { ColliderShape, ShapeBounds } from "./types";

type V3 = [number, number, number];

export type RockSpec =
  | { kind: "ball"; radiusM: number; posM: V3 }
  | { kind: "box"; half: V3; posM: V3; quat?: [number, number, number, number] }
  /** `points` (local m, flat xyz) or a generated lumpy hull of `radiusM`. */
  | { kind: "hull"; posM: V3; points?: number[]; radiusM?: number; lumps?: number; seed?: number; quat?: [number, number, number, number] }
  /** A registered asteroid model's hull at `radiusM`, rotated like a rendered instance with quaternion `quat`. */
  | { kind: "model"; modelId: string; radiusM: number; posM: V3; quat?: [number, number, number, number] };

export interface PhysicsScript {
  segments: FlightSegment[];
  /** Ship start, m, frame-relative (after `baseKm`). */
  startPosM?: V3;
  /** Offset added to the ship and every rock, km: tests precision far from the frame origin. */
  baseKm?: V3;
  startQuat?: [number, number, number, number];
  /** [right, up, forward] m/s. */
  startVelocityBodyMps?: V3;
  /** Body-axis angular velocity, rad/s. */
  startAngVel?: V3;
  startBoostCharge?: number;
  rocks?: RockSpec[];
  /** false = stepShip only (the no-physics reference). */
  physics?: boolean;
  rebaseKm?: number;
  maxSpeedMps?: number;
  /** "registered" (default) uses the live ship collider shape; "fallback" the box. */
  shipShape?: "registered" | "fallback";
  sampleEvery?: number;
  env?: Partial<Pick<ShipStepEnv, "accelerationMult" | "decelerationMult" | "speedMult" | "stopDistanceMult" | "steerMult" | "speedLimitOverrideKmps" | "hasDesiredForward" | "desiredForwardX" | "desiredForwardY" | "desiredForwardZ" | "desiredForwardRateRadPerS">>;
}

export interface PhysicsSample {
  step: number;
  t: number;
  posM: V3;
  velMps: V3;
  speedMps: number;
  /** Body axes, deg/s. */
  angVelDegS: V3;
  sideslipDeg: number;
  owner: StepOwner;
  suspended: string | null;
  penetrationM: number;
}

export interface PhysicsContactRecord {
  step: number;
  t: number;
  rock: number;
  normal: V3;
  dvNormalMps: number;
  impulseNs: number;
  penetrationM: number;
  speedBeforeMps: number;
  speedAfterMps: number;
}

export interface PhysicsImpactRecord {
  step: number;
  t: number;
  rock: number;
  dvMps: number;
  /** Peak already charged in the same contact episode. */
  prevDvMps: number;
  /** Fraction of max hull (curve only, before collisionDamageMult). */
  damageFrac: number;
  contacts: number;
}

export interface PhysicsSimResult {
  /** One record per impact (contact events of one hit folded together); damage from the live tuning. */
  impacts: PhysicsImpactRecord[];
  damage: { contactEvents: number; impacts: number; damageApplications: number; totalFrac: number; lethal: boolean };
  rockShapes: string[];
  dt: number;
  shipShape: string;
  shipBoundsM: ShapeBounds | null;
  segments: { label: string; steps: number; trace: PhysicsSample[]; contacts: PhysicsContactRecord[]; maxPenetrationM: number }[];
  final: { posM: V3; velMps: V3; angVel: V3; quat: number[] };
  counters: NearField["counters"];
  suspensionLog: { step: number; reason: string | null }[];
  engineColliders: { start: number; end: number };
  stepMs: { mean: number; max: number };
  hasNaN: boolean;
}

const RAD = 180 / Math.PI;

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Deterministic lumpy rock: 42 near-uniform directions, radius ×(1 ± lumps). */
export function lumpyHullPoints(radiusM: number, lumps = 0.25, seed = 1, n = 42): Float32Array {
  const out = new Float32Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const th = golden * i;
    const k = radiusM * (1 + lumps * (2 * hash(seed * 1000 + i) - 1));
    out[i * 3] = Math.cos(th) * r * k;
    out[i * 3 + 1] = y * k;
    out[i * 3 + 2] = Math.sin(th) * r * k;
  }
  return out;
}

export function rockShape(r: RockSpec, nf?: NearField): ColliderShape {
  if (r.kind === "model") {
    const m = getAsteroidColliderModel(r.modelId);
    if (!m) throw new Error(`[phys] asteroid model ${r.modelId} is not registered`);
    const hull = nf ? ensureModelHull(m, nf) : null;
    return asteroidColliderShape(m, hull, r.radiusM * m.invBaseRadius * m.baseScale, r.radiusM);
  }
  if (r.kind === "ball") return { kind: "ball", radiusM: r.radiusM };
  if (r.kind === "box") return { kind: "box", halfX: r.half[0], halfY: r.half[1], halfZ: r.half[2] };
  if (r.points) return { kind: "hull", points: Float32Array.from(r.points) };
  return { kind: "hull", points: lumpyHullPoints(r.radiusM ?? 10, r.lumps ?? 0.25, r.seed ?? 1) };
}

export async function simulatePhysics(script: PhysicsScript): Promise<PhysicsSimResult> {
  const usePhysics = script.physics !== false;
  const nf = new NearField({
    rebaseKm: script.rebaseKm,
    maxSpeedKmps: script.maxSpeedMps !== undefined ? script.maxSpeedMps / 1000 : undefined,
  });
  if (script.shipShape !== "fallback" && nearField.shipInfo().source === "mesh") {
    nf.setShipShape(nearField.shipShapeDesc(), "mesh");
  }
  try {
    if (usePhysics) nf.attachWorld((await loadRapierFactory())(physicsWorldConfig()));
    return runScript(script, nf, usePhysics);
  } finally {
    nf.dispose();
  }
}

function runScript(script: PhysicsScript, nf: NearField, usePhysics: boolean): PhysicsSimResult {

  const base = script.baseKm ?? [0, 0, 0];
  const rockIds = new Map<NearFieldColliderId, number>();
  const _rq = new Quaternion();
  const rockShapes: string[] = [];
  (script.rocks ?? []).forEach((r, i) => {
    let q = r.kind !== "ball" && r.quat ? _rq.set(r.quat[0], r.quat[1], r.quat[2], r.quat[3]).normalize() : undefined;
    if (r.kind === "model") {
      const b = getAsteroidColliderModel(r.modelId)?.baseQuat ?? [0, 0, 0, 1];
      q = (q ?? _rq.identity()).multiply(new Quaternion(b[0], b[1], b[2], b[3])).normalize();
    }
    const shape = rockShape(r, nf);
    rockShapes.push(shape.kind === "hull" ? `hull(${shape.points.length / 3})` : shape.kind);
    const id = nf.addCollider(shape, SYSTEM_FRAME_ID,
      { x: base[0] + r.posM[0] / 1000, y: base[1] + r.posM[1] / 1000, z: base[2] + r.posM[2] / 1000 }, q, "sim");
    rockIds.set(id, i);
  });
  const engineStart = nf.engineColliderCount();

  const ship = createShipState();
  ship.frameId = SYSTEM_FRAME_ID;
  const sp = script.startPosM ?? [0, 0, 0];
  ship.posKm.set(base[0] + sp[0] / 1000, base[1] + sp[1] / 1000, base[2] + sp[2] / 1000);
  const sq = script.startQuat ?? [0, 0, 0, 1];
  ship.quat.set(sq[0], sq[1], sq[2], sq[3]).normalize();
  ship.prevPosKm.copy(ship.posKm);
  ship.prevQuat.copy(ship.quat);
  const env = createShipStepEnv(getFlightTuning());
  Object.assign(env, script.env ?? {});
  const input = createShipInput();
  nf.angularAuthority = (env.tuning.angularAccelDegS2 * Math.PI / 180) * FIXED_DT;
  const fwd = new Vector3(), right = new Vector3(), up = new Vector3();
  shipBodyAxes(ship.quat, fwd, right, up);
  if (script.startVelocityBodyMps) {
    const [r, u, f] = script.startVelocityBodyMps;
    ship.velKmps.copy(fwd).multiplyScalar(f / 1000).addScaledVector(right, r / 1000).addScaledVector(up, u / 1000);
  }
  if (script.startAngVel) ship.angVel.set(...script.startAngVel);
  if (script.startBoostCharge !== undefined) ship.boostCharge = script.startBoostCharge;

  const every = Math.max(1, Math.floor(script.sampleEvery ?? 12));
  const segments: PhysicsSimResult["segments"] = [];
  const suspensionLog: PhysicsSimResult["suspensionLog"] = [];
  let lastSusp: string | null = "init";
  let step = 0;
  let owner: StepOwner = "analytic";
  let stepPen = 0;
  let msSum = 0, msMax = 0, msN = 0;
  let hasNaN = false;
  const tracker = new ImpactTracker();
  const tuning = getPhysicsTuning();
  const impacts: PhysicsImpactRecord[] = [];
  const collect = (): void => {
    tracker.drain((im) => impacts.push({
      step: im.firstStep + 1, t: (im.firstStep + 1) * FIXED_DT, rock: rockIds.get(im.colliderId as NearFieldColliderId) ?? -1,
      dvMps: im.dvMps, prevDvMps: im.prevDvMps, damageFrac: impactDamageFractionOf(im, tuning), contacts: im.contacts,
    }));
  };

  const sample = (): PhysicsSample => {
    shipBodyAxes(ship.quat, fwd, right, up);
    const v = ship.velKmps;
    const f = v.dot(fwd), rr = v.dot(right), uu = v.dot(up);
    const speed = v.length() * 1000;
    return {
      step,
      t: step * FIXED_DT,
      posM: [(ship.posKm.x - base[0]) * 1000, (ship.posKm.y - base[1]) * 1000, (ship.posKm.z - base[2]) * 1000],
      velMps: [v.x * 1000, v.y * 1000, v.z * 1000],
      speedMps: speed,
      angVelDegS: [ship.angVel.x * RAD, ship.angVel.y * RAD, ship.angVel.z * RAD],
      sideslipDeg: speed > 1e-6 ? Math.atan2(Math.hypot(rr, uu), f) * RAD : 0,
      owner,
      suspended: usePhysics ? nf.suspended : null,
      penetrationM: stepPen,
    };
  };

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
    const trace: PhysicsSample[] = [sample()];
    const contacts: PhysicsContactRecord[] = [];
    let maxPen = 0;
    for (let i = 0; i < n; i++) {
      stepShip(ship, input, env, FIXED_DT);
      stepPen = 0;
      if (usePhysics) {
        owner = nf.resolve(ship, step);
        if (owner === "physics" && nf.lastStepMs > 0) {
          msSum += nf.lastStepMs; msN++;
          if (nf.lastStepMs > msMax) msMax = nf.lastStepMs;
        }
        const t = (step + 1) * FIXED_DT;
        nf.lastStepContacts((c) => {
          tracker.contact(c, step, tuning);
          stepPen = Math.max(stepPen, c.penetrationM);
          contacts.push({
            step: step + 1, t, rock: rockIds.get(c.colliderId) ?? -1,
            normal: [c.nx, c.ny, c.nz], dvNormalMps: c.dvNormalMps, impulseNs: c.impulseNs, penetrationM: c.penetrationM,
            speedBeforeMps: c.speedBeforeMps, speedAfterMps: c.speedAfterMps,
          });
        });
        tracker.endStep(step, FIXED_DT, tuning);
        collect();
        if (nf.suspended !== lastSusp) {
          suspensionLog.push({ step: step + 1, reason: nf.suspended });
          lastSusp = nf.suspended;
        }
      }
      if (!Number.isFinite(ship.posKm.x + ship.posKm.y + ship.posKm.z + ship.velKmps.x + ship.quat.w)) hasNaN = true;
      maxPen = Math.max(maxPen, stepPen);
      step++;
      if (i === n - 1 || (i + 1) % every === 0) trace.push(sample());
    }
    segments.push({ label: seg.label ?? `seg${segments.length}`, steps: n, trace, contacts, maxPenetrationM: maxPen });
  }

  tracker.flush();
  collect();
  let totalFrac = 0;
  for (const im of impacts) totalFrac += im.damageFrac;
  const result: PhysicsSimResult = {
    impacts,
    damage: {
      contactEvents: tracker.counters.contactEvents, impacts: impacts.length,
      damageApplications: impacts.filter((im) => im.damageFrac > 0).length,
      totalFrac, lethal: totalFrac >= 1,
    },
    rockShapes,
    dt: FIXED_DT,
    shipShape: nf.shipInfo().source,
    shipBoundsM: nf.shipInfo().boundsM,
    segments,
    final: {
      posM: [(ship.posKm.x - base[0]) * 1000, (ship.posKm.y - base[1]) * 1000, (ship.posKm.z - base[2]) * 1000],
      velMps: [ship.velKmps.x * 1000, ship.velKmps.y * 1000, ship.velKmps.z * 1000],
      angVel: ship.angVel.toArray(),
      quat: ship.quat.toArray(),
    },
    counters: { ...nf.counters },
    suspensionLog,
    engineColliders: { start: engineStart, end: nf.engineColliderCount() },
    stepMs: { mean: msN > 0 ? msSum / msN : 0, max: msMax },
    hasNaN,
  };
  return result;
}
