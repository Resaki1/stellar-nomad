"use client";

import { useAtomValue } from "jotai";
import { Microscope } from "lucide-react";
import { assaySamplesAtom, activeResearchNodeAtom } from "@/store/research";

import "./AssaySamplesHUD.scss";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

export default function AssaySamplesHUD() {
  const samples = useAtomValue(assaySamplesAtom);
  const active = useAtomValue(activeResearchNodeAtom);

  return (
    <div className="assay-hud">
      <div className="assay-hud__label">Assay Samples</div>
      <div className="assay-hud__samples">
        <Microscope size={14} strokeWidth={1.75} aria-hidden />
        <span>{samples}</span>
      </div>
      {active && (
        <div className="assay-hud__research">
          <div className="assay-hud__research-label">Active Research</div>
          <div className="assay-hud__research-name">{active.node.name}</div>
          <div className="assay-hud__progress-bar">
            <div
              className="assay-hud__progress-fill"
              style={{
                width: `${Math.min(
                  100,
                  (active.elapsedS / active.node.durationSeconds) * 100,
                )}%`,
              }}
            />
          </div>
          <div className="assay-hud__time">
            {formatTime(
              Math.max(0, active.node.durationSeconds - active.elapsedS),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
