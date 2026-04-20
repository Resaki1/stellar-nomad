"use client";

import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import {
  miningStateAtom,
  showTargetingIndicatorAtom,
  targetingProgressAtom,
} from "@/store/mining";
import { poiBuffer } from "@/store/poi";
import { keybindsAtom, displayKey } from "@/store/keybinds";
import "./Reticle.scss";

const RING_R = 14;
const RING_C = 2 * Math.PI * RING_R;

export default function Reticle() {
  const miningState = useAtomValue(miningStateAtom);
  const showTargeting = useAtomValue(showTargetingIndicatorAtom);
  const targetingProgress = useAtomValue(targetingProgressAtom);
  const keybinds = useAtomValue(keybindsAtom);

  const poiRingContainerRef = useRef<HTMLDivElement>(null);
  const poiRingProgressRef = useRef<SVGCircleElement>(null);
  const poiHintRef = useRef<HTMLDivElement>(null);

  // POI gaze progress lives in a mutable buffer — drive the SVG and hint
  // via rAF so we don't trigger React re-renders for a continuous signal.
  useEffect(() => {
    let running = true;
    let rafId = 0;
    const tick = () => {
      if (!running) return;
      const container = poiRingContainerRef.current;
      const circle = poiRingProgressRef.current;
      const hint = poiHintRef.current;
      if (container && circle) {
        const active = poiBuffer.gazeActive && poiBuffer.gazeProgress > 0.01;
        container.classList.toggle("reticle__ring--visible", active);
        if (active) {
          circle.style.strokeDashoffset = `${RING_C * (1 - poiBuffer.gazeProgress)}`;
        }
      }
      if (hint) {
        const locked =
          poiBuffer.targetedId !== null && poiBuffer.gazeProgress >= 0.99;
        hint.classList.toggle("reticle__hint--visible", locked);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(rafId);
    };
  }, []);

  const isMining = miningState.isMining;
  const showDefault = !isMining;
  const showAsteroidRing = showTargeting && !isMining;
  const showMineHint = miningState.isFocused && !isMining;
  const mineKey = displayKey(keybinds.mine[0] ?? "m");
  const transitKey = displayKey(keybinds.transitDrive[0] ?? "t");

  return (
    <div className="reticle">
      {/* Default: 18px circle + 2 micro-dots */}
      <div
        className={`reticle__default ${
          showDefault ? "reticle__default--visible" : ""
        }`}
      >
        <div className="reticle__circle" />
        <div className="reticle__dot reticle__dot--top" />
        <div className="reticle__dot reticle__dot--bottom" />
      </div>

      {/* Asteroid targeting / focus ring */}
      <div
        className={`reticle__ring reticle__ring--asteroid ${
          showAsteroidRing ? "reticle__ring--visible" : ""
        } ${miningState.isFocused ? "reticle__ring--locked" : ""}`}
      >
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <circle className="reticle__ring-bg" cx="16" cy="16" r={RING_R} />
          <circle
            className="reticle__ring-progress"
            cx="16"
            cy="16"
            r={RING_R}
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - targetingProgress)}
          />
        </svg>
      </div>

      {/* POI gaze ring */}
      <div ref={poiRingContainerRef} className="reticle__ring reticle__ring--poi">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <circle className="reticle__ring-bg" cx="16" cy="16" r={RING_R} />
          <circle
            ref={poiRingProgressRef}
            className="reticle__ring-progress"
            cx="16"
            cy="16"
            r={RING_R}
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C}
          />
        </svg>
      </div>

      {/* Hints */}
      <div
        className={`reticle__hint reticle__hint--mine ${
          showMineHint ? "reticle__hint--visible" : ""
        }`}
      >
        <span className="reticle__hint-key">[{mineKey}]</span>
        <span>MINE</span>
      </div>
      <div ref={poiHintRef} className="reticle__hint reticle__hint--transit">
        <span className="reticle__hint-key">[{transitKey}]</span>
        <span>TRANSIT</span>
      </div>

      {/* Mining brackets */}
      <div
        className={`reticle__brackets ${
          isMining ? "reticle__brackets--visible" : ""
        }`}
      >
        <span className="reticle__bracket reticle__bracket--tl" />
        <span className="reticle__bracket reticle__bracket--tr" />
        <span className="reticle__bracket reticle__bracket--bl" />
        <span className="reticle__bracket reticle__bracket--br" />
      </div>
    </div>
  );
}
