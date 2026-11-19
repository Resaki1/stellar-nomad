/**
 * Store side of the ship-resource domain: the local player's runtime state (the one owner of
 * fuel, heat, capacitor and the processing batch between operations), its save collector,
 * the HUD read model and the player actions. Operations read the record, so `runOperation`
 * samples this into it first and `adoptShipResources` takes the committed result back.
 */
import { atom, type createStore } from "jotai";
import { hullRepairable } from "@/sim/ship/hull";
import { REPAIR_MATERIAL_ID, SUSTAINED_BEAM_S, getProcessingRecipe } from "@/data/content";
import { getActiveSave, getLocalPlayerState, registerCollector, samplePlayerSlice } from "@/save/activeSave";
import type { PlayerState } from "@/save/types";
import {
  createResourceRequests,
  createShipResourceState,
  type ShipResourceState,
} from "@/sim/ship/resourceStep";
import { DEFAULT_RESOURCE_TUNING, getEffectiveTuning, type ResourceTuning } from "@/sim/ship/resourceTuning";
import { coolingMultOf, equipTuning, miningHeatMultOf } from "@/sim/ship/loadout";
import { recordTrial } from "@/store/research";
import { cargoAtom } from "@/store/cargo";
import { dieAtom, isDeadAtom } from "@/store/death";
import { describeRejection, newOpId, runOperation } from "@/store/operations";
import type { OperationOutcome } from "@/sim/world/commands";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { shipHealthAtom } from "@/store/store";
import { addToastAtom } from "@/store/toast";
import { getLocalPlayerShip } from "@/sim/entities";

type Store = ReturnType<typeof createStore>;

export const shipRes: ShipResourceState = createShipResourceState(0, 0);
export const shipReq = createResourceRequests();

/** The live resource table with the local ship's equipment applied; refreshed every frame. */
const shipTuning: ResourceTuning = { ...DEFAULT_RESOURCE_TUNING };
export const getShipTuning = (): Readonly<ResourceTuning> => shipTuning;

/** Player intent and bookkeeping outside the pure step. */
export const shipResControl = {
  repairManual: false,
  /** Sticky explanation of the last refused/stopped action, cleared by the next start. */
  refusal: null as string | null,
  /** Dev/test: OR'd into the mining request (live lifecycle gates). */
  forceMining: false,
  /** Set when the record replaced `capacitor01`; Spaceship copies it into the ship. */
  capacitorDirty: true,
  repairSubmitted: 0,
  heatDamageApplied: 0,
  processingDoneSeen: 0,
  /** Continuous granted beam seconds on the current rock (sustained_beam trial). */
  beamRunS: 0,
  beamSeen: 0,
  /** Rock the beam last worked (MiningSystem); a change restarts `beamRunS`. */
  beamTargetId: -1,
  beamRunTargetId: -1,
};

const RESOURCE_KEYS: ReadonlySet<keyof PlayerState> = new Set<keyof PlayerState>(["propellant", "power", "processing"]);

