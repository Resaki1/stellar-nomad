/**
 * Power/thermal preview of a loadout, rolled out with the real resource step so the numbers
 * are what flying it does (gate d compares them with `simulateResources`). Human rate only.
 */
import { INSPECT_RANGE_M, INSPECT_TIME_S } from "@/data/content";
import type { ShipConfig } from "@/save/types";
import { coolingMultOf, equipTuning, miningHeatMultOf } from "./loadout";
import { createResourceRequests, createShipResourceState, stepShipResources } from "./resourceStep";
import { DEFAULT_RESOURCE_TUNING, type ResourceTuning } from "./resourceTuning";
import { FIXED_DT } from "./shipConstants";
import { createShipState } from "./shipState";

export interface LoadoutPreview {
  reactorKW: number;
  essentialKW: number;
  /** Left for work after essential control/sensing. */
  workKW: number;
  miningKW: number;
  processingKW: number;
  /** Work rate when the load runs alone / mining and processing together (1 = full). */
  miningScale: number;
  sharedScale: number;
  processingKgPerS: number;
  /** Mining alone from cold until the laser trips; null if it never trips within 120 s. */
  miningTripS: number | null;
  /** Idle cooling from 100 % to 0 %. */
  coolDownS: number;
  heatCapacityKJ: number;
  tankKg: number;
  cargoUnits: number;
  inspectTimeS: number;
  inspectRangeM: number;
}

const MAX_S = 120;

export function computeLoadoutPreview(cfg: Readonly<ShipConfig>, base: Readonly<ResourceTuning>, baseCargoUnits: number): LoadoutPreview {
  const t = equipTuning(base, cfg, { ...DEFAULT_RESOURCE_TUNING });
  const ship = createShipState();
  const req = createResourceRequests();
  req.miningHeatMult = miningHeatMultOf(cfg);
  req.coolingMult = coolingMultOf(cfg);
  const maxSteps = Math.round(MAX_S / FIXED_DT);

  req.miningBeam = true;
  const hot = createShipResourceState(t.tankKg, 0);
  let trip: number | null = null;
  for (let i = 1; i <= maxSteps; i++) {
    stepShipResources(hot, ship, req, t, FIXED_DT);
    if (hot.miningTripped) {
      trip = i * FIXED_DT;
      break;
    }
  }
  req.miningBeam = false;
  const cold = createShipResourceState(t.tankKg, 0);
  cold.heat01 = 1;
  let cool = MAX_S;
  for (let i = 1; i <= maxSteps; i++) {
    stepShipResources(cold, ship, req, t, FIXED_DT);
    if (cold.heat01 <= 0) {
      cool = i * FIXED_DT;
      break;
    }
  }
  const work = Math.max(0, t.reactorKW - t.essentialKW);
  return {
    reactorKW: t.reactorKW,
    essentialKW: t.essentialKW,
    workKW: work,
    miningKW: t.miningKW,
    processingKW: t.processingKW,
    miningScale: t.miningKW > work ? work / t.miningKW : 1,
    sharedScale: t.miningKW + t.processingKW > work ? work / (t.miningKW + t.processingKW) : 1,
    processingKgPerS: t.processingKgPerS,
    miningTripS: trip,
    coolDownS: cool,
    heatCapacityKJ: t.heatCapacityKJ,
    tankKg: t.tankKg,
    cargoUnits: Math.max(0, Math.floor(baseCargoUnits + cfg.bonusCargoCapacity)),
    inspectTimeS: INSPECT_TIME_S * cfg.scannerInspectTimeMult,
    inspectRangeM: INSPECT_RANGE_M * cfg.scannerInspectRangeMult,
  };
}
