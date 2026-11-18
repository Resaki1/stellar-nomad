"use client";

import { useAtomValue } from "jotai";
import { loadoutPreviewAtom } from "@/store/discoveries";

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** Power/thermal preview of the equipped loadout, rolled out with the real resource step. */
export default function LoadoutPreview() {
  const p = useAtomValue(loadoutPreviewAtom);
  const rows: [string, string, boolean?][] = [
    ["Reactor", `${p.reactorKW.toFixed(0)} kW`],
    ["Mining laser", `${p.miningKW.toFixed(0)} kW${p.miningScale < 1 ? ` · ${pct(p.miningScale)}` : ""}`, p.miningScale < 1],
    ["Processing", `${p.processingKW.toFixed(0)} kW · ${p.processingKgPerS.toFixed(1)} kg/s`],
    ...(p.sharedScale < 1 ? [["Shared", pct(p.sharedScale), true] as [string, string, boolean]] : []),
    ["Laser trip", p.miningTripS === null ? "—" : `${p.miningTripS.toFixed(1)} s`],
    ["Cool-down", `${p.coolDownS.toFixed(0)} s`],
    ["Fuel tank", `${p.tankKg.toFixed(0)} kg`],
    ["Cargo hold", `${p.cargoUnits} units`],
    ["Inspect", `${p.inspectTimeS.toFixed(1)} s · ${(p.inspectRangeM / 1000).toFixed(1)} km`],
  ];
  return (
    <div className="loadout-preview" data-testid="loadout-preview">
      <div className="loadout-preview__title">Power and heat</div>
      <dl className="loadout-preview__grid">
        {rows.map(([k, v, warn]) => (
          <div key={k} className="loadout-preview__row">
            <dt>{k}</dt>
            <dd className={warn ? "loadout-preview__warn" : undefined}>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
