"use client";

import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useState } from "react";
import { cargoAtom } from "@/store/cargo";
import { isDeadAtom } from "@/store/death";
import { abandonShipAtom, shipRes } from "@/store/shipResources";
import { modulesAtom } from "@/store/modules";
import { previewRecovery } from "@/store/replication";
import { getEffectiveTuning } from "@/sim/ship/resourceTuning";
import { unconvertedUnits } from "@/sim/ship/resourceStep";
import { WreckRow } from "../DeathScreen/DeathScreen";

/**
 * Respawn (abandonment, M3 plan §2 rule 9): always reachable, zero fuel included. Same death
 * operation as an impact; the confirmation shows what the wreck keeps.
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
      <button className="settings-menu__button settings-menu__button--danger" data-action="respawn" onClick={() => setConfirming(true)}>
        Respawn
      </button>
    );
  }
  const allowance = getEffectiveTuning().recoveryAllowanceKg;
  // The allowance refill is paid from the ordinary fuel first, so abandoning never adds fuel.
  const wreckFuel = Math.max(0, shipRes.ordinaryKg - Math.max(0, allowance - shipRes.protectedKg));
  const dest = previewRecovery(store, "active");
  // The running batch's unconverted feedstock goes to the wreck too (same rule as ship.destroy).
  const run = shipRes.processing;
  const back = run.active ? unconvertedUnits(run.units, run.committedKg, getEffectiveTuning().processingKgPerUnit) : 0;
  const items = back > 0 ? { ...cargo.items, [run.inputId]: (cargo.items[run.inputId] ?? 0) + back } : cargo.items;
  return (
    <div className="settings-menu__abandon" role="alertdialog" aria-label="Confirm respawn">
      <p className="settings-menu__abandon-title">Respawn at <span data-name="">{dest.pointName}</span>?</p>
      <WreckRow items={items} consumables={consumables} fuelKg={wreckFuel} label="Wreck keeps" />
      <div className="dev-controls__row">
        <button className="settings-menu__button" data-action="respawn-cancel" onClick={() => setConfirming(false)}>
          Cancel
        </button>
        <button
          className="settings-menu__button settings-menu__button--danger"
          data-action="respawn-confirm"
          onClick={() => {
            setConfirming(false);
            if (abandon()) onDone();
          }}
        >
          Respawn
        </button>
      </div>
    </div>
  );
}
