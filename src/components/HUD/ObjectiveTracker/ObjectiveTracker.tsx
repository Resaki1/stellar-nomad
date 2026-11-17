"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import { Check, Circle, FlaskConical, MapPin, Target } from "lucide-react";
import { RESEARCH_NODES, getSiteDef } from "@/data/content";
import { evaluateNode } from "@/sim/research/requirements";
import { evidenceViewAtom } from "@/store/research";
import { trackedStatusAtom } from "@/store/projects";
import { glanceAtom } from "@/store/sites";
import { addToastAtom } from "@/store/toast";
import { transitPreviewAtom, transitStateAtom } from "@/store/transit";

import "./ObjectiveTracker.scss";

/** Max unmet lines shown under the tracked project (deep detail lives in the Projects panel). */
const MAX_LINES = 3;

/** Glance: the tracked project's next steps, research readiness, a survey site in range. */
export default function ObjectiveTracker() {
  const ev = useAtomValue(evidenceViewAtom);
  const status = useAtomValue(trackedStatusAtom);
  const site = useAtomValue(glanceAtom).site;
  const toast = useSetAtom(addToastAtom);
  // Phones: the transit plan/HUD takes this band while it shows (the tracker yields, CSS).
  const preview = useAtomValue(transitPreviewAtom);
  const transitPhase = useAtomValue(transitStateAtom).phase;
  const planShown = preview !== null || transitPhase !== "idle";
  const ready = useMemo(
    () => RESEARCH_NODES.filter((n) => !ev.completed.has(n.id) && evaluateNode(n, ev).met).length,
    [ev],
  );

  // Toast once on the transition to complete (not on load of an already complete project).
  const wasComplete = useRef<{ id: string; complete: boolean } | null>(null);
  useEffect(() => {
    if (!status) return;
    const prev = wasComplete.current;
    if (prev && prev.id === status.id && !prev.complete && status.complete) {
      toast({ message: "Project complete", detail: status.name, kind: "success", durationMs: 5000 });
    }
    wasComplete.current = { id: status.id, complete: status.complete };
  }, [status, toast]);

  const lines = useMemo(() => {
    if (!status || status.complete) return [];
    const out: { text: string; met: boolean; sub: boolean }[] = [];
    for (const l of status.lines) {
      if (l.met) continue;
      out.push({ text: l.text, met: false, sub: false });
      for (const s of l.sub) if (!s.met) out.push({ text: s.text, met: false, sub: true });
      if (out.length >= MAX_LINES) break;
    }
    return out.slice(0, MAX_LINES);
  }, [status]);

  const siteDef = site ? getSiteDef(site.id) : undefined;
  const siteNear = siteDef && site && site.distKm <= siteDef.inspectRangeKm;
  if (!status && ready === 0 && !siteNear) return null;
  return (
    <div className={`objective-tracker${planShown ? " objective-tracker--yield" : ""}`} data-testid="objective-tracker">
      {status && (
        <>
          <div className="objective-tracker__row">
            <Target size={14} strokeWidth={1.75} aria-hidden className="objective-tracker__icon" />
            <span className="objective-tracker__label objective-tracker__label--title">{status.name}</span>
            <span className="objective-tracker__value">{status.complete ? <Check size={13} aria-label="complete" /> : `${status.done}/${status.total}`}</span>
          </div>
          {lines.map((l, i) => (
            <div key={i} className={`objective-tracker__step ${l.sub ? "objective-tracker__step--sub" : ""}`}>
              <Circle size={8} strokeWidth={2} aria-hidden />
              <span>{l.text}</span>
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
      {siteNear && siteDef && site && (
        <div className="objective-tracker__row objective-tracker__row--site" data-testid="site-prompt">
          <MapPin size={14} strokeWidth={1.75} aria-hidden className="objective-tracker__icon" />
          <span className="objective-tracker__label">{site.inspected ? siteDef.name : siteDef.signalName} · {site.distKm.toFixed(2)} km</span>
          <span className="objective-tracker__value">
            {!site.inspected ? "[G] inspect" : site.distKm <= siteDef.recoverRangeKm ? "[G] recover" : `recover < ${siteDef.recoverRangeKm} km`}
          </span>
        </div>
      )}
    </div>
  );
}