/** Take the record's committed values (world load, or an operation replaced these slices). */
export function adoptShipResources(keys?: readonly (keyof PlayerState)[]): void {
  if (!getActiveSave()) return;
  if (keys && !keys.some((k) => RESOURCE_KEYS.has(k))) return;
  const p = getLocalPlayerState();
  if (!keys || keys.includes("propellant")) {
    shipRes.ordinaryKg = p.propellant.ordinaryKg;
    shipRes.protectedKg = p.propellant.protectedKg;
  }
  if (!keys || keys.includes("power")) {
    shipRes.heat01 = p.power.heat01;
    shipRes.capacitor01 = p.power.capacitor01;
    shipRes.overTempS = 0;
    shipRes.repairAcc01 = 0;
    shipResControl.capacitorDirty = true;
    // Respawn replaces power: drop heat damage / repair still due from the dead ship.
    shipResControl.heatDamageApplied = shipRes.meter.heatDamage01;
    shipResControl.repairSubmitted = shipRes.meter.repairPctDue;
  }
  if (!keys || keys.includes("processing")) {
    const b = p.processing;
    const run = shipRes.processing;
    const recipe = b ? getProcessingRecipe(b.recipeId) : undefined;
    run.active = !!b && !!recipe;
    run.id = b?.id ?? "";
    run.recipeId = b?.recipeId ?? "";
    run.inputId = recipe?.inputId ?? "";
    run.units = b && recipe ? Math.floor(b.reserved[recipe.inputId] ?? 0) : 0;
    run.elapsedS = b?.elapsedS ?? 0;
    run.committedKg = b?.committedKg ?? 0;
  }
  if (!keys) {
    shipRes.miningTripped = false;
    shipRes.repairAcc01 = 0;
    shipRes.dvCarryMps = 0;
    shipResControl.repairManual = false;
    shipResControl.refusal = null;
    shipResControl.repairSubmitted = shipRes.meter.repairPctDue;
    shipResControl.heatDamageApplied = shipRes.meter.heatDamage01;
    shipResControl.processingDoneSeen = shipRes.meter.processingDone;
  }
}

/** Collector: the runtime into the record (flush time and before every operation). */
function collectShipResources(): void {
  const p = getLocalPlayerState();
  samplePlayerSlice("propellant", { ordinaryKg: shipRes.ordinaryKg, protectedKg: shipRes.protectedKg });
  samplePlayerSlice("power", { capacitor01: shipRes.capacitor01, heat01: shipRes.heat01 });
  const run = shipRes.processing;
  if (!run.active) {
    if (p.processing !== null) samplePlayerSlice("processing", null);
    return;
  }
  samplePlayerSlice("processing", {
    id: run.id,
    recipeId: run.recipeId,
    reserved: { [run.inputId]: run.units },
    elapsedS: run.elapsedS,
    committedKg: run.committedKg,
  });
}

let unregister: (() => void) | null = null;

/** World activation: hydrate the runtime and register its collector (worldBridge). */
export function installShipResources(): () => void {
  adoptShipResources();
  unregister?.();
  unregister = registerCollector(collectShipResources);
  const off = unregister;
  return () => {
    off();
    if (unregister === off) unregister = null;
  };
}

// ── HUD read model (published at HUD cadence by Spaceship; never per frame) ──

export interface ShipResourcesHud {
  ordinaryKg: number;
  protectedKg: number;
  tankKg: number;
  allowanceKg: number;
  heat01: number;
  heatWarn: boolean;
  heatThrottling: boolean;
  overTemp: boolean;
  powerUsed01: number;
  powerDemand01: number;
  capacitor01: number;
  tripped: boolean;
  repairing: boolean;
  /** One line: why an action is throttled or refused right now, else null. */
  reason: string | null;
  processing: { id: string; units: number; committedKg: number; totalKg: number; scale: number } | null;
}

export const shipResourcesHudAtom = atom<ShipResourcesHud>({
  ordinaryKg: 0,
  protectedKg: 0,
  tankKg: 1,
  allowanceKg: 1,
  heat01: 0,
  heatWarn: false,
  heatThrottling: false,
  overTemp: false,
  powerUsed01: 0,
  powerDemand01: 0,
  capacitor01: 1,
  tripped: false,
  repairing: false,
  reason: null,
  processing: null,
});

function reasonLine(): string | null {
  const s = shipRes;
  if (s.ordinaryKg + s.protectedKg <= 0) return "Thrust offline";
  if (s.heat01 > 1) return "Overheat: hull damage";
  const workBlocked = s.processing.active || shipReq.repair || shipReq.miningBeam;
  if (workBlocked && s.heatScale < 1) return "Heat throttling";
  if (s.powerScale < 1 && s.powerDemandKW > 0) return `Power limited ${Math.round(s.powerScale * 100)}%`;
  if (s.tankFull) return "Tank full";
  return shipResControl.refusal;
}

