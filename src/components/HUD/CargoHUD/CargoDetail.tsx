"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo, useState } from "react";

import {
  cargoAtom,
  cargoCapacityUnitsAtom,
  cargoUsedUnitsAtom,
  removeCargoAtom,
} from "@/store/cargo";
import { systemConfigAtom } from "@/store/system";
import { getResourceTypes } from "@/sim/asteroids/resources";

import "./CargoDetail.scss";

type CargoRow = {
  id: string;
  name: string;
  icon: string;
  amount: number;
};

export default function CargoDetail({ onClose }: { onClose: () => void }) {
  const systemConfig = useAtomValue(systemConfigAtom);

  const cargo = useAtomValue(cargoAtom);
  const used = useAtomValue(cargoUsedUnitsAtom);
  const capacity = useAtomValue(cargoCapacityUnitsAtom);
  const removeCargo = useSetAtom(removeCargoAtom);

  // Track per-row jettison amounts
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const resourceMap = useMemo(() => {
    const types = getResourceTypes(systemConfig);
    const map = new Map<string, { name: string; icon: string }>();
    for (const d of types) map.set(d.id, { name: d.name, icon: d.icon ?? "" });
    return map;
  }, [systemConfig]);

  const rows: CargoRow[] = useMemo(() => {
    return Object.entries(cargo.items)
      .map(([id, amount]) => ({ id, amount: Math.max(0, Math.floor(amount)) }))
      .filter((e) => e.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .map((e) => {
        const def = resourceMap.get(e.id);
        return {
          id: e.id,
          amount: e.amount,
          name: def?.name ?? e.id,
          icon: def?.icon ?? "",
        };
      });
  }, [cargo.items, resourceMap]);

  const handleAmountChange = useCallback((id: string, value: string) => {
    // Allow only digits
    const cleaned = value.replace(/\D/g, "");
    setAmounts((prev) => ({ ...prev, [id]: cleaned }));
  }, []);

  const handleJettison = useCallback(
    (id: string, max: number) => {
      const raw = amounts[id];
      if (!raw) return;
      const qty = Math.min(parseInt(raw, 10) || 0, max);
      if (qty <= 0) return;
      removeCargo({ resourceId: id, amount: qty });
      setAmounts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    [amounts, removeCargo]
  );

  return (
    <div className="cargo-detail__backdrop" onClick={onClose}>
      <div className="cargo-detail" onClick={(e) => e.stopPropagation()}>
        <div className="cargo-detail__header">
          <div className="cargo-detail__title">Cargo Hold</div>
          <div className="cargo-detail__capacity">
            {used} / {capacity} units
          </div>
          <button className="cargo-detail__close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="cargo-detail__bar">
          <div
            className="cargo-detail__bar-fill"
            style={{
              width: `${capacity > 0 ? Math.round((used / capacity) * 100) : 0}%`,
            }}
          />
        </div>

        <div className="cargo-detail__list">
          {rows.length === 0 ? (
            <div className="cargo-detail__empty">Cargo hold is empty</div>
          ) : (
            rows.map((r) => (
              <div key={r.id} className="cargo-detail__row">
                <div className="cargo-detail__resource">
                  {r.icon && (
                    <span className="cargo-detail__icon">{r.icon}</span>
                  )}
                  <span className="cargo-detail__name">{r.name}</span>
                  <span className="cargo-detail__amount">{r.amount}</span>
                </div>
                <div className="cargo-detail__actions">
                  <input
                    type="text"
                    inputMode="numeric"
                    className="cargo-detail__input"
                    placeholder="0"
                    value={amounts[r.id] ?? ""}
                    onChange={(e) => handleAmountChange(r.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleJettison(r.id, r.amount);
                    }}
                  />
                  <button
                    className="cargo-detail__jettison"
                    disabled={!amounts[r.id] || parseInt(amounts[r.id], 10) <= 0}
                    onClick={() => handleJettison(r.id, r.amount)}
                  >
                    Jettison
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
