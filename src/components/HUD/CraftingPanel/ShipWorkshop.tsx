"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useState } from "react";
import { playAudio } from "@/audio";
import { PROCESSING_RECIPES, REPAIR_MATERIAL_ID } from "@/data/content";
import { getEffectiveTuning } from "@/sim/ship/resourceTuning";
import { cargoAtom } from "@/store/cargo";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { cancelProcessingAtom, setRepairAtom, shipResourcesHudAtom, startProcessingAtom } from "@/store/shipResources";
import { shipHealthAtom } from "@/store/store";
import { hullDisplayPct, hullRepairable } from "@/sim/ship/hull";
import { Fuel, Shield } from "lucide-react";
import { ResourceIcon } from "../shared/Chips";

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
  const t = getEffectiveTuning();

  const have = Math.floor(cargo.items[recipe.inputId] ?? 0);
  const roomUnits = Math.max(0, Math.ceil((res.tankKg - res.ordinaryKg) / t.processingKgPerUnit - 1e-9));
  const maxUnits = Math.max(0, Math.min(have, t.processingMaxBatchUnits, roomUnits));
  const [chosen, setChosen] = useState(10);
  const units = Math.max(1, Math.min(chosen, Math.max(1, maxUnits)));
  // Chips never offer more than can be processed now (owned, batch cap, tank room).
  const chips = [10, 25].filter((n) => n < maxUnits).concat(maxUnits >= 1 ? [maxUnits] : []);
  const outKg = units * t.processingKgPerUnit;
  const batch = res.processing;

  const hullPct = cfg.maxHealth > 0 ? (health / cfg.maxHealth) * 100 : 0;
  const repairable = hullRepairable(health, cfg.maxHealth);
  const missingPct = repairable ? Math.max(1, Math.ceil(100 - hullPct - 1e-9)) : 0;
  const metal = Math.floor(cargo.items[REPAIR_MATERIAL_ID] ?? 0);
  const repairCost = missingPct * t.repairUnitsPerPct;

  const tankFrac = res.tankKg > 0 ? res.ordinaryKg / res.tankKg : 0;

  return (
    <div className="crafting-panel__workshop">
      <div className="crafting-panel__item" data-work="processing">
        <div className="crafting-panel__item-title">
          <span className="crafting-panel__item-name">{recipe.name}</span>
          <span className="crafting-panel__rate">
            <ResourceIcon id={recipe.inputId} amount={1} /> → {t.processingKgPerUnit} kg
          </span>
        </div>
        <div className="crafting-panel__bar-row">
          <Fuel size={12} strokeWidth={1.75} aria-label="Fuel tank" />
          <div className="crafting-panel__progress crafting-panel__progress--inline">
            <div className="crafting-panel__progress-fill" style={{ width: `${Math.min(1, tankFrac) * 100}%` }} />
          </div>
          <span className="crafting-panel__num">{res.ordinaryKg.toFixed(0)} / {res.tankKg} kg</span>
        </div>
        {batch ? (
          <>
            <div className="crafting-panel__workshop-row">
              <div className="crafting-panel__progress crafting-panel__progress--inline" aria-label="processing progress">
                <div className="crafting-panel__progress-fill crafting-panel__progress-fill--work" style={{ width: `${(batch.committedKg / batch.totalKg) * 100}%` }} />
              </div>
              <span className="crafting-panel__num">{batch.committedKg.toFixed(0)} / {batch.totalKg.toFixed(0)} kg</span>
              <button className="crafting-panel__confirm-cancel" onClick={() => { if (cancel().status === "accepted") playAudio("click.soft"); }}>
                Cancel
              </button>
            </div>
            {res.reason && <div className="crafting-panel__workshop-reason">{res.reason}</div>}
          </>
        ) : (
          <div className="crafting-panel__workshop-row">
            <ResourceIcon id={recipe.inputId} amount={have} />
            <span className="crafting-panel__workshop-units">
              {chips.map((n) => (
                <button
                  key={n}
                  className={`crafting-panel__filter-btn ${units === n ? "crafting-panel__filter-btn--active" : ""}`}
                  onClick={() => setChosen(n === maxUnits ? Infinity : n)}
                >
                  {n === maxUnits ? `max ${n}` : n}
                </button>
              ))}
            </span>
            <span className="crafting-panel__num">{outKg} kg · {(outKg / t.processingKgPerS).toFixed(0)} s</span>
            <button
              className="crafting-panel__craft-btn"
              disabled={maxUnits < 1}
              title={have < 1 ? "No hydrates" : roomUnits < 1 ? "Tank full" : undefined}
              onClick={() => { if (start({ recipeId: recipe.id, units }).status === "accepted") playAudio("click.hard"); }}
            >
              Process
            </button>
          </div>
        )}
      </div>

      <div className="crafting-panel__item" data-work="repair">
        <div className="crafting-panel__item-title">
          <span className="crafting-panel__item-name">Hull repair</span>
          <span className="crafting-panel__rate">
            <ResourceIcon id={REPAIR_MATERIAL_ID} amount={t.repairUnitsPerPct} /> / %
          </span>
        </div>
        <div className="crafting-panel__bar-row">
          <Shield size={12} strokeWidth={1.75} aria-label="Hull" />
          <div className="crafting-panel__progress crafting-panel__progress--inline">
            <div className="crafting-panel__progress-fill crafting-panel__progress-fill--hull" style={{ width: `${Math.min(100, hullPct)}%` }} />
          </div>
          <span className="crafting-panel__num">{hullDisplayPct(health, cfg.maxHealth)} %</span>
        </div>
        <div className="crafting-panel__workshop-row">
          {repairable ? <ResourceIcon id={REPAIR_MATERIAL_ID} amount={repairCost} have={metal} /> : <span className="crafting-panel__num">Hull intact</span>}
          {res.repairing ? (
            <button className="crafting-panel__confirm-cancel" onClick={() => { setRepair(false); playAudio("click.soft"); }}>
              Stop
            </button>
          ) : (
            <button className="crafting-panel__craft-btn" disabled={!repairable} onClick={() => { if (setRepair(true)) playAudio("click.hard"); }}>
              Repair
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
