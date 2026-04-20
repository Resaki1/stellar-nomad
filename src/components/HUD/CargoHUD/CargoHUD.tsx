"use client";

import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";

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

const DELTA_TTL_MS = 5000;
const DELTA_MAX = 3;

type CargoDelta = {
  key: string;
  id: string;
  name: string;
  amount: number;
  expiresAt: number;
};

export default function CargoHUD({ onClick }: CargoHUDProps) {
  const systemConfig = useAtomValue(systemConfigAtom);

  const cargo = useAtomValue(cargoAtom);
  const used = useAtomValue(cargoUsedUnitsAtom);
  const capacity = useAtomValue(cargoCapacityUnitsAtom);
  const fill = useAtomValue(cargoFillFractionAtom);

  const resourceMap = useMemo(() => {
    const types = getResourceTypes(systemConfig);
    const map = new Map<string, { name: string }>();
    for (const d of types) map.set(d.id, { name: d.name });
    return map;
  }, [systemConfig]);

  // Diff `cargo.items` against the previous snapshot to surface positive
  // deltas as transient "+N Resource" rows. No global atom needed — the
  // glance tier only shows what changed recently.
  const prevItemsRef = useRef<Record<string, number>>({});
  const [deltas, setDeltas] = useState<CargoDelta[]>([]);
  const deltaCounterRef = useRef(0);

  useEffect(() => {
    const prev = prevItemsRef.current;
    const curr = cargo.items;
    const now = performance.now();
    const newDeltas: CargoDelta[] = [];

    for (const id in curr) {
      const delta =
        Math.floor(curr[id] ?? 0) - Math.floor(prev[id] ?? 0);
      if (delta > 0) {
        deltaCounterRef.current += 1;
        newDeltas.push({
          key: `${id}-${deltaCounterRef.current}`,
          id,
          name: resourceMap.get(id)?.name ?? id,
          amount: delta,
          expiresAt: now + DELTA_TTL_MS,
        });
      }
    }

    prevItemsRef.current = { ...curr };

    if (newDeltas.length > 0) {
      setDeltas((prev) =>
        [...newDeltas, ...prev].filter((d) => d.expiresAt > now).slice(0, 8),
      );
    }
  }, [cargo.items, resourceMap]);

  // Prune expired deltas on a coarse timer so we don't rerender every frame.
  useEffect(() => {
    if (deltas.length === 0) return;
    const timer = window.setInterval(() => {
      const now = performance.now();
      setDeltas((prev) => {
        const next = prev.filter((d) => d.expiresAt > now);
        return next.length === prev.length ? prev : next;
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, [deltas.length]);

  const visibleDeltas = deltas.slice(0, DELTA_MAX);

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
        <div
          className="cargo-hud__bar-fill"
          style={{ width: `${Math.round(fill * 100)}%` }}
        />
      </div>

      <div className="cargo-hud__deltas">
        {visibleDeltas.map((d) => (
          <div key={d.key} className="cargo-hud__delta">
            +{d.amount} {d.name}
          </div>
        ))}
      </div>
    </div>
  );
}
