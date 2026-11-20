"use client";

import { useEffect, useState } from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { isDeadAtom, lastLossAtom } from "@/store/death";
import { industryAtom } from "@/store/industry";
import { activePointAtom, previewRecovery, recoverAtom, replicationPointsAtom } from "@/store/replication";
import { shipResourcesHudAtom } from "@/store/shipResources";
import { STARTER_POINT_ID } from "@/sim/replication/points";
import { setCursorNeeded } from "@/input/pointerLock";
import { ValueChip } from "../shared/Chips";

import "./DeathScreen.scss";

/** What a wreck holds, as value chips (cargo by material, consumables, fuel). */
export function WreckRow({ items, consumables, fuelKg, label }: { items: Record<string, number>; consumables: Record<string, number>; fuelKg: number; label: string }) {
  const cargo = Object.entries(items).filter(([, n]) => Math.floor(n) > 0);
  const kits = Object.entries(consumables).filter(([, n]) => n > 0);
  const empty = cargo.length === 0 && kits.length === 0 && fuelKg < 0.5;
  return (
    <div className="death-screen__wreck" data-testid="wreck-row">
      <span className="death-screen__wreck-label">{label}</span>
      {empty ? <span className="death-screen__wreck-empty">empty</span> : (
        <>
          {cargo.map(([k, n]) => <ValueChip key={k} id={k} amount={Math.floor(n)} />)}
          {kits.map(([k, n]) => <ValueChip key={k} id={k} amount={n} />)}
          {fuelKg >= 0.5 && <ValueChip id="fuel" amount={fuelKg} unit="kg" />}
        </>
      )}
    </div>
  );
}

/**
 * Respawn screen (M3 §6.3): respawn at the active point (revalidated by the authority), or
 * explicitly fall back to the protected origin point (the empty-space escape).
 */
export default function DeathScreen() {
  const isDead = useAtomValue(isDeadAtom);
  useEffect(() => setCursorNeeded("death", isDead), [isDead]);
  // Mounted per death, so the fallback confirmation never carries over.
  return isDead ? <RecoveryPanel /> : null;
}

function RecoveryPanel() {
  const store = useStore();
  const active = useAtomValue(activePointAtom);
  const points = useAtomValue(replicationPointsAtom);
  const loss = useAtomValue(lastLossAtom);
  const pointTanks = useAtomValue(industryAtom).pointTanks;
  const { tankKg } = useAtomValue(shipResourcesHudAtom);
  const recover = useSetAtom(recoverAtom);
  const [confirmFallback, setConfirmFallback] = useState(false);

  // Re-resolved on every render (points/active changes re-render this panel).
  const dest = previewRecovery(store, "active");
  const starterName = points.find((p) => p.id === STARTER_POINT_ID)?.name ?? "Origin point";
  const atStarter = dest.pointId === STARTER_POINT_ID;
  const hasTank = !atStarter && Object.hasOwn(pointTanks, dest.pointId);
  const expectedFuelKg = hasTank ? Math.min(pointTanks[dest.pointId], tankKg) : 0;
  const activeName = active?.name ?? "Active point";

  return (
    <div className="death-screen" role="dialog" aria-label="Ship destroyed">
      <div className="death-screen__content">
        <h1 className={`death-screen__title${loss?.cause === "abandon" ? " death-screen__title--respawn" : ""}`}>{loss?.cause === "abandon" ? "Respawn" : "Ship destroyed"}</h1>
        {loss && <WreckRow items={loss.items} consumables={loss.consumables} fuelKg={loss.fuelKg} label="Wreck" />}

        {!confirmFallback ? (
          <>
            {dest.fallback && (
              <p className="death-screen__warn">
                <span data-name="">{activeName}</span> {dest.fallback === "obstructed" ? "blocked" : "unavailable"}: respawn at <span data-name="">{dest.pointName}</span>
              </p>
            )}
            {hasTank && <p className="death-screen__point-fuel" data-testid="recovery-point-fuel">
              {expectedFuelKg > 0
                ? `Up to ${expectedFuelKg.toLocaleString("en-US", { maximumFractionDigits: 2 })} kg ordinary propellant from the shared tank`
                : "The shared fuel tank is empty"}
            </p>}
            <button className="death-screen__respawn" onClick={() => recover("active")}>
              Respawn at <span className="death-screen__dest-name" data-name="">{dest.pointName}</span>
            </button>
            {!atStarter && (
              <button className="death-screen__fallback" onClick={() => setConfirmFallback(true)}>
                Respawn at <span data-name="">{starterName}</span>
              </button>
            )}
          </>
        ) : (
          <div className="death-screen__confirm" role="alertdialog" aria-label="Confirm respawn at the origin point">
            <p>Respawn at <span data-name="">{starterName}</span>? <span data-name="">{dest.pointName}</span> stays your active point.</p>
            <div className="death-screen__confirm-row">
              <button className="death-screen__fallback" onClick={() => setConfirmFallback(false)}>
                Back
              </button>
              <button className="death-screen__respawn death-screen__fallback-confirm" onClick={() => recover("starter")}>
                Respawn
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
