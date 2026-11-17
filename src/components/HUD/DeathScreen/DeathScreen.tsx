"use client";

import { useEffect, useState } from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { isDeadAtom, lastLossAtom } from "@/store/death";
import { FALLBACK_TEXT, activePointAtom, previewRecovery, recoverAtom, replicationPointsAtom } from "@/store/replication";
import { STARTER_POINT_ID } from "@/sim/replication/points";
import { getEffectiveTuning } from "@/sim/ship/resourceTuning";
import { setCursorNeeded } from "@/input/pointerLock";
import { getItemDef } from "@/data/content";

import "./DeathScreen.scss";

const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, v) => a + v, 0);

/**
 * Recovery screen (M3 §6.3): recover at the active point (revalidated by the authority), or
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
  const recover = useSetAtom(recoverAtom);
  const [confirmFallback, setConfirmFallback] = useState(false);

  // Re-resolved on every render (points/active changes re-render this panel).
  const dest = previewRecovery(store, "active");
  const starterName = points.find((p) => p.id === STARTER_POINT_ID)?.name ?? "Origin point";

  const allowance = getEffectiveTuning().recoveryAllowanceKg;
  const atStarter = dest.pointId === STARTER_POINT_ID;
  const lossLine = loss
    ? [
        `${sum(loss.items)} cargo units`,
        sum(loss.consumables) > 0
          ? Object.entries(loss.consumables).map(([k, n]) => `${n} ${getItemDef(k)?.name ?? k}`).join(", ")
          : null,
        `${loss.fuelKg.toFixed(0)} kg propellant`,
      ].filter(Boolean).join(" · ")
    : null;

  return (
    <div className="death-screen" role="dialog" aria-label="Ship destroyed">
      <div className="death-screen__content">
        <h1 className="death-screen__title">{loss?.cause === "abandon" ? "Ship Abandoned" : "Ship Destroyed"}</h1>
        <p className="death-screen__subtitle">
          Cargo, consumables and ordinary propellant stay at the wreck{lossLine ? `: ${lossLine}` : ""}.
        </p>

        {!confirmFallback ? (
          <>
            <dl className="death-screen__dest">
              <dt>Recovery point</dt>
              <dd className="death-screen__dest-name">{dest.pointName}</dd>
              {dest.fallback && (
                <dd className="death-screen__warn">
                  {FALLBACK_TEXT[dest.fallback]} ({active?.name ?? "unknown point"}): recovering at {dest.pointName}
                </dd>
              )}
              {!dest.fallback && dest.candidate > 0 && <dd className="death-screen__note">Emergence moved to a clear offset</dd>}
            </dl>
            <p className="death-screen__kept">
              Kept: modules, research and discoveries. Full hull, empty ordinary tank, {allowance} kg protected allowance.
            </p>
            <button className="death-screen__respawn" onClick={() => recover("active")}>
              Recover at {dest.pointName}
            </button>
            {!atStarter && (
              <button className="death-screen__fallback" onClick={() => setConfirmFallback(true)}>
                Emergency fallback: {starterName}
              </button>
            )}
          </>
        ) : (
          <div className="death-screen__confirm" role="alertdialog" aria-label="Confirm emergency fallback">
            <p>
              Recover at {starterName} instead? This gives up the expedition location: the wreck stays where it is
              and {dest.pointName} remains your active point.
            </p>
            <div className="death-screen__confirm-row">
              <button className="death-screen__fallback" onClick={() => setConfirmFallback(false)}>
                Back
              </button>
              <button className="death-screen__respawn death-screen__fallback-confirm" onClick={() => recover("starter")}>
                Recover at {starterName}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
