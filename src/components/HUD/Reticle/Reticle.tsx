"use client";

import { useAtomValue } from "jotai";
import { miningStateAtom, showTargetingIndicatorAtom, targetingProgressAtom } from "@/store/mining";
import "./Reticle.scss";

const CIRCLE_RADIUS = 16;
const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * CIRCLE_RADIUS;

const Reticle = () => {
  const miningState = useAtomValue(miningStateAtom);
  const showTargetingIndicator = useAtomValue(showTargetingIndicatorAtom);
  const targetingProgress = useAtomValue(targetingProgressAtom);

  const strokeDashoffset = CIRCLE_CIRCUMFERENCE * (1 - targetingProgress);

  return (
    <div className="reticle">
      <div className="reticle__center-ring" />

      <div
        className={`reticle__targeting-indicator ${
          showTargetingIndicator && !miningState.isFocused ? "reticle__targeting-indicator--visible" : ""
        }`}
      >
        <svg viewBox="0 0 40 40">
          <circle className="bg" cx="20" cy="20" r={CIRCLE_RADIUS} />
          <circle
            className="progress"
            cx="20"
            cy="20"
            r={CIRCLE_RADIUS}
            strokeDasharray={CIRCLE_CIRCUMFERENCE}
            strokeDashoffset={strokeDashoffset}
          />
        </svg>
      </div>

      <div
        className={`reticle__focused-indicator ${
          miningState.isFocused ? "reticle__focused-indicator--visible" : ""
        }`}
      />
    </div>
  );
};

export default Reticle;
