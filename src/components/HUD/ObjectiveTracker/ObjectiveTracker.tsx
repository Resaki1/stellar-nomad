"use client";

import { useAtomValue } from "jotai";
import { FlaskConical, Microscope } from "lucide-react";
import { assaySamplesAtom, activeResearchNodeAtom } from "@/store/research";

import "./ObjectiveTracker.scss";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

export default function ObjectiveTracker() {
  const samples = useAtomValue(assaySamplesAtom);
  const active = useAtomValue(activeResearchNodeAtom);

  return (
    <div className="objective-tracker">
      <div className="objective-tracker__row">
        <Microscope
          size={14}
          strokeWidth={1.75}
          aria-hidden
          className="objective-tracker__icon"
        />
        <span className="objective-tracker__label">Assay Samples</span>
        <span className="objective-tracker__value">{samples}</span>
      </div>

      {active && (
        <div className="objective-tracker__row objective-tracker__row--progress">
          <FlaskConical
            size={14}
            strokeWidth={1.75}
            aria-hidden
            className="objective-tracker__icon"
          />
          <span className="objective-tracker__label">{active.node.name}</span>
          <span className="objective-tracker__value">
            {formatTime(
              Math.max(0, active.node.durationSeconds - active.elapsedS),
            )}
          </span>
          <div className="objective-tracker__bar">
            <div
              className="objective-tracker__bar-fill"
              style={{
                width: `${Math.min(
                  100,
                  (active.elapsedS / active.node.durationSeconds) * 100,
                )}%`,
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
