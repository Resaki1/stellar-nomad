"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useMemo, useState } from "react";
import { Bookmark, Check, Circle, Crosshair } from "lucide-react";
import { playAudio } from "@/audio";

import {
  BRANCH_LABELS,
  MATERIAL_NAMES,
  RESEARCH_NODES,
  SOURCE_CLASS_NAMES,
  TRIALS,
  getItemDef,
  materialName,
  type ResearchBranch,
  type ResearchNodeDef,
} from "@/data/content";
import { evaluateNode, missingAnalysis, type RequirementStatus } from "@/sim/research/requirements";
import { cargoAtom } from "@/store/cargo";
import { setDestinationToSourceAtom, sourceLabel } from "@/store/discoveries";
import { newOpId, runOperation } from "@/store/operations";
import { bookmarksAtom, discoveriesMirrorAtom, evidenceViewAtom, unlockResearchAtom } from "@/store/research";
import Panel from "../Shell/Panel";

import "./ResearchPanel.scss";

type Tab = "options" | "discoveries";

const BRANCH_ORDER: ResearchBranch[] = ["survey", "extraction", "thermal", "logistics", "propulsion", "hull", "lunar"];

function EvidenceLine({ s }: { s: RequirementStatus }) {
  return (
    <li className={`rp-evidence ${s.met ? "rp-evidence--met" : ""}`}>
      {s.met ? <Check size={11} strokeWidth={2.25} aria-hidden /> : <Circle size={11} strokeWidth={2} aria-hidden />}
      <span>{s.text}</span>
    </li>
  );
}

function OptionCard({ node }: { node: ResearchNodeDef }) {
  const ev = useAtomValue(evidenceViewAtom);
  const cargo = useAtomValue(cargoAtom);
  const unlock = useSetAtom(unlockResearchAtom);
  const [busy, setBusy] = useState(false);
  const done = ev.completed.has(node.id);
  const e = evaluateNode(node, ev);
  const short = missingAnalysis(node, cargo.items);
  const shortKeys = Object.keys(short);
  const missingCount = e.missing.length;
  const status = done ? "Unlocked" : missingCount > 0 ? `${missingCount} missing` : shortKeys.length > 0 ? "Needs material" : "Ready";
  const tone = done ? "done" : missingCount > 0 ? "missing" : shortKeys.length > 0 ? "material" : "ready";
  const analysis = Object.entries(node.analysis);

  return (
    <div className={`rp-card rp-card--${tone}`} data-node={node.id}>
      <div className="rp-card__head">
        <span className="rp-card__name">{node.name}</span>
        <span className={`rp-card__status rp-card__status--${tone}`}>{status}</span>
      </div>
      <div className="rp-card__purpose">{node.purpose}</div>
      {!done && (
        <>
          <ul className="rp-card__evidence">
            {e.all.map((s) => (
              <EvidenceLine key={s.key} s={s} />
            ))}
          </ul>
          {e.any.length > 0 && (
            <>
              <div className="rp-card__label">{e.anyMet ? "One of (done):" : "Any one of:"}</div>
              <ul className="rp-card__evidence">
                {e.any.map((s) => (
                  <EvidenceLine key={s.key} s={s} />
                ))}
              </ul>
            </>
          )}
          <div className={`rp-card__analysis ${shortKeys.length > 0 ? "rp-card__analysis--short" : ""}`}>
            {analysis.length === 0
              ? "Analysis needs no material."
              : `Analysis uses ${analysis.map(([k, n]) => `${n} ${materialName(k)} (have ${Math.floor(cargo.items[k] ?? 0)})`).join(", ")}.`}
          </div>
        </>
      )}
      <div className="rp-card__unlocks">
        {node.unlocks.items.map((id) => {
          const item = getItemDef(id);
          return (
            <div key={id} className="rp-card__unlock">
              <span className="rp-card__unlock-name">{item?.name ?? id}</span>
              {item && <span className="rp-card__unlock-desc">{item.uiDesc}</span>}
            </div>
          );
        })}
      </div>
      {!done && (
        <button
          className="rp-card__btn"
          disabled={missingCount > 0 || shortKeys.length > 0 || busy}
          onClick={() => {
            setBusy(true);
            unlock({
              nodeId: node.id,
              onSettled: (o) => {
                setBusy(false);
                if (o.status === "accepted") playAudio("click.hard");
              },
            });
          }}
        >
          {missingCount > 0 ? "Evidence missing" : shortKeys.length > 0 ? "Not enough material" : "Analyse and unlock"}
        </button>
      )}
    </div>
  );
}

