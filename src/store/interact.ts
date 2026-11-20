/**
 * Interactables are ray-tested along the ship's nose and acted on with [G].
 * Sites and wrecks share the rock timing. Depots and recovery points lock in one second.
 */
import { industryAtom } from "@/store/industry";
import { depotPlacementAtom, industryPanelOpenAtom, industryRequestAtom } from "@/store/industryHud";
import { INDUSTRY_TUNING } from "@/sim/industry/catalog";
import { WRECK_SALVAGE_KM } from "@/data/content";
import { atom, type createStore } from "jotai";
import { playAudio } from "@/audio";
import { Vector3 } from "three";
import { INSPECT_TIME_S, SITES, getSiteDef } from "@/data/content";
import { shipView } from "@/components/Camera/shipView";
import { getLocalPlayerShip } from "@/sim/entities";
import { isFrameId } from "@/sim/frames";
import { absoluteKm } from "@/sim/replication/clearance";
import { REPLICATION_TUNING } from "@/sim/replication/points";
import { isSimPaused } from "@/sim/simPause";
import { describeRejection, newOpId, runOperation } from "@/store/operations";
import type { OperationOutcome } from "@/sim/world/commands";
import { isDeadAtom, wrecksAtom } from "@/store/death";
import { effectiveTargetFocusTimeSAtom, miningStateAtom } from "@/store/mining";
import { discoveriesMirrorAtom } from "@/store/research";
import { activatePointAtom, playerReplicationAtom, placementModeAtom, replicationPointsAtom } from "@/store/replication";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { cargoCapacityUnitsAtom, cargoUsedUnitsAtom } from "@/store/cargo";
import { addToastAtom } from "@/store/toast";
import { transitDriveBuffer } from "@/store/transit";
import { isStructurePoi, STRUCTURE_FOCUS_TIME_S } from "@/store/poi";

type Store = ReturnType<typeof createStore>;

export type InteractKind = "site" | "wreck" | "point" | "depot";

export interface InteractTarget {
  /** `${kind}:${refId}` */
  id: string;
  kind: InteractKind;
  refId: string;
  distKm: number;
  /** Within the action's range ([G] for sites and points, the salvage tractor for wrecks). */
  inRange: boolean;
  actionRangeKm: number;
}

export interface InteractFocus {
  target: InteractTarget | null;
  /** Lock ring 0..1. */
  progress: number;
  focused: boolean;
  /** Site recovery scan 0..1 (0 = idle). */
  scan: number;
}

/** Interactables lock from this far (rocks use their own range). */
export const INTERACT_LOCK_KM = 5;
/** A small object stays lockable: its angular radius never counts as less than this. */
const MIN_LOCK_ANGLE_RAD = (1.5 * Math.PI) / 180;
const LOCK_GRACE_S = 0.18;
const TICK_S = 0.05;
const SITE_RADIUS_M = 150;
const POINT_RADIUS_M = 40;
const WRECK_RADIUS_M = 2;

const EMPTY: InteractFocus = { target: null, progress: 0, focused: false, scan: 0 };
export const interactFocusAtom = atom<InteractFocus>(EMPTY);

/** Mutable lock / scan state (the ticker owns it). */
export const interactControl = { id: "", lockS: 0, lostS: 0, acc: 0, scanning: false, scanS: 0 };

const _a = new Vector3();
const _d = new Vector3();

/** Scratch for the 20 Hz pick (no per-tick allocation; a target object is built only for a new best). */
const _best: { t: InteractTarget | null; angle: number } = { t: null, angle: Infinity };

