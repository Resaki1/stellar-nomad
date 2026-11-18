"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { Check, FlaskConical, Target } from "lucide-react";
import { RESEARCH_NODES, getResearchNode } from "@/data/content";
import { evaluateNode, missingAnalysis, nodeProgress } from "@/sim/research/requirements";
import { cargoAtom } from "@/store/cargo";
import { evidenceViewAtom } from "@/store/research";
import { trackedProjectAtom, trackedStatusAtom } from "@/store/projects";
import { addToastAtom } from "@/store/toast";
import { transitPreviewAtom, transitStateAtom } from "@/store/transit";

import { LineIcon, LineText, SubChips } from "../ProjectsPanel/projectParts";

import "./ObjectiveTracker.scss";

/** Max unmet steps (and chips) under the tracked project (deep detail lives in the Projects panel). */
const MAX_LINES = 3;

/** Glance: the tracked project's next steps and research readiness (sites are Target Card targets, D12). */
export default function ObjectiveTracker() {
  const ev = useAtomValue(evidenceViewAtom);
  const cargo = useAtomValue(cargoAtom).items;
  const status = useAtomValue(trackedStatusAtom);
  // A research project reads as the option itself: its name, its pieces fraction, its chips (as in the panels).
  const node = status?.id.startsWith("research:") ? getResearchNode(status.id.slice("research:".length)) : undefined;
  const name = node?.name ?? status?.name ?? "";
  const toast = useSetAtom(addToastAtom);
  const setTracked = useSetAtom(trackedProjectAtom);
  // Phones: the transit plan/HUD takes this band while it shows (the tracker yields, CSS).
  const preview = useAtomValue(transitPreviewAtom);
  const transitPhase = useAtomValue(transitStateAtom).phase;
  const planShown = preview !== null || transitPhase !== "idle";
  // Same rule as the Research panel's "Ready" card: evidence met AND the analysis in the hold.
  const ready = useMemo(
    () => RESEARCH_NODES.filter((n) => !ev.completed.has(n.id) && evaluateNode(n, ev).met && Object.keys(missingAnalysis(n, cargo)).length === 0).length,
    [ev, cargo],
  );

  // Toast once on the transition to complete (not on load of an already complete project);
  // a complete project is never tracked (B14).
  const wasComplete = useRef<{ id: string; complete: boolean } | null>(null);
  useEffect(() => {
    if (!status) return;
    const prev = wasComplete.current;
    if (prev && prev.id === status.id && !prev.complete && status.complete) {
      toast({ message: "Project complete", detail: name, kind: "success" });
    }
    wasComplete.current = { id: status.id, complete: status.complete };
    if (status.complete) setTracked(null);
  }, [status, name, toast, setTracked]);

  // Unmet steps only; a research step brings its open requirement chips (max 3, spec §4.3).
  const lines = useMemo(() => (status && !status.complete && !node ? status.lines.filter((l) => !l.met).slice(0, MAX_LINES) : []), [status, node]);
  const progress = node ? nodeProgress(node, ev, cargo) : null;

  if (!status && ready === 0) return null;
  return (
    <div className={`objective-tracker${planShown ? " objective-tracker--yield" : ""}`} data-testid="objective-tracker">
      {status && (
        <>
          <div className="objective-tracker__row">
            {node ? <FlaskConical size={14} strokeWidth={1.75} aria-hidden className="objective-tracker__icon" /> : <Target size={14} strokeWidth={1.75} aria-hidden className="objective-tracker__icon" />}
            <span className="objective-tracker__label objective-tracker__label--title" data-name="">{name}</span>
            <span className="objective-tracker__value">{status.complete ? <Check size={13} aria-label="complete" /> : progress ? `${progress.met}/${progress.total}` : `${status.done}/${status.total}`}</span>
          </div>
          {node && !status.complete && status.lines[0]?.sub.length > 0 && (
            <div className="objective-tracker__step">
              <SubChips sub={status.lines[0].sub} max={MAX_LINES} />
            </div>
          )}
          {lines.map((l, i) => (
            <div key={i} className="objective-tracker__step">
              <LineIcon icon={l.icon} size={11} />
              <LineText line={l} />
              {i === 0 && l.sub.length > 0 && <SubChips sub={l.sub} max={MAX_LINES} />}
            </div>
          ))}
        </>
      )}
      {ready > 0 && (
        <div className="objective-tracker__row">
          <FlaskConical size={14} strokeWidth={1.75} aria-hidden className="objective-tracker__icon" />
          <span className="objective-tracker__label">Research ready</span>
          <span className="objective-tracker__value">{ready}</span>
        </div>
      )}
    </div>
  );
}
