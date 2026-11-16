"use client";

import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { FlaskConical } from "lucide-react";
import { RESEARCH_NODES } from "@/data/content";
import { evaluateNode } from "@/sim/research/requirements";
import { evidenceViewAtom } from "@/store/research";

import "./ObjectiveTracker.scss";

/** Glance line: research options whose evidence is complete (no universal counter). */
export default function ObjectiveTracker() {
  const ev = useAtomValue(evidenceViewAtom);
  const ready = useMemo(
    () => RESEARCH_NODES.filter((n) => !ev.completed.has(n.id) && evaluateNode(n, ev).met).length,
    [ev],
  );
  if (ready === 0) return null;
  return (
    <div className="objective-tracker">
      <div className="objective-tracker__row">
        <FlaskConical size={14} strokeWidth={1.75} aria-hidden className="objective-tracker__icon" />
        <span className="objective-tracker__label">Research ready</span>
        <span className="objective-tracker__value">{ready}</span>
      </div>
    </div>
  );
}
