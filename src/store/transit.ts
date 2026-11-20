// Transit drive, store side: the runtime instance the fixed step mutates (sim/ship/transitDrive.ts),
// per-frame inputs, the human-rate phase atom and the route preview the HUD reads.

import { atom, type createStore } from "jotai";
import { Vector3 } from "three";
import { modulesAtom } from "@/store/modules";
import { miningStateAtom } from "@/store/mining";
import { simRateAtom } from "@/store/simTime";
import type { ShipInput } from "@/sim/ship/shipInput";
import { frameVelocityKmps, isFrameId, resolveFramePositionKm, selectFrame, SYSTEM_FRAME_ID } from "@/sim/frames";
import {
  createTransitInputs,
  createTransitPlan,
  createTransitRuntime,
  planTransit,
  predictFromRuntime,
  targetBodyId,
  type TransitPhase,
  type TransitPlan,
  type TransitTarget,
} from "@/sim/ship/transitDrive";
import { FIXED_DT } from "@/sim/ship/shipConstants";
import { getShipTuning, shipRes, shipReq } from "@/store/shipResources";
import { getLocalPlayerShip } from "@/sim/entities";
import type { AsteroidFieldDef, CelestialBodyDef } from "@/sim/systemTypes";

export {
  TRANSIT_ACCEL_KMPS2,
  TRANSIT_SPOOL_TIME_S,
  TRANSIT_STEER_MULT,
  type TransitPhase,
  type TransitTarget,
} from "@/sim/ship/transitDrive";

type Store = ReturnType<typeof createStore>;

export type TransitState = {
  phase: TransitPhase;
  /** Final destination while the autopilot flies a route (not the clearance point). */
  target: TransitTarget | null;
  legIndex: number;
  legCount: number;
};

const DEFAULT_TRANSIT: TransitState = { phase: "idle", target: null, legIndex: 0, legCount: 0 };

/** Human-rate mirror: written on phase / leg / target changes only. */
export const transitStateAtom = atom<TransitState>(DEFAULT_TRANSIT);

/** The runtime the fixed step mutates; the keyboard writes `keyHeld` / `keyTapped`. */
export const transitDriveBuffer = createTransitRuntime();
/** Filled once per frame by the ship before its fixed steps. */
export const transitInputs = createTransitInputs();

export const transitDriveOwnedAtom = atom((get) => get(modulesAtom).ownedModules.includes("special_transit_drive"));

/** Targeted POI for autopilot. */
export const targetedPOIAtom = atom<TransitTarget | null>(null);

// A tracked drone is a moving bearing. Autopilot only plans arrivals at stable destinations.
const transitDestinationAtom = atom(get => {
  const target = get(targetedPOIAtom);
  return target?.id.startsWith("drone:") ? null : target;
});

/** Arrival stand-off at a body: two radii from its centre (min 100 km). */
export const bodyArrivalOffsetKm = (radiusKm: number): number => Math.max(100, radiusKm * 2);

/**
 * The transit target for a body, as every caller (gaze, menus, tests) builds it: a body that
 * anchors an enabled asteroid field carries it, so a trip from afar ends in the field (D11).
 */
export function bodyTransitTarget(body: Readonly<CelestialBodyDef>, fields: readonly AsteroidFieldDef[] | undefined, withField = true): TransitTarget {
  const f = withField ? fields?.find((x) => x.enabled !== false && x.anchorBody === body.id) : undefined;
  return {
    id: `body:${body.id}`,
    name: body.name,
    positionKm: body.positionKm,
    arrivalOffsetKm: bodyArrivalOffsetKm(body.radiusKm),
    field: f ? { positionKm: f.anchorKm, name: f.name } : undefined,
  };
}

export const isTransitBurning = (phase: TransitPhase): boolean =>
  phase === "accelerating" || phase === "coasting" || phase === "decelerating";

/** Reset to idle (death, teleport, drive removed). */
export const resetTransitAtom = atom(null, (_get, set) => {
  transitDriveBuffer.phase = "idle";
  transitDriveBuffer.speedKmps = transitDriveBuffer.velX = transitDriveBuffer.velY = transitDriveBuffer.velZ = 0;
  transitDriveBuffer.autopilot = false;
  transitDriveBuffer.keyTapped = false;
  set(transitStateAtom, { ...DEFAULT_TRANSIT });
});

