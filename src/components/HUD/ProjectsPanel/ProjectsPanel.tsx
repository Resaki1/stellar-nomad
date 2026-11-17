"use client";

import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useMemo, useState } from "react";
import { Check, Circle, Crosshair, Target } from "lucide-react";
import { playAudio } from "@/audio";
import { AUTHORED_PROJECT_IDS, PROJECTS, getProjectDef } from "@/data/projects";
import { RECORDS } from "@/data/guidance";
import { evaluateProject } from "@/sim/research/projects";
import { playedMessageIdsAtom } from "@/store/comms";
import { projectViewAtom, trackedProjectAtom } from "@/store/projects";
import { setDestinationAtom } from "@/store/sites";
import { addToastAtom } from "@/store/toast";
import Panel from "../Shell/Panel";

import "./ProjectsPanel.scss";

type Tab = "projects" | "records";

/** Deep panel: choose a tracked project (optional, any time) and read the help records. */
export default function ProjectsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("projects");
  const [tracked, setTracked] = useAtom(trackedProjectAtom);
  const view = useAtomValue(projectViewAtom);
  const played = useAtomValue(playedMessageIdsAtom);
  const setDestination = useSetAtom(setDestinationAtom);
  const toast = useSetAtom(addToastAtom);
  const [open, setOpen] = useState<string | null>("premise");

  const statuses = useMemo(() => PROJECTS.map((p) => ({ def: p, st: evaluateProject(p.id, view) })), [view]);
  const authored = statuses.filter((s) => AUTHORED_PROJECT_IDS.includes(s.def.id));
  const research = statuses.filter((s) => !AUTHORED_PROJECT_IDS.includes(s.def.id) && !s.st?.complete);

  const track = (id: string | null) => {
    playAudio("click.soft");
    setTracked(id);
  };
  const goTo = (id: string) => {
    const dest = getProjectDef(id)?.destination;
    if (dest && setDestination(dest)) toast({ message: "Destination set", detail: "Check the transit plan, then hold T", durationMs: 3500 });
  };

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
    <Panel title="Projects" subtitle="Optional goals turned into steps. Track one, or none." tier={2} width={560} onClose={onClose} headerRight={tabs}>
      {tab === "projects" ? (
        <div className="pp-list" data-testid="projects-list">
          {authored.map(({ def, st }) => (
            <div key={def.id} className={`pp-card ${tracked === def.id ? "pp-card--tracked" : ""} ${st?.complete ? "pp-card--done" : ""}`} data-project={def.id}>
              <div className="pp-card__head">
                <span className="pp-card__name">{def.name}</span>
                <span className="pp-card__count">{st?.complete ? "complete" : `${st?.done ?? 0} / ${st?.total ?? 0}`}</span>
              </div>
              <div className="pp-card__summary">{def.summary}</div>
              <ul className="pp-card__steps">
                {st?.lines.map((l, i) => (
                  <li key={i} className={l.met ? "pp-step pp-step--met" : "pp-step"}>
                    {l.met ? <Check size={11} strokeWidth={2.25} aria-hidden /> : <Circle size={11} strokeWidth={2} aria-hidden />}
                    <span>{l.text}</span>
                  </li>
                ))}
              </ul>
              <div className="pp-card__actions">
                {tracked === def.id ? (
                  <button type="button" className="pp-btn" onClick={() => track(null)}>Stop tracking</button>
                ) : (
                  <button type="button" className="pp-btn pp-btn--primary" onClick={() => track(def.id)}>
                    <Target size={12} aria-hidden /> Track
                  </button>
                )}
                {def.destination && !st?.complete && (
                  <button type="button" className="pp-btn" onClick={() => goTo(def.id)}>
                    <Crosshair size={12} aria-hidden /> Set destination
                  </button>
                )}
              </div>
            </div>
          ))}
          <div className="pp-section">Research options</div>
          {research.map(({ def, st }) => (
            <div key={def.id} className={`pp-row ${tracked === def.id ? "pp-row--tracked" : ""}`} data-project={def.id}>
              <span className="pp-row__name">{def.name.replace(/^Research: /, "")}</span>
              <span className="pp-row__count">{st && st.lines[0]?.sub.length ? `${st.lines[0].sub.filter((x) => x.met).length} / ${st.lines[0].sub.length}` : ""}</span>
              <button type="button" className="pp-btn" onClick={() => track(tracked === def.id ? null : def.id)}>{tracked === def.id ? "Stop" : "Track"}</button>
            </div>
          ))}
        </div>
      ) : (
        <div className="pp-list">
          {RECORDS.filter((r) => r.after === null || played.includes(r.after)).map((r) => (
            <div key={r.id} className="pp-record" data-record={r.id}>
              <button type="button" className="pp-record__title" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                {r.title}
              </button>
              {open === r.id && r.paragraphs.map((t, i) => <p key={i} className="pp-record__text">{t}</p>)}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
