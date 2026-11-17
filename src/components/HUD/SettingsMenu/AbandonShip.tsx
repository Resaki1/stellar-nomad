"use client";

import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useState } from "react";
import { cargoAtom } from "@/store/cargo";
import { isDeadAtom } from "@/store/death";
import { abandonShipAtom, shipRes } from "@/store/shipResources";
import { modulesAtom } from "@/store/modules";
import { previewRecovery } from "@/store/replication";
import { getEffectiveTuning } from "@/sim/ship/resourceTuning";

/**
 * Emergency abandonment (M3 plan §2 rule 9): always reachable, zero fuel included. Same death
 * operation as an impact; the confirmation states what stays at the wreck and what is kept.
 */
export default function AbandonShip({ onDone }: { onDone: () => void }) {
  const store = useStore();
  const dead = useAtomValue(isDeadAtom);
  const consumables = useAtomValue(modulesAtom).consumables;
  const cargo = useAtomValue(cargoAtom);
  const abandon = useSetAtom(abandonShipAtom);
  const [confirming, setConfirming] = useState(false);
  if (dead) return null;

  if (!confirming) {
    return (
      <button className="settings-menu__button settings-menu__button--danger" onClick={() => setConfirming(true)}>
        emergency: abandon ship
      </button>
    );
  }
  const units = Object.values(cargo.items).reduce((a, v) => a + Math.floor(v), 0);
  const loose = Object.values(consumables).reduce((a, v) => a + Math.floor(v), 0);
  const batch = shipRes.processing.active ? shipRes.processing : null;
  const allowance = getEffectiveTuning().recoveryAllowanceKg;
  // The allowance refill is paid from the ordinary fuel first, so abandoning never adds fuel.
  const wreckFuel = Math.max(0, shipRes.ordinaryKg - Math.max(0, allowance - shipRes.protectedKg));
  const dest = previewRecovery(store, "active");
  return (
    <div className="settings-menu__abandon" role="alertdialog" aria-label="Confirm abandon ship">
      <p className="settings-menu__abandon-title">Abandon ship?</p>
      <p>
        Left at the wreck: {units} cargo units, {loose} consumables, {wreckFuel.toFixed(0)} kg ordinary propellant
        {batch ? ", and the unprocessed feedstock of the running batch" : ""}. You can fly back to collect it.
      </p>
      <p>
        Kept: modules, research and discoveries. You recover at <strong>{dest.pointName}</strong> with full hull, an
        empty ordinary tank and the {allowance} kg protected allowance.
      </p>
      <div className="dev-controls__row">
        <button className="settings-menu__button" onClick={() => setConfirming(false)}>
          keep flying
        </button>
        <button
          className="settings-menu__button settings-menu__button--danger"
          onClick={() => {
            setConfirming(false);
            if (abandon()) onDone();
          }}
        >
          abandon ship
        </button>
      </div>
    </div>
  );
}
