"use client";

import { useAtomValue } from "jotai";

import { cargoCapacityUnitsAtom, cargoFillFractionAtom, cargoUsedUnitsAtom } from "@/store/cargo";

import "./CargoHUD.scss";

type CargoHUDProps = {
  onClick?: () => void;
};

/** Cargo fill, top-left. Gains are Notification Stack items (one home per concern). */
export default function CargoHUD({ onClick }: CargoHUDProps) {
  const used = useAtomValue(cargoUsedUnitsAtom);
  const capacity = useAtomValue(cargoCapacityUnitsAtom);
  const fill = useAtomValue(cargoFillFractionAtom);

  return (
    <div className="cargo-hud" onClick={onClick}>
      <div className="cargo-hud__row">
        <span className="cargo-hud__label">Cargo</span>
        <span className="cargo-hud__amount">
          {used}
          <span className="cargo-hud__slash">/</span>
          {capacity}
        </span>
      </div>

      <div className="cargo-hud__bar">
        <div className="cargo-hud__bar-fill" style={{ width: `${Math.round(fill * 100)}%` }} />
      </div>
    </div>
  );
}
