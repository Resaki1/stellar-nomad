"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { keybindsAtom, displayKey } from "@/store/keybinds";
import { settingsIsOpenAtom } from "@/store/store";
import { isDeadAtom } from "@/store/death";
import { playAudio } from "@/audio";
import { setCursorNeeded } from "@/input/pointerLock";
import {
  RESOURCE_WARN_KM,
  activatePointAtom,
  kitCountAtom,
  nearbyPointAtom,
  placePointAtom,
  placementModeAtom,
  placementStatusAtom,
  replicationPointsAtom,
  updateNearbyPoint,
  updatePlacementPreview,
} from "@/store/replication";
import { REPLICATION_TUNING } from "@/sim/replication/points";

import "./ReplicationHUD.scss";

const HUD_RATE_MS = 100;

const isTyping = (e: KeyboardEvent): boolean => {
  const tag = (e.target as HTMLElement)?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};

/** Placement preview panel (B) and the "make active" prompt near a point (H). */
export default function ReplicationHUD() {
  const store = useStore();
  const keybinds = useAtomValue(keybindsAtom);
  const [mode, setMode] = useAtom(placementModeAtom);
  const status = useAtomValue(placementStatusAtom);
  const nearby = useAtomValue(nearbyPointAtom);
  const kits = useAtomValue(kitCountAtom);
  const points = useAtomValue(replicationPointsAtom);
  const place = useSetAtom(placePointAtom);
  const activate = useSetAtom(activatePointAtom);
  const [name, setName] = useState("Point 1");
  const keybindsRef = useRef(keybinds);
  const stateRef = useRef({ mode, nearby, name, count: points.length });
  useEffect(() => {
    keybindsRef.current = keybinds;
    stateRef.current = { mode, nearby, name, count: points.length };
  });

  // Read models at HUD rate (not per frame): preview check and the nearby point.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (store.get(placementModeAtom)) updatePlacementPreview(store);
      updateNearbyPoint(store);
    }, HUD_RATE_MS);
    return () => window.clearInterval(id);
  }, [store]);

  useEffect(() => setCursorNeeded("placement", mode), [mode]);
  useEffect(() => {
    if (mode) updatePlacementPreview(store);
  }, [mode, store]);

  const confirm = useCallback(() => {
    const o = place({ name: stateRef.current.name });
    if (o.status === "rejected") playAudio("ui.reject");
  }, [place]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (store.get(settingsIsOpenAtom) || store.get(isDeadAtom)) return;
      const key = e.key.toLowerCase();
      if (isTyping(e)) {
        if (key === "enter" && stateRef.current.mode) {
          e.preventDefault();
          confirm();
        }
        return;
      }
      const kb = keybindsRef.current;
      if (kb.placePoint.includes(key)) {
        if (!stateRef.current.mode) setName(`Point ${stateRef.current.count}`);
        setMode((m) => !m);
        return;
      }
      if (key === "enter" && stateRef.current.mode) {
        e.preventDefault();
        confirm();
        return;
      }
      if (kb.activatePoint.includes(key)) {
        const n = stateRef.current.nearby;
        if (n && !n.active) activate(n.id);
        else if (n) playAudio("ui.reject");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store, setMode, confirm, activate]);

  const dead = useAtomValue(isDeadAtom);
  useEffect(() => {
    if (dead) setMode(false);
  }, [dead, setMode]);
  if (dead) return null;
  const placeKey = displayKey(keybinds.placePoint[0] ?? "b");
  const activateKey = displayKey(keybinds.activatePoint[0] ?? "h");

  return (
    <>
      {mode && (
        <div className="replication-hud replication-hud--place" role="dialog" aria-label="Place replication point">
          <div className="replication-hud__head">
            <span className="replication-hud__title">Replication point</span>
            <span className="replication-hud__kits">{kits} kit{kits === 1 ? "" : "s"}</span>
          </div>
          <p className={`replication-hud__status ${status?.refusal ? "replication-hud__status--bad" : "replication-hud__status--ok"}`}>
            {status ? (status.refusal ?? "Clear to place") : "Checking…"}
          </p>
          <dl className="replication-hud__facts">
            <dt>Position</dt>
            <dd>{REPLICATION_TUNING.placeDistanceKm.toFixed(1)} km ahead</dd>
            <dt>Emergence</dt>
            <dd>{REPLICATION_TUNING.emergenceKm.toFixed(1)} km on your side</dd>
            <dt>Clearance</dt>
            <dd>{status && Number.isFinite(status.rockClearM) ? `${Math.max(0, status.rockClearM).toFixed(0)} m to rock` : "no rock near"}</dd>
            <dt>Fuel source</dt>
            <dd>{status?.fuelSourceKm != null ? `${status.fuelSourceKm.toFixed(1)} km (known)` : "none known"}</dd>
          </dl>
          {status && (status.fuelSourceKm === null || status.fuelSourceKm > RESOURCE_WARN_KM) && (
            <p className="replication-hud__warn">
              No known hydrate source within {RESOURCE_WARN_KM} km: recovering here may need the origin-point fallback.
            </p>
          )}
          <label className="replication-hud__name">
            <span>Name</span>
            <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} spellCheck={false} />
          </label>
          <div className="replication-hud__actions">
            <button className="replication-hud__btn" onClick={() => setMode(false)}>
              Cancel <kbd>{placeKey}</kbd>
            </button>
            <button className="replication-hud__btn replication-hud__btn--primary" disabled={!!status?.refusal} onClick={confirm}>
              Place <kbd>Enter</kbd>
            </button>
          </div>
        </div>
      )}
      {!mode && nearby && (
        <div className="replication-hud replication-hud--prompt">
          <span className="replication-hud__glyph" aria-hidden>◇</span>
          <span className="replication-hud__pname">{nearby.name}</span>
          <span className="replication-hud__dist">{nearby.distKm.toFixed(2)} km</span>
          {nearby.active ? (
            <span className="replication-hud__activeTag">Active recovery point</span>
          ) : (
            <button className="replication-hud__btn" onClick={() => activate(nearby.id)}>
              Make active <kbd>{activateKey}</kbd>
            </button>
          )}
        </div>
      )}
    </>
  );
}
