"use client";

import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import {
  miningStateAtom,
  showTargetingIndicatorAtom,
  targetingProgressAtom,
} from "@/store/mining";
import { poiBuffer } from "@/store/poi";
import { interactFocusAtom } from "@/store/interact";
import { flightHud } from "../FlightHud/flightHudBuffer";
import { KeyChip } from "../shared/Chips";
import TargetCard from "../TargetCard/TargetCard";
import "./Reticle.scss";

const RING_R = 14;
const RING_C = 2 * Math.PI * RING_R;

export default function Reticle() {
  const miningState = useAtomValue(miningStateAtom);
  const showTargeting = useAtomValue(showTargetingIndicatorAtom);
  const targetingProgress = useAtomValue(targetingProgressAtom);
  const interact = useAtomValue(interactFocusAtom);

  const poiRingContainerRef = useRef<HTMLDivElement>(null);
  const poiRingProgressRef = useRef<SVGCircleElement>(null);
  const poiHintRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    flightHud.els.nose = rootRef.current;
    return () => {
      flightHud.els.nose = null;
    };
  }, []);

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
  // Sites, wrecks and points lock with the same ring (the Target Card then shows the action).
  const interactLocking = !!interact.target && !miningState.targetedAsteroid;
  const showAsteroidRing = !isMining && (showTargeting || interactLocking);
  const ringProgress = interactLocking ? interact.progress : targetingProgress;
  const ringLocked = miningState.isFocused || (interactLocking && interact.focused);

  return (
    <div className="reticle" ref={rootRef}>
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
        } ${ringLocked ? "reticle__ring--locked" : ""}`}
      >
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <circle className="reticle__ring-bg" cx="16" cy="16" r={RING_R} />
          <circle
            className="reticle__ring-progress"
            cx="16"
            cy="16"
            r={RING_R}
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - ringProgress)}
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

      {/* POI lock: the transit key (the Target Card owns every other action, so no [M] hint here). */}
      <div ref={poiHintRef} className="reticle__hint reticle__hint--transit">
        <KeyChip action="transitDrive" />
        <span>Transit</span>
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

      <TargetCard />
    </div>
  );
}