function consider(kind: InteractKind, refId: string, frameId: string, posKm: readonly number[], radiusM: number, rangeKm: number, best: typeof _best): void {
  const ship = getLocalPlayerShip();
  if (!ship || !isFrameId(frameId)) return;
  _d.copy(absoluteKm(frameId, posKm, _a)).sub(ship.absPosKm);
  const dist = _d.length();
  if (dist > INTERACT_LOCK_KM || dist < 1e-6) return;
  const angle = Math.acos(Math.max(-1, Math.min(1, _d.dot(shipView.forward) / dist)));
  const limit = Math.max(Math.atan(radiusM / 1000 / dist), MIN_LOCK_ANGLE_RAD);
  if (angle > limit || angle >= best.angle) return;
  best.angle = angle;
  best.t = { id: `${kind}:${refId}`, kind, refId, distKm: dist, inRange: dist <= rangeKm, actionRangeKm: rangeKm };
}

/** Nearest interactable under the nose (null when none). Runs at the tick rate, not per frame. */
function pick(store: Store): InteractTarget | null {
  const best = _best;
  best.t = null;
  best.angle = Infinity;
  const disc = store.get(discoveriesMirrorAtom);
  for (const s of SITES) if (!disc.sites[s.id]) consider("site", s.id, s.frameId, s.positionKm, SITE_RADIUS_M, s.recoverRangeKm, best);
  for (const w of store.get(wrecksAtom)) consider("wreck", w.id, w.frameId, w.positionKm, WRECK_RADIUS_M, WRECK_SALVAGE_KM, best);
  for (const p of store.get(replicationPointsAtom)) if (!p.starter) consider("point", p.id, p.frameId, p.positionKm, POINT_RADIUS_M, REPLICATION_TUNING.activateRangeKm, best);
  for (const depot of store.get(industryAtom).depots) consider("depot", depot.id, depot.frameId, depot.positionKm, 50, INDUSTRY_TUNING.interactRangeKm, best);
  return best.t;
}

function pickUnobstructed(store: Store): InteractTarget | null {
  const target = pick(store);
  // A rock in front of the interactable keeps the rock's focus.
  const rock = store.get(miningStateAtom).targetedAsteroid;
  return target && rock && rock.distanceM / 1000 < target.distKm ? null : target;
}

export function isInteractFocusBlocked(store: Store): boolean {
  return store.get(isDeadAtom) || store.get(miningStateAtom).isMining || transitDriveBuffer.phase !== "idle" ||
    store.get(placementModeAtom) || !!store.get(depotPlacementAtom) || store.get(industryPanelOpenAtom);
}

/** Actions recheck the aim so a turn between focus ticks cannot use the old lock. */
export function aimedStructure(store: Store, id: string): InteractTarget | null {
  const focus = store.get(interactFocusAtom);
  if (!isStructurePoi(id) || !focus.focused || focus.target?.id !== id || isInteractFocusBlocked(store)) return null;
  const target = pickUnobstructed(store);
  return target?.id === id ? target : null;
}

function clear(store: Store): void {
  interactControl.id = "";
  interactControl.lockS = 0;
  interactControl.lostS = 0;
  interactControl.scanning = false;
  interactControl.scanS = 0;
  if (store.get(interactFocusAtom) !== EMPTY) store.set(interactFocusAtom, EMPTY);
}

