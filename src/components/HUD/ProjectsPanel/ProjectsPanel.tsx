"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useMemo, useState } from "react";
import { Check, Circle, Crosshair, FlaskConical, Target } from "lucide-react";
import { playAudio } from "@/audio";
import { AUTHORED_PROJECT_IDS, PROJECTS, getProjectDef } from "@/data/projects";
import { RECORDS } from "@/data/guidance";
import { getResearchNode } from "@/data/content";
import { evaluateProject, type ProjectStatus } from "@/sim/research/projects";
import { nodeProgress } from "@/sim/research/requirements";
import { playedMessageIdsAtom } from "@/store/comms";
import { projectViewAtom, trackedProjectAtom } from "@/store/projects";
import { setDestinationAtom } from "@/store/sites";
import { transitDriveOwnedAtom } from "@/store/transit";
import Panel from "../Shell/Panel";
import { LineIcon, LineText, SubChips } from "./projectParts";

import "./ProjectsPanel.scss";

type Tab = "projects" | "records";

type Row = { id: string; name: string; authored: boolean; st: ProjectStatus; met: number; total: number };

/** D15: started projects by fraction (3/4 before 1/3), then 0/x, completed last; ties authored first, then name. */
function sortRows(rows: Row[]): Row[] {
  const rank = (r: Row): number => (r.st.complete ? 2 : r.met > 0 ? 0 : 1);
  return rows.sort((a, b) =>
    rank(a) - rank(b) ||
    b.met / Math.max(1, b.total) - a.met / Math.max(1, a.total) ||
    Number(b.authored) - Number(a.authored) ||
    a.name.localeCompare(b.name));
}

/** Deep panel: choose a tracked project (optional, any time) and read the help records. */
export default function ProjectsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("projects");
  const [tracked, setTracked] = useAtom(trackedProjectAtom);
  const view = useAtomValue(projectViewAtom);
  const played = useAtomValue(playedMessageIdsAtom);
  const setDestination = useSetAtom(setDestinationAtom);
  const driveOwned = useAtomValue(transitDriveOwnedAtom);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const p of PROJECTS) {
      const st = evaluateProject(p.id, view);
      if (!st) continue;
      const authored = AUTHORED_PROJECT_IDS.includes(p.id);
      const node = authored ? undefined : getResearchNode(p.id.slice("research:".length));
      // A research row counts its pieces (evidence + analysis), not its single step.
      const pr = node && !st.complete ? nodeProgress(node, view, view.cargo) : { met: st.done, total: st.total };
      out.push({ id: p.id, name: node?.name ?? p.name, authored, st, met: pr.met, total: pr.total });
    }
    return sortRows(out);
  }, [view]);

  const track = (id: string | null) => {
    playAudio("click.soft");
    setTracked(id);
  };
  const goTo = (id: string) => {
    const dest = getProjectDef(id)?.destination;
    // The transit panel appearing is the feedback (§1.10).
    if (dest && setDestination(dest)) playAudio("click.soft");
  };
  const trackBtn = (id: string) =>
    tracked === id ? (
      <button type="button" className="pp-btn" onClick={() => track(null)}>Stop</button>
    ) : (
      <button type="button" className="pp-btn pp-btn--primary" onClick={() => track(id)}>
        <Target size={12} aria-hidden /> Track
      </button>
    );

  const tabs = (
    <div className="pp-tabs" role="tablist">
      {(["projects", "records"] as Tab[]).map((t) => (
        <button key={t} type="button" role="tab" aria-selected={tab === t} className={`pp-tabs__btn ${tab === t ? "pp-tabs__btn--active" : ""}`} onClick={() => setTab(t)}>
          {t === "projects" ? "Projects" : "Records"}
        </button>
      ))}
    </div>
  );

  return (
    <Panel title="Projects" tier={2} width={560} fixedHeight onClose={onClose} headerRight={tabs}>
      {tab === "projects" ? (
        <div className="pp-list" data-testid="projects-list">
          {rows.map((r) => {
            if (r.st.complete) {
              return (
                <div key={r.id} className="pp-done" data-project={r.id}>
                  <Check size={12} strokeWidth={2.5} aria-hidden />
                  <span data-name="">{r.name}</span>
                </div>
              );
            }
            if (!r.authored) {
              return (
                <div key={r.id} className={`pp-row ${tracked === r.id ? "pp-row--tracked" : ""}`} data-project={r.id}>
                  <FlaskConical size={13} strokeWidth={1.75} aria-hidden className="pp-row__icon" />
                  <span className="pp-row__name" data-name="">{r.name}</span>
                  <span className="pp-count">{r.met}/{r.total}</span>
                  {trackBtn(r.id)}
                </div>
              );
            }
            const def = getProjectDef(r.id);
            return (
              <div key={r.id} className={`pp-card ${tracked === r.id ? "pp-card--tracked" : ""}`} data-project={r.id}>
                <div className="pp-card__head">
                  <Target size={14} strokeWidth={1.75} aria-hidden className="pp-row__icon" />
                  <span className="pp-card__name" data-name="">{r.name}</span>
                  <span className="pp-count">{r.st.done}/{r.st.total}</span>
                </div>
                <ul className="pp-card__steps">
                  {r.st.lines.map((l, i) => (
                    <li key={i} className={l.met ? "pp-step pp-step--met" : "pp-step"} title={l.tip}>
                      {l.met ? <Check size={11} strokeWidth={2.25} aria-hidden /> : <Circle size={10} strokeWidth={2} aria-hidden />}
                      <LineIcon icon={l.icon} />
                      <LineText line={l} />
                      {!l.met && l.sub.length > 0 && <SubChips sub={l.sub} max={8} />}
                    </li>
                  ))}
                </ul>
                <div className="pp-card__actions">
                  {trackBtn(r.id)}
                  {def?.destination && driveOwned && (
                    <button type="button" className="pp-btn" onClick={() => goTo(r.id)}>
                      <Crosshair size={12} aria-hidden /> Set destination
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="pp-list">
          {RECORDS.filter((r) => r.after === null || played.includes(r.after)).map((r) => (
            <div key={r.id} className="pp-record" data-record={r.id}>
              <h3 className="pp-record__title">{r.title}</h3>
              {r.paragraphs.map((t, i) => <p key={i} className="pp-record__text">{t}</p>)}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
