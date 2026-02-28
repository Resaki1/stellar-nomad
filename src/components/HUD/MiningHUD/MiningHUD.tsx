"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo } from "react";
import { miningStateAtom, startMiningAtom, cancelMiningAtom } from "@/store/mining";
import {
  cargoCapacityUnitsAtom,
  cargoUsedUnitsAtom,
  isCargoFullAtom,
} from "@/store/cargo";
import { systemConfigAtom } from "@/store/system";
import { getAsteroidClass, computeMiningDurationS } from "@/sim/asteroids/resources";

import "./MiningHUD.scss";

export default function MiningHUD() {
  const miningState = useAtomValue(miningStateAtom);

  const systemConfig = useAtomValue(systemConfigAtom);

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

    const durationS = computeMiningDurationS(t.radiusM);

    return {
      className: classDef?.name ?? "Unknown",
      durationS,
    };
  }, [miningState.targetedAsteroid, systemConfig]);

  const showInfo = miningState.isFocused;
  const showButton = miningState.isFocused;
  const showProgress = miningState.isMining;

  const mineDisabled = !miningState.isMining && cargoFull;
  const showCargoFullWarning = showButton && !miningState.isMining && cargoFull;

  const handleMineClick = () => {
    if (miningState.isMining) cancelMining();
    else startMining();
  };

  // 'M' hotkey to start / abort mining
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "m" || e.key === "M") {
        // Ignore if user is typing in an input/textarea
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

        if (miningState.isMining) {
          cancelMining();
        } else if (miningState.isFocused && !cargoFull) {
          startMining();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [miningState.isFocused, miningState.isMining, cargoFull, startMining, cancelMining]);

  return (
    <div className="mining-hud">
      {/* Info panel – positioned above the reticle */}
      <div className={`mining-hud__info ${showInfo ? "mining-hud__info--visible" : ""}`}>
        <div className="mining-hud__distance">
          {miningState.targetedAsteroid
            ? `${Math.round(miningState.targetedAsteroid.distanceM)}m`
            : ""}
        </div>

        <div className="mining-hud__loot">
          {lootPreview
            ? `${lootPreview.className} · ~${lootPreview.durationS.toFixed(1)}s`
            : ""}
        </div>

        <div className="mining-hud__cargo">
          Cargo: {cargoUsedUnits}/{cargoCapacityUnits}
        </div>

        <div
          className={`mining-hud__warning ${
            showCargoFullWarning ? "mining-hud__warning--visible" : ""
          }`}
        >
          Cargo is full
        </div>
      </div>

      {/* Actions – positioned at bottom center */}
      <div className="mining-hud__actions">
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