/** Called from the frame loop (InteractFocus); does its work at 20 Hz. */
export function tickInteractFocus(store: Store, dt: number): void {
  const c = interactControl;
  c.acc += dt;
  if (c.acc < TICK_S) return;
  const step = c.acc;
  c.acc = 0;
  if (isInteractFocusBlocked(store)) return clear(store);
  const t = pickUnobstructed(store);
  if (!t) {
    if (!c.id) return;
    if (isStructurePoi(c.id)) return clear(store);
    c.lostS += step;
    if (c.lostS <= LOCK_GRACE_S && !c.scanning) return;
    return clear(store);
  }
  c.lostS = 0;
  if (t.id !== c.id) {
    c.id = t.id;
    c.lockS = 0;
    c.scanning = false;
    c.scanS = 0;
  } else c.lockS += step;
  const need = isStructurePoi(t.id) ? STRUCTURE_FOCUS_TIME_S : store.get(effectiveTargetFocusTimeSAtom);
  const focused = c.lockS >= need;
  let scan = 0;
  if (c.scanning) {
    if (!focused || !t.inRange) {
      c.scanning = false;
      c.scanS = 0;
    } else if (!isSimPaused()) {
      c.scanS += step;
      const total = INSPECT_TIME_S * store.get(effectiveShipConfigAtom).scannerInspectTimeMult;
      scan = Math.min(1, c.scanS / total);
      if (scan >= 1) {
        c.scanning = false;
        c.scanS = 0;
        scan = 0;
        recoverSite(store, t.refId);
      }
    }
  }
  const prev = store.get(interactFocusAtom);
  const progress = Math.min(1, c.lockS / need);
  const same = prev.target?.id === t.id && prev.focused === focused && prev.target.inRange === t.inRange &&
    Math.abs(prev.progress - progress) < 0.02 && Math.abs(prev.scan - scan) < 0.01 && Math.abs(prev.target.distKm - t.distKm) < Math.max(0.002, t.distKm * 0.01);
  if (!same) store.set(interactFocusAtom, { target: t, progress, focused, scan });
}

/** One [G] on the canister: inspect (if not yet) and recover, back to back. */
export function recoverSite(store: Store, siteId: string, opId?: string): OperationOutcome | null {
  const site = getSiteDef(siteId);
  if (!site) return null;
  if (!store.get(discoveriesMirrorAtom).inspectedSites[siteId]) {
    const ins = runOperation({ type: "site.inspect", opId: newOpId(), siteId });
    if (ins.status === "rejected") {
      store.set(addToastAtom, { message: "Cannot recover", detail: describeRejection(ins), kind: "warn", audio: "reject" });
      return ins;
    }
  }
  return runOperation({ type: "site.recover", opId: opId ?? newOpId(), siteId }, (o) => {
    if (o.status === "accepted" && o.result.type === "site.recover") {
      playAudio("mining.inspect.complete");
      const values = Object.entries(o.result.reward).map(([id, amount]) => ({ id, amount }));
      store.set(addToastAtom, { message: "Canister recovered", kind: "success", audio: "silent", values });
    } else if (o.status === "rejected" && o.reason !== "no_capacity") {
      store.set(addToastAtom, { message: "Cannot recover", detail: describeRejection(o), kind: "warn", audio: "reject" });
    }
  });
}

/** [G] on the focused interactable. Returns false when nothing could happen (caller plays the reject). */
export function interactFocused(store: Store): boolean {
  const f = store.get(interactFocusAtom);
  const t = f.target;
  if (!t || !f.focused) return false;
  if (t.kind === "site") {
    if (interactControl.scanning) {
      interactControl.scanning = false;
      interactControl.scanS = 0;
      store.set(interactFocusAtom, { ...f, scan: 0 });
      return true;
    }
    if (!t.inRange || !siteRecoverable(store, t.refId)) return false;
    interactControl.scanning = true;
    interactControl.scanS = 0;
    return true;
  }
  if (t.kind === "depot" && aimedStructure(store, t.id)?.inRange) {
    store.set(industryRequestAtom, { depotId: t.refId });
    return true;
  }
  if (t.kind === "point") {
    if (!aimedStructure(store, t.id)?.inRange || store.get(playerReplicationAtom).activeId === t.refId) return false;
    return store.set(activatePointAtom, t.refId).status === "accepted";
  }
  return false;
}

/** Room in the hold for the site's reward (the Card shows `Full` otherwise). */
export function siteRecoverable(store: Store, siteId: string): boolean {
  return !!getSiteDef(siteId) && !siteHoldFull(store, siteId);
}

export function siteHoldFull(store: Store, siteId: string): boolean {
  const site = getSiteDef(siteId);
  if (!site) return false;
  const need = Object.values(site.reward).reduce((a, v) => a + v, 0);
  return store.get(cargoCapacityUnitsAtom) - store.get(cargoUsedUnitsAtom) < need;
}
