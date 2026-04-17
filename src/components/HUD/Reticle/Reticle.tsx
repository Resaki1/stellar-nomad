"use client";

import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { miningStateAtom, showTargetingIndicatorAtom, targetingProgressAtom } from "@/store/mining";
import { poiBuffer } from "@/store/poi";
import "./Reticle.scss";

const CIRCLE_RADIUS = 16;
const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * CIRCLE_RADIUS;

const Reticle = () => {
  const miningState = useAtomValue(miningStateAtom);
  const showTargetingIndicator = useAtomValue(showTargetingIndicatorAtom);
  const targetingProgress = useAtomValue(targetingProgressAtom);

  // POI gaze progress — read from mutable buffer via rAF (no React rerenders).
  const poiProgressCircleRef = useRef<SVGCircleElement>(null);
  const poiContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let running = true;
    const tick = () => {
      if (!running) return;
      const container = poiContainerRef.current;
      const circle = poiProgressCircleRef.current;
      if (container && circle) {
        const active = poiBuffer.gazeActive && poiBuffer.gazeProgress > 0.01;
        container.classList.toggle("reticle__poi-indicator--visible", active);
        if (active) {
          const offset = CIRCLE_CIRCUMFERENCE * (1 - poiBuffer.gazeProgress);
          circle.style.strokeDashoffset = `${offset}`;
        }
      }
      requestAnimationFrame(tick);
    };
    const id = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(id);
    };
  }, []);

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
        ref={poiContainerRef}
        className="reticle__poi-indicator"
      >
        <svg viewBox="0 0 40 40">
          <circle className="bg" cx="20" cy="20" r={CIRCLE_RADIUS} />
          <circle
            ref={poiProgressCircleRef}
            className="progress"
            cx="20"
            cy="20"
            r={CIRCLE_RADIUS}
            strokeDasharray={CIRCLE_CIRCUMFERENCE}
            strokeDashoffset={CIRCLE_CIRCUMFERENCE}
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