export function buildShipResourcesHud(): ShipResourcesHud {
  const s = shipRes;
  const t = shipTuning;
  const run = s.processing;
  return {
    ordinaryKg: s.ordinaryKg,
    protectedKg: s.protectedKg,
    tankKg: t.tankKg,
    allowanceKg: t.recoveryAllowanceKg,
    heat01: s.heat01,
    heatWarn: s.heat01 >= t.heatWarn01,
    heatThrottling: s.heat01 > t.heatThrottle01,
    overTemp: s.heat01 > 1,
    powerUsed01: t.reactorKW > 0 ? s.powerUsedKW / t.reactorKW : 0,
    powerDemand01: t.reactorKW > 0 ? s.powerDemandKW / t.reactorKW : 0,
    capacitor01: s.capacitor01,
    tripped: s.miningTripped,
    repairing: shipReq.repair,
    reason: reasonLine(),
    processing: run.active
      ? { id: run.id, units: run.units, committedKg: run.committedKg, totalKg: run.units * t.processingKgPerUnit, scale: s.processingScale }
      : null,
  };
}

// ── Per-frame bookkeeping (Spaceship, after its fixed steps) ──

/** Fill the requests the step reads; human-rate inputs only. */
export function updateShipRequests(store: Store, freeFlight: boolean, miningBeam: boolean): void {
  const cfg = store.get(effectiveShipConfigAtom);
  const t = equipTuning(getEffectiveTuning(), cfg, shipTuning);
  const health = store.get(shipHealthAtom);
  const damaged = hullRepairable(health, cfg.maxHealth);
  if (!damaged) shipResControl.repairManual = false;
  const naniteRate = cfg.maxHealth > 0 ? cfg.hullRegenPerSecond / cfg.maxHealth : 0;
  const hasMaterial = (store.get(cargoAtom).items[REPAIR_MATERIAL_ID] ?? 0) >= t.repairUnitsPerPct;
  const auto = naniteRate > 0 && damaged && hasMaterial;
  shipReq.repair = damaged && (shipResControl.repairManual || auto);
  shipReq.repairPerS = shipResControl.repairManual ? Math.max(t.repairPerS, naniteRate) : naniteRate;
  shipReq.miningBeam = miningBeam || shipResControl.forceMining;
  shipReq.freeFlight = freeFlight;
  shipReq.miningHeatMult = miningHeatMultOf(cfg);
  shipReq.coolingMult = coolingMultOf(cfg);
}

/** Turn step outputs into operations / hull changes. Returns true when the ship died. */
export function settleShipResources(store: Store, ship: { frameId: string; posKm: { x: number; y: number; z: number } }): boolean {
  const m = shipRes.meter;
  const due = m.repairPctDue - shipResControl.repairSubmitted;
  if (due > 0) {
    shipResControl.repairSubmitted = m.repairPctDue;
    runOperation({ type: "ship.repair", opId: newOpId(), pct: due }, (o) => {
      if (o.status !== "rejected") return;
      shipResControl.repairManual = false;
      shipResControl.refusal = o.reason === "materials" ? "Repair stopped: no Fe-Ni" : o.reason === "full_hull" ? null : `Repair stopped: ${describeRejection(o)}`;
    });
  }
  const dmg = m.heatDamage01 - shipResControl.heatDamageApplied;
  if (dmg > 0) {
    shipResControl.heatDamageApplied = m.heatDamage01;
    const max = store.get(effectiveShipConfigAtom).maxHealth;
    const health = Math.max(0, store.get(shipHealthAtom) - dmg * max);
    store.set(shipHealthAtom, health);
    if (health <= 0) {
      store.set(dieAtom, { frameId: ship.frameId, positionKm: [ship.posKm.x, ship.posKm.y, ship.posKm.z] });
      return true;
    }
  }
  if (m.processingDone !== shipResControl.processingDoneSeen) {
    shipResControl.processingDoneSeen = m.processingDone;
    store.set(addToastAtom, { kind: "success", message: "Fuel delivered", values: [{ id: "fuel", amount: shipRes.processing.committedKg }] });
    recordTrial("first_batch");
  }
  const beam = m.miningWorkS - shipResControl.beamSeen;
  shipResControl.beamSeen = m.miningWorkS;
  if (shipResControl.beamTargetId !== shipResControl.beamRunTargetId) {
    shipResControl.beamRunTargetId = shipResControl.beamTargetId;
    shipResControl.beamRunS = 0;
  }
  if (!shipReq.miningBeam || shipRes.miningTripped) shipResControl.beamRunS = 0;
  else if (beam > 0) {
    shipResControl.beamRunS += beam;
    if (shipResControl.beamRunS >= SUSTAINED_BEAM_S) recordTrial("sustained_beam");
  }
  return false;
}

