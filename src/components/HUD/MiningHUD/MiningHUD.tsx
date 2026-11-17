"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { keybindsAtom } from "@/store/keybinds";
import { miningStateAtom, startMiningAtom, cancelMiningAtom, startInspectionAtom, cancelInspectionAtom } from "@/store/mining";
import { discoveriesMirrorAtom } from "@/store/research";
import { INSPECT_RANGE_M, materialName } from "@/data/content";
import { sourceIdOf } from "@/sim/research/discoveries";
import {
  cargoCapacityUnitsAtom,
  cargoUsedUnitsAtom,
  isCargoFullAtom,
} from "@/store/cargo";
import { systemConfigAtom } from "@/store/system";
import { getAsteroidClass, computeMiningDurationS, getResourceType } from "@/sim/asteroids/resources";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { computedModifiersAtom, getFlag } from "@/store/modules";
import { pulseMiningActiveAtom, togglePulseMiningAtom } from "@/store/mining";

import { playAudio } from "@/audio";
import "./MiningHUD.scss";

export default function MiningHUD() {
  const miningState = useAtomValue(miningStateAtom);

  const systemConfig = useAtomValue(systemConfigAtom);
  const shipConfig = useAtomValue(effectiveShipConfigAtom);
  const modifiers = useAtomValue(computedModifiersAtom);
  const showCompositionBands = getFlag(modifiers, "scanner.lockShowsCompositionBands");
  const discoveries = useAtomValue(discoveriesMirrorAtom);
  const startInspection = useSetAtom(startInspectionAtom);
  const cancelInspection = useSetAtom(cancelInspectionAtom);
  const pulseMiningUnlocked = getFlag(modifiers, "ability.pulseMiningEnabled");

  const pulseMiningActive = useAtomValue(pulseMiningActiveAtom);
  const togglePulseMining = useSetAtom(togglePulseMiningAtom);

  const cargoUsedUnits = useAtomValue(cargoUsedUnitsAtom);
  const cargoCapacityUnits = useAtomValue(cargoCapacityUnitsAtom);
  const cargoFull = useAtomValue(isCargoFullAtom);

  const startMining = useSetAtom(startMiningAtom);
  const cancelMining = useSetAtom(cancelMiningAtom);

  const lootPreview = useMemo(() => {
    const t = miningState.targetedAsteroid;
    if (!t) return null;

    const classDef = getAsteroidClass(
      systemConfig,
      t.location.fieldId,
      t.instanceId
    );

    const baseDurationS = computeMiningDurationS(t.radiusM);
    const durationS = baseDurationS / shipConfig.miningSpeedMult;

    // Composition bands: top resources by midpoint fraction
    let compositionBands: string[] = [];
    if (classDef && showCompositionBands) {
      compositionBands = classDef.resources
        .map((r) => ({
          id: r.resourceId,
          mid: (r.min + r.max) / 2,
        }))
        .filter((r) => r.mid > 0.05) // skip trace amounts
        .sort((a, b) => b.mid - a.mid)
        .slice(0, 3)
        .map((r) => {
          const rt = getResourceType(systemConfig, r.id);
          return rt?.name ?? r.id;
        });
    }

    // Close inspection on record: composition and a yield estimate the player can act on.
    const source = discoveries.sources.find((x) => x.id === sourceIdOf(t.location.fieldId, t.location.chunkKey, t.instanceId)) ?? null;
    const inspected = source
      ? Object.entries(source.composition)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => ({ id: k, name: materialName(k), units: Math.max(1, Math.round(n * shipConfig.miningEfficiencyMult)) }))
      : null;
    const inspectRangeM = INSPECT_RANGE_M * shipConfig.scannerInspectRangeMult;

    return {
      className: classDef?.name ?? "Unknown",
      durationS,
      compositionBands,
      inspected,
      inRange: t.distanceM <= inspectRangeM,
      inspectRangeKm: inspectRangeM / 1000,
    };
  }, [miningState.targetedAsteroid, systemConfig, shipConfig.miningSpeedMult, shipConfig.miningEfficiencyMult, shipConfig.scannerInspectRangeMult, showCompositionBands, discoveries.sources]);

  const showInfo = miningState.isFocused;
  const showButton = miningState.isFocused;
  const showProgress = miningState.isMining;

  const mineDisabled =
    !miningState.isMining && (cargoFull || miningState.isOverheated);
  const showCargoFullWarning = showButton && !miningState.isMining && cargoFull;
  const showOverheatWarning =
    showButton && !miningState.isMining && miningState.isOverheated && !cargoFull;

  // laserHeat is the ship's one thermal store: show it here only around mining (the dashboard always shows it).
  const showHeatBar = miningState.isMining || miningState.isOverheated || (miningState.laserHeat > 0 && miningState.targetedAsteroid !== null);

  const inspecting = miningState.inspectProgress > 0;
  const canInspect = showInfo && !!lootPreview && !lootPreview.inspected && lootPreview.inRange && !miningState.isMining;
  const handleInspect = () => {
    if (inspecting) cancelInspection();
    else if (canInspect) startInspection();
    else playAudio("ui.reject");
  };
  const handleInspectRef = useRef(handleInspect);
  useEffect(() => {
    handleInspectRef.current = handleInspect;
  });

  const handleMineClick = () => {
    if (miningState.isMining) cancelMining();
    else startMining();
  };

  // Mine hotkey — reads bound keys from keybinds store
  const keybinds = useAtomValue(keybindsAtom);
  const keybindsRef = useRef(keybinds);
  keybindsRef.current = keybinds;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const key = e.key.toLowerCase();
      if (!keybindsRef.current.mine.includes(key)) return;

      if (miningState.isMining) {
        cancelMining();
      } else if (miningState.isFocused && !cargoFull && !miningState.isOverheated) {
        startMining();
      } else {
        // No target, full hold or an overheated cutter: the key did nothing,
        // and a silent refusal reads as a dropped input.
        playAudio("ui.reject");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [miningState.isFocused, miningState.isMining, miningState.isOverheated, cargoFull, startMining, cancelMining]);

  // Inspect hotkey
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (keybindsRef.current.inspect.includes(e.key.toLowerCase())) handleInspectRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Pulse mining hotkey
  useEffect(() => {
    if (!pulseMiningUnlocked) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const key = e.key.toLowerCase();
      if (keybindsRef.current.togglePulseMining.includes(key)) {
        togglePulseMining();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pulseMiningUnlocked, togglePulseMining]);

  return (
    <div className="mining-hud">
      {/* Inspection result: its own fixed block right of the reticle (the info column is transformed). */}
      {lootPreview?.inspected && (
        <div className={`mining-hud__inspected ${showInfo ? "mining-hud__inspected--visible" : ""}`}>
          <div className="mining-hud__yield-estimate">
            Inspected · est. yield {lootPreview.inspected.reduce((a, r) => a + r.units, 0)} units
          </div>
          {lootPreview.inspected.slice(0, 4).map((r) => (
            <div key={r.id} className="mining-hud__comp-row">
              <span>{r.name}</span>
              <span>{r.units}</span>
            </div>
          ))}
        </div>
      )}

      {/* Info panel – positioned above the reticle */}
      <div className={`mining-hud__info ${showInfo ? "mining-hud__info--visible" : ""}`}>
        <div className="mining-hud__distance">
          {miningState.targetedAsteroid
            ? `${Math.round(miningState.targetedAsteroid.distanceM)}m`
            : ""}
        </div>

        <div className="mining-hud__loot">
          {lootPreview ? `${lootPreview.className} · ~${lootPreview.durationS.toFixed(1)}s` : ""}
        </div>

        {lootPreview && !lootPreview.inspected && lootPreview.compositionBands.length > 0 && (
          <div className="mining-hud__composition">
            {lootPreview.compositionBands.join(" · ")}
          </div>
        )}


        {lootPreview && !lootPreview.inspected && showInfo && (
          <div className="mining-hud__inspect">
            {inspecting ? (
              <>
                <div className="mining-hud__inspect-bar">
                  <div className="mining-hud__inspect-fill" style={{ width: `${Math.round(miningState.inspectProgress * 100)}%` }} />
                </div>
                <span className="mining-hud__inspect-text">Inspecting… {Math.round(miningState.inspectProgress * 100)}%</span>
              </>
            ) : lootPreview.inRange ? (
              <button className="mining-hud__inspect-btn" onClick={handleInspect} disabled={miningState.isMining}>
                Inspect <span className="mining-hud__hotkey">{(keybinds.inspect[0] ?? "g").toUpperCase()}</span>
              </button>
            ) : (
              <span className="mining-hud__inspect-text">Inspect within {lootPreview.inspectRangeKm.toFixed(1)} km</span>
            )}
          </div>
        )}

        <div className="mining-hud__cargo" hidden={!!lootPreview?.inspected}>
          Cargo: {cargoUsedUnits}/{cargoCapacityUnits}
        </div>

        <div
          className={`mining-hud__warning ${
            showCargoFullWarning ? "mining-hud__warning--visible" : ""
          }`}
        >
          Cargo is full
        </div>

        <div
          className={`mining-hud__warning mining-hud__warning--overheat ${
            showOverheatWarning ? "mining-hud__warning--visible" : ""
          }`}
        >
          Overheated
        </div>
      </div>

      {/* Pulse mining mode indicator — docked above the ShipDashboard
          (bottom-right) so it reads as a persistent "laser mode" instrument
          rather than a center-of-screen button over the ship. */}
      {pulseMiningUnlocked && (
        <button
          className={`mining-hud__pulse-toggle ${pulseMiningActive ? "mining-hud__pulse-toggle--active" : ""}`}
          onClick={() => togglePulseMining()}
          title={pulseMiningActive ? "Switch to Continuous Mining (P)" : "Switch to Pulse Mining (P)"}
        >
          <span className="mining-hud__pulse-label">LASER</span>
          <span className="mining-hud__pulse-mode">
            {pulseMiningActive ? "PULSE" : "CONT"}
          </span>
          <span className="mining-hud__pulse-key">P</span>
        </button>
      )}

      {/* Actions – positioned at bottom center */}
      <div className="mining-hud__actions">
        {/* Heat bar */}
        <div
          className={`mining-hud__heat-container ${
            showHeatBar ? "mining-hud__heat-container--visible" : ""
          }`}
        >
          <div
            className={`mining-hud__heat-bar ${
              miningState.isOverheated ? "mining-hud__heat-bar--overheated" : ""
            } ${miningState.laserHeat > 0.75 && !miningState.isOverheated ? "mining-hud__heat-bar--warning" : ""}`}
            style={{ width: `${miningState.laserHeat * 100}%` }}
          />
          <span className="mining-hud__heat-label">HEAT</span>
        </div>

        <div
          className={`mining-hud__progress-container ${
            showProgress ? "mining-hud__progress-container--visible" : ""
          }`}
        >
          <div
            className="mining-hud__progress-bar"
            style={{ width: `${miningState.miningProgress * 100}%` }}
          />
        </div>

        <div
          className={`mining-hud__progress-text ${
            showProgress ? "mining-hud__progress-text--visible" : ""
          }`}
        >
          {miningState.isMining ? "Mining..." : ""}{" "}
          {Math.round(miningState.miningProgress * 100)}%
        </div>

        <button
          onClick={handleMineClick}
          disabled={mineDisabled}
          className={`mining-hud__button ${showButton ? "mining-hud__button--visible" : ""} ${
            miningState.isMining ? "mining-hud__button--mining" : ""
          } ${mineDisabled ? "mining-hud__button--disabled" : ""}`}
        >
          {miningState.isMining ? "Abort Mining" : "Mine"}
          {!miningState.isMining && showButton && !mineDisabled && (
            <span className="mining-hud__hotkey">M</span>
          )}
        </button>
      </div>
    </div>
  );
}
