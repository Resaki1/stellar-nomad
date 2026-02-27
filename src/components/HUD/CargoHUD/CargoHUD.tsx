"use client";

import { useAtomValue } from "jotai";
import { useMemo } from "react";

import {
  cargoAtom,
  cargoCapacityUnitsAtom,
  cargoFillFractionAtom,
  cargoUsedUnitsAtom,
} from "@/store/cargo";
import { systemConfigAtom } from "@/store/system";
import { getResourceTypes } from "@/sim/asteroids/resources";

import "./CargoHUD.scss";

type CargoHUDProps = {
  onClick?: () => void;
};

type CargoRow = {
  id: string;
  name: string;
  icon: string;
  amount: number;
};

export default function CargoHUD({ onClick }: CargoHUDProps) {
  const systemConfig = useAtomValue(systemConfigAtom);

  const cargo = useAtomValue(cargoAtom);
  const used = useAtomValue(cargoUsedUnitsAtom);
  const capacity = useAtomValue(cargoCapacityUnitsAtom);
  const fill = useAtomValue(cargoFillFractionAtom);

  const resourceMap = useMemo(() => {
    const types = getResourceTypes(systemConfig);
    const map = new Map<string, { name: string; icon: string }>();
    for (const d of types) map.set(d.id, { name: d.name, icon: d.icon ?? "" });
    return map;
  }, [systemConfig]);

  const rows: CargoRow[] = useMemo(() => {
    const entries = Object.entries(cargo.items)
      .map(([id, amount]) => ({ id, amount: Math.max(0, Math.floor(amount)) }))
      .filter((e) => e.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 8);

    return entries.map((e) => {
      const def = resourceMap.get(e.id);
      return {
        id: e.id,
        amount: e.amount,
        name: def?.name ?? e.id,
        icon: def?.icon ?? "",
      };
    });
  }, [cargo.items, resourceMap]);

  return (
    <div className="cargo-hud" onClick={onClick}>
      <div className="cargo-hud__header">
        <div className="cargo-hud__title">Cargo</div>
        <div className="cargo-hud__amount">
          {used}/{capacity}
        </div>
      </div>

      <div className="cargo-hud__bar">
        <div
          className="cargo-hud__bar-fill"
          style={{ width: `${Math.round(fill * 100)}%` }}
        />
      </div>

      <div className="cargo-hud__list">
        {rows.length === 0 ? (
          <div className="cargo-hud__empty">Empty</div>
        ) : (
          rows.map((r) => (
            <div key={r.id} className="cargo-hud__row">
              <div className="cargo-hud__resource">
                {r.icon ? (
                  <span className="cargo-hud__icon">{r.icon}</span>
                ) : null}
                <span className="cargo-hud__name">{r.name}</span>
              </div>
              <div className="cargo-hud__count">{r.amount}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
