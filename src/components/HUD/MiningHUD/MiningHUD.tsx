"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { miningStateAtom, startMiningAtom } from "@/store/mining";
import "./MiningHUD.scss";

const MiningHUD = () => {
  const miningState = useAtomValue(miningStateAtom);
  const startMining = useSetAtom(startMiningAtom);

  const handleMineClick = () => {
    startMining();
  };

  const showButton = miningState.isFocused;
  const showProgress = miningState.isMining;

  return (
    <div className="mining-hud">
      <div
        className={`mining-hud__distance ${
          miningState.targetedAsteroid ? "mining-hud__distance--visible" : ""
        }`}
      >
        {miningState.targetedAsteroid
          ? `${Math.round(miningState.targetedAsteroid.distanceM)}m`
          : ""}
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
        Mining... {Math.round(miningState.miningProgress * 100)}%
      </div>

      <button
        className={`mining-hud__button ${showButton ? "mining-hud__button--visible" : ""} ${
          miningState.isMining ? "mining-hud__button--mining" : ""
        }`}
        onClick={handleMineClick}
        disabled={miningState.isMining}
      >
        {miningState.isMining ? "Mining..." : "Mine"}
      </button>
    </div>
  );
};

export default MiningHUD;