function OptionsTab() {
  const ev = useAtomValue(evidenceViewAtom);
  const groups = useMemo(() => BRANCH_ORDER.map((b) => ({ branch: b, nodes: RESEARCH_NODES.filter((n) => n.branch === b) })), []);
  const unlocked = RESEARCH_NODES.filter((n) => ev.completed.has(n.id)).length;
  return (
    <div className="rp-options">
      <div className="rp-intro">
        Research adapts known technology to this ship from evidence you gather: inspect and mine new materials, and try equipment once safely.
        Unlocked {unlocked} of {RESEARCH_NODES.length}.
      </div>
      {groups.map((g) => (
        <section key={g.branch} className={`rp-branch rp-branch--${g.branch}`}>
          <div className="rp-branch__label">{BRANCH_LABELS[g.branch]}</div>
          <div className="rp-branch__cards">
            {g.nodes.map((n) => (
              <OptionCard key={n.id} node={n} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SourceRow({ id }: { id: string }) {
  const d = useAtomValue(discoveriesMirrorAtom);
  const bookmarks = useAtomValue(bookmarksAtom);
  const setDestination = useSetAtom(setDestinationToSourceAtom);
  const s = d.sources.find((x) => x.id === id);
  const mark = bookmarks.find((b) => b.sourceId === id);
  const [name, setName] = useState(mark?.name ?? "");
  if (!s) return null;
  const total = Object.values(s.composition).reduce((a, v) => a + v, 0);
  const parts = Object.entries(s.composition)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, n]) => `${materialName(k)} ${n}`);
  const save = (next: string | null) => runOperation({ type: "bookmark.set", opId: newOpId(), sourceId: id, name: next });
  return (
    <div className={`rp-source ${s.depleted ? "rp-source--depleted" : ""}`} data-source={id}>
      <div className="rp-source__head">
        <span className="rp-source__name">{sourceLabel(s, mark?.name)}</span>
        <span className="rp-source__meta">
          {SOURCE_CLASS_NAMES[s.classId] ?? s.classId} · r {Math.round(s.radiusM)} m · {s.depleted ? "depleted" : `${total} units`}
        </span>
      </div>
      <div className="rp-source__comp">{parts.join(" · ")}</div>
      <div className="rp-source__actions">
        {mark ? (
          <>
            <input
              className="rp-source__input"
              value={name}
              maxLength={40}
              placeholder="Name"
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name !== mark.name && save(name)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <button className="rp-source__btn" onClick={() => save(null)} title="Remove bookmark">
              Unmark
            </button>
          </>
        ) : (
          <button className="rp-source__btn" disabled={s.depleted} onClick={() => save("")}>
            <Bookmark size={11} aria-hidden /> Bookmark
          </button>
        )}
        <button className="rp-source__btn" disabled={s.depleted} onClick={() => {
            if (setDestination(id)) playAudio("click.soft");
          }}>
          <Crosshair size={11} aria-hidden /> Set destination
        </button>
      </div>
    </div>
  );
}

function DiscoveriesTab() {
  const d = useAtomValue(discoveriesMirrorAtom);
  const sources = useMemo(() => [...d.sources].reverse(), [d.sources]);
  return (
    <div className="rp-disc">
      <section className="rp-branch">
        <div className="rp-branch__label">Materials</div>
        <ul className="rp-disc__list">
          {Object.keys(MATERIAL_NAMES).map((m) => {
            const f = d.families[m];
            const how = f ? [f.inspected ? "inspected" : null, f.extracted ? "mined" : null].filter(Boolean).join(", ") : "not confirmed yet";
            return (
              <li key={m} className={`rp-evidence ${f ? "rp-evidence--met" : ""}`}>
                {f ? <Check size={11} strokeWidth={2.25} aria-hidden /> : <Circle size={11} strokeWidth={2} aria-hidden />}
                <span>
                  {materialName(m)} <span className="rp-disc__how">{how}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="rp-branch">
        <div className="rp-branch__label">Trials</div>
        <ul className="rp-disc__list">
          {TRIALS.map((t) => (
            <li key={t.id} className={`rp-evidence ${d.trials[t.id] ? "rp-evidence--met" : ""}`}>
              {d.trials[t.id] ? <Check size={11} strokeWidth={2.25} aria-hidden /> : <Circle size={11} strokeWidth={2} aria-hidden />}
              <span>{d.trials[t.id] ? t.name : t.howTo}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="rp-branch">
        <div className="rp-branch__label">Inspected sources ({sources.length})</div>
        {sources.length === 0 ? (
          <div className="rp-intro">Lock a rock and inspect it (G) to record its composition here.</div>
        ) : (
          <div className="rp-disc__sources">
            {sources.map((s) => (
              <SourceRow key={s.id} id={s.id} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default function ResearchPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("options");
  return (
    <Panel
      title="Research"
      tier={2}
      width={760}
      onClose={onClose}
      headerRight={
        <div className="rp-tabs" role="tablist">
          {(["options", "discoveries"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`rp-tabs__btn ${tab === t ? "rp-tabs__btn--active" : ""}`}
              onClick={() => {
                playAudio("click.soft");
                setTab(t);
              }}
            >
              {t === "options" ? "Options" : "Discoveries"}
            </button>
          ))}
        </div>
      }
    >
      {tab === "options" ? <OptionsTab /> : <DiscoveriesTab />}
    </Panel>
  );
}
