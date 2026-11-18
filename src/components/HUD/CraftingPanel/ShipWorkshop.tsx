"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useState } from "react";
import { PROCESSING_RECIPES, REPAIR_MATERIAL_ID } from "@/data/content";
import { getResourceTuning } from "@/sim/ship/resourceTuning";
import { cargoAtom } from "@/store/cargo";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { cancelProcessingAtom, setRepairAtom, shipResourcesHudAtom, startProcessingAtom } from "@/store/shipResources";
import { shipHealthAtom } from "@/store/store";

const recipe = PROCESSING_RECIPES[0];

/** Fuel processing batch and hull repair: the starter's onboard work, available from the start. */
export default function ShipWorkshop() {
  const cargo = useAtomValue(cargoAtom);
  const res = useAtomValue(shipResourcesHudAtom);
  const health = useAtomValue(shipHealthAtom);
  const cfg = useAtomValue(effectiveShipConfigAtom);
  const start = useSetAtom(startProcessingAtom);
  const cancel = useSetAtom(cancelProcessingAtom);
  const setRepair = useSetAtom(setRepairAtom);
  const t = getResourceTuning();

  const have = Math.floor(cargo.items[recipe.inputId] ?? 0);
  const roomUnits = Math.max(0, Math.ceil((res.tankKg - res.ordinaryKg) / t.processingKgPerUnit - 1e-9));
  const maxUnits = Math.max(0, Math.min(have, t.processingMaxBatchUnits, roomUnits));
  const [chosen, setChosen] = useState(10);
  const units = Math.max(1, Math.min(chosen, Math.max(1, maxUnits)));
  const outKg = units * t.processingKgPerUnit;
  const batch = res.processing;

  const hullPct = cfg.maxHealth > 0 ? (health / cfg.maxHealth) * 100 : 0;
  const missingPct = Math.max(0, Math.ceil(100 - hullPct - 1e-9));
  const metal = Math.floor(cargo.items[REPAIR_MATERIAL_ID] ?? 0);
  const repairCost = missingPct * t.repairUnitsPerPct;

  return (
    <div className="crafting-panel__workshop">
      <div className="crafting-panel__item">
        <div className="crafting-panel__item-title">
          <span className="crafting-panel__item-name">{recipe.name}</span>
          <span className="crafting-panel__item-slot">fuel processing</span>
        </div>
        <div className="crafting-panel__item-desc">
          {recipe.uiDesc}. {t.processingKgPerUnit} kg per unit · tank {res.ordinaryKg.toFixed(0)} / {res.tankKg} kg
        </div>
        {batch ? (
          <>
            <div className="crafting-panel__progress" aria-label="processing progress">
              <div className="crafting-panel__progress-fill" style={{ width: `${(batch.committedKg / batch.totalKg) * 100}%` }} />
            </div>
            <div className="crafting-panel__workshop-row">
              <span className="crafting-panel__recipe-item">
                {batch.committedKg.toFixed(0)} / {batch.totalKg.toFixed(0)} kg · {batch.units} units
                {batch.scale < 1 ? ` · ${Math.round(batch.scale * 100)}% rate` : ""}
              </span>
              <button className="crafting-panel__confirm-cancel" onClick={() => cancel()}>
                Cancel batch
              </button>
            </div>
            {res.reason && <div className="crafting-panel__workshop-reason">{res.reason}</div>}
          </>
        ) : (
          <div className="crafting-panel__workshop-row">
            <span className={`crafting-panel__recipe-item ${have < 1 ? "crafting-panel__recipe-item--insufficient" : ""}`}>
              hydrates {have}
            </span>
            <span className="crafting-panel__workshop-units">
              {[10, 25, t.processingMaxBatchUnits].map((n) => (
                <button
                  key={n}
                  className={`crafting-panel__filter-btn ${units === Math.min(n, Math.max(1, maxUnits)) && chosen === n ? "crafting-panel__filter-btn--active" : ""}`}
                  onClick={() => setChosen(n)}
                >
                  {n === t.processingMaxBatchUnits ? `max ${n}` : n}
                </button>
              ))}
            </span>
            <span className="crafting-panel__recipe-item">
              → {outKg} kg · {(outKg / t.processingKgPerS).toFixed(0)} s
            </span>
            <button
              className="crafting-panel__craft-btn"
              disabled={maxUnits < 1}
              title={have < 1 ? "No hydrates aboard" : roomUnits < 1 ? "Tank is full" : undefined}
              onClick={() => start({ recipeId: recipe.id, units })}
            >
              Process
            </button>
          </div>
        )}
      </div>

      <div className="crafting-panel__item">
        <div className="crafting-panel__item-title">
          <span className="crafting-panel__item-name">Hull repair</span>
          <span className="crafting-panel__item-slot">maintenance</span>
        </div>
        <div className="crafting-panel__item-desc">
          {t.repairUnitsPerPct} Fe-Ni metal per 1 % hull, {Math.round(t.repairPerS * 100)} % per second. Hull {Math.round(hullPct)} %.
        </div>
        <div className="crafting-panel__workshop-row">
          <span className={`crafting-panel__recipe-item ${metal < Math.min(repairCost, t.repairUnitsPerPct) ? "crafting-panel__recipe-item--insufficient" : ""}`}>
            Fe-Ni {metal} / {repairCost} to full
          </span>
          {res.repairing ? (
            <button className="crafting-panel__confirm-cancel" onClick={() => setRepair(false)}>
              Stop repair
            </button>
          ) : (
            <button className="crafting-panel__craft-btn" disabled={missingPct < 1} onClick={() => setRepair(true)}>
              Repair
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