// ── Player actions ──

export const startProcessingAtom = atom(null, (_get, set, payload: { recipeId: string; units: number }): OperationOutcome => {
  shipResControl.refusal = null;
  return runOperation({ type: "processing.start", opId: newOpId(), recipeId: payload.recipeId, units: payload.units }, (o) => {
    if (o.status === "rejected") {
      const why = o.reason === "tank_full" ? "Tank full" : o.reason === "busy" ? "Batch running" : describeRejection(o);
      // Stack only: a one-shot refusal parked in the dashboard line went stale ("Batch running" after the batch ended).
      set(addToastAtom, { audio: "reject", kind: "warn", message: "Processing refused", detail: why });
    }
  });
});

export const cancelProcessingAtom = atom(null, (_get, set): OperationOutcome => {
  const id = shipRes.processing.active ? shipRes.processing.id : "";
  return runOperation({ type: "processing.cancel", opId: newOpId(), batchId: id }, (o) => {
    if (o.status === "rejected") {
      set(addToastAtom, { audio: "reject", kind: "warn", message: "Cannot cancel", detail: o.reason === "no_capacity" ? "Hold full" : describeRejection(o) });
      return;
    }
    if (o.status === "accepted" && o.result.type === "processing.cancel") {
      set(addToastAtom, { audio: "silent", message: "Batch cancelled", values: Object.entries(o.result.refunded).map(([id, amount]) => ({ id, amount })) });
    }
  });
});

/** Start/stop manual repair. Starting is refused with a reason when it cannot run. */
export const setRepairAtom = atom(null, (get, set, on: boolean): boolean => {
  if (!on) {
    shipResControl.repairManual = false;
    return true;
  }
  const cfg = get(effectiveShipConfigAtom);
  const t = shipTuning;
  let why: string | null = null;
  if (get(isDeadAtom)) why = "Ship destroyed";
  else if (!hullRepairable(get(shipHealthAtom), cfg.maxHealth)) why = "Hull intact";
  else if ((get(cargoAtom).items[REPAIR_MATERIAL_ID] ?? 0) < t.repairUnitsPerPct) why = "No Fe-Ni";
  if (why) {
    shipResControl.refusal = `Repair refused: ${why}`;
    set(addToastAtom, { audio: "reject", kind: "warn", message: "Cannot repair", detail: why });
    return false;
  }
  shipResControl.refusal = null;
  shipResControl.repairManual = true;
  return true;
});

/** Emergency abandonment: the death operation, at the live pose. Explicit confirmation is the UI's job. */
export const abandonShipAtom = atom(null, (get, set): boolean => {
  const ship = getLocalPlayerShip();
  if (get(isDeadAtom) || !ship) return false;
  const p = ship.posKm;
  const outcome = set(dieAtom, { frameId: ship.frameId, positionKm: [p.x, p.y, p.z], cause: "abandon" });
  return outcome?.status === "pending" || outcome?.status === "accepted";
});