/** Per frame, before the ship's fixed steps. */
export function updateTransitInputs(store: Store, input: Readonly<ShipInput>): void {
  transitInputs.owned = store.get(transitDriveOwnedAtom);
  transitInputs.blocked = store.get(miningStateAtom).isMining;
  transitInputs.steer = Math.max(Math.abs(input.yaw), Math.abs(input.pitch));
  transitInputs.target = store.get(transitDestinationAtom);
  transitInputs.coolingMult = shipReq.coolingMult;
  transitInputs.freeFlight = shipReq.freeFlight;
}

// ── Route preview (human rate) ──────────────────────────────────────────────

export interface TransitPreview {
  /** Destination this preview is for. */
  targetId: string;
  targetName: string;
  /** Planned trip (idle) or the rest of the running one. */
  live: boolean;
  ok: boolean;
  reason: string | null;
  etaS: number;
  fuelKg: number;
  arrivalOrdinaryKg: number;
  protectedKg: number;
  peakHeat01: number;
  fuelLimited: boolean;
  /** Lower-bound fuel the route needs, kg, and the tank it must fit in (refusals show both). */
  needKg: number;
  tankKg: number;
  /** Fuel caps the peak speed: the leg coasts and takes longer. */
  slow: boolean;
  viaName: string | null;
  legCount: number;
}

export const transitPreviewAtom = atom<TransitPreview | null>(null);

/** Latest full prediction (numbers for tests and the POI marker). */
export const transitPreviewPlan: TransitPlan = createTransitPlan();
const _ship = new Vector3();
const _aimNow = new Vector3();
const _vA = new Vector3();
const _vB = new Vector3();

/**
 * Aim velocity relative to the ship's frame, km per executed second (simRate included):
 * the destination's frame minus the ship's. Uses the ephemeris (allocates): human rate only.
 */
export function updateAimVelocity(store: Store, target: TransitTarget | null, shipFrame: string): void {
  if (!target) {
    transitInputs.aimVelX = transitInputs.aimVelY = transitInputs.aimVelZ = 0;
    return;
  }
  resolveFramePositionKm(target.positionKm, target.frameId, _aimNow);
  const body = targetBodyId(target);
  const frame = target.frameId ?? (body && isFrameId(body) ? body : selectFrame(_aimNow, SYSTEM_FRAME_ID));
  frameVelocityKmps(frame, _vA).sub(frameVelocityKmps(shipFrame, _vB)).multiplyScalar(store.get(simRateAtom));
  transitInputs.aimVelX = _vA.x;
  transitInputs.aimVelY = _vA.y;
  transitInputs.aimVelZ = _vA.z;
}

/** Recompute the preview for the targeted destination (or the running route). Returns it. */
export function computeTransitPreview(store: Store): TransitPreview | null {
  const ship = getLocalPlayerShip();
  const rt = transitDriveBuffer;
  const t = getShipTuning();
  const target = rt.phase !== "idle" && rt.autopilot ? rt.target : store.get(transitDestinationAtom);
  if (!ship || !target || !store.get(transitDriveOwnedAtom)) return null;
  _ship.copy(ship.absPosKm);
  updateAimVelocity(store, target, ship.frameId);
  const p = transitPreviewPlan;
  const live = rt.phase !== "idle" && rt.autopilot;
  if (live) predictFromRuntime(p, rt, _ship, shipRes, transitInputs, t, FIXED_DT);
  else planTransit(p, _ship, target, rt.bodies, shipRes, transitInputs, t, FIXED_DT);
  return {
    targetId: target.id,
    targetName: p.fieldArrival && target.field ? `${target.name} · ${target.field.name.toLowerCase()}` : target.name,
    live,
    ok: p.ok,
    reason: p.reason,
    etaS: p.etaS,
    fuelKg: p.fuelKg,
    arrivalOrdinaryKg: p.arrivalOrdinaryKg,
    protectedKg: p.protectedKg,
    peakHeat01: p.peakHeat01,
    fuelLimited: p.fuelLimited,
    needKg: p.needKg,
    tankKg: t.tankKg,
    slow: p.ok && p.fuelLimited,
    viaName: p.viaBodyId ? (p.viaName ?? rt.bodies.find((b) => b.id === p.viaBodyId)?.name ?? p.viaBodyId) : null,
    legCount: p.legCount,
  };
}
