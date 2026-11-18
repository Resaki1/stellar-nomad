"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, BookmarkCheck, Check, Crosshair, Pickaxe, ScanLine } from "lucide-react";
import { playAudio } from "@/audio";

import {
  BRANCH_LABELS,
  MATERIAL_NAMES,
  RESEARCH_NODES,
  TRIALS,
  describeEffect,
  getItemDef,
  getItemIconUrl,
  type ResearchBranch,
  type ResearchNodeDef,
} from "@/data/content";
import { evaluateNode, missingAnalysis, nodeProgress, sourceClassBadge, type EvidenceView } from "@/sim/research/requirements";
import { cargoAtom } from "@/store/cargo";
import { setDestinationToSourceAtom } from "@/store/discoveries";
import { transitDriveOwnedAtom } from "@/store/transit";
import { newOpId, runOperation } from "@/store/operations";
import { bookmarksAtom, discoveriesMirrorAtom, evidenceViewAtom, unlockResearchAtom } from "@/store/research";
import { AnalysisChips, KeyChip, ReqAnyGroup, ReqChip, ResourceGlyph, ResourceIcon, Tooltip } from "../shared/Chips";
import Panel from "../Shell/Panel";

import "./ResearchPanel.scss";

type Tab = "options" | "discoveries";

const BRANCH_ORDER: ResearchBranch[] = ["survey", "extraction", "thermal", "logistics", "propulsion", "hull", "lunar"];

/** Fraction ring: met / total pieces (analysis included). */
function Ring({ met, total }: { met: number; total: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const f = total > 0 ? met / total : 0;
  return (
    <span className="rp-ring" aria-label={`${met} of ${total}`}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle cx="9" cy="9" r={r} className="rp-ring__track" />
        <circle cx="9" cy="9" r={r} className="rp-ring__fill" strokeDasharray={`${c * f} ${c}`} transform="rotate(-90 9 9)" />
      </svg>
      <span className="rp-ring__n">{met}/{total}</span>
    </span>
  );
}

/** Item icon; tooltip = name and effect chips (the old purpose line lives here). */
function UnlockIcon({ id }: { id: string }) {
  const item = getItemDef(id);
  if (!item) return null;
  const effects = [...(item.effects ?? []), ...(item.useEffects ?? [])].map(describeEffect);
  return (
    <Tooltip text={[item.name, ...effects].join(" · ")} className="rp-unlock">
      <img src={getItemIconUrl(item)} alt={item.name} />
    </Tooltip>
  );
}

type CardState = "ready" | "progress" | "locked";

function cardState(node: ResearchNodeDef, ev: EvidenceView, cargo: Readonly<Record<string, number>>): CardState {
  const e = evaluateNode(node, ev);
  if (e.met && Object.keys(missingAnalysis(node, cargo)).length === 0) return "ready";
  return e.all.some((s) => s.req.kind === "research" && !s.met) ? "locked" : "progress";
}

function OptionCard({ node, state }: { node: ResearchNodeDef; state: CardState }) {
  const ev = useAtomValue(evidenceViewAtom);
  const cargo = useAtomValue(cargoAtom);
  const unlock = useSetAtom(unlockResearchAtom);
  const [busy, setBusy] = useState(false);
  const e = evaluateNode(node, ev);
  const p = nodeProgress(node, ev, cargo.items);
  // A research prerequisite leads the chips (it is what blocks the card).
  const chips = [...e.all].sort((a, b) => Number(b.req.kind === "research") - Number(a.req.kind === "research"));

  return (
    <div className={`rp-card rp-card--${state}`} data-node={node.id}>
      <div className="rp-card__head">
        <span className="rp-card__name" data-name="">{node.name}</span>
        {state === "ready" ? <span className="rp-card__ready">Ready</span> : <Ring met={p.met} total={p.total} />}
      </div>
      <div className="rp-card__chips">
        {chips.map((s) => <ReqChip key={s.key} req={s.req} met={s.met} />)}
        {e.any.length > 0 && <ReqAnyGroup items={e.any.map((s) => ({ req: s.req, met: s.met }))} met={e.anyMet} />}
      </div>
      <div className="rp-card__foot">
        <AnalysisChips analysis={node.analysis} cargo={cargo.items} />
        <span className="rp-card__unlocks">
          <span className="rp-card__arrow" aria-hidden>→</span>
          {node.unlocks.items.map((id) => <UnlockIcon key={id} id={id} />)}
        </span>
        <button
          className="rp-card__btn"
          disabled={state !== "ready" || busy}
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
          Unlock
        </button>
      </div>
    </div>
  );
}

const STATE_RANK: Record<CardState, number> = { ready: 0, progress: 1, locked: 2 };

function OptionsTab() {
  const ev = useAtomValue(evidenceViewAtom);
  const cargo = useAtomValue(cargoAtom);
  const groups = useMemo(() => BRANCH_ORDER.map((b) => {
    const nodes = RESEARCH_NODES.filter((n) => n.branch === b && !ev.completed.has(n.id)).map((n) => {
      const p = nodeProgress(n, ev, cargo.items);
      return { node: n, state: cardState(n, ev, cargo.items), frac: p.total > 0 ? p.met / p.total : 0 };
    });
    nodes.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.frac - a.frac);
    return { branch: b, nodes };
  }).filter((g) => g.nodes.length > 0), [ev, cargo.items]);
  const unlocked = RESEARCH_NODES.filter((n) => ev.completed.has(n.id));
  // Opening: bring the first Ready card into view (on phones a later branch sits below the fold
  // while the tracker says "Research ready").
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.querySelector(".rp-card--ready")?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <div className="rp-options" ref={rootRef}>
      {groups.map((g) => (
        <section key={g.branch} className={`rp-branch rp-branch--${g.branch}`}>
          <div className="rp-branch__label">{BRANCH_LABELS[g.branch]}</div>
          <div className="rp-branch__cards">
            {g.nodes.map((n) => <OptionCard key={n.node.id} node={n.node} state={n.state} />)}
          </div>
        </section>
      ))}
      {unlocked.length > 0 && (
        <section className="rp-branch rp-done" data-testid="research-unlocked">
          <div className="rp-branch__label">Unlocked</div>
          <div className="rp-done__chips">
            {unlocked.map((n) => (
              <span key={n.id} className="rp-done__chip" data-node={n.id}>
                <Check size={10} strokeWidth={2.5} aria-hidden />
                <span data-name="">{n.name}</span>
                {n.unlocks.items.map((id) => <UnlockIcon key={id} id={id} />)}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function SourceRow({ id }: { id: string }) {
  const d = useAtomValue(discoveriesMirrorAtom);
  const bookmarks = useAtomValue(bookmarksAtom);
  const setDestination = useSetAtom(setDestinationToSourceAtom);
  // B3: without the drive a destination is cleared at once, so the button would do nothing.
  const driveOwned = useAtomValue(transitDriveOwnedAtom);
  const s = d.sources.find((x) => x.id === id);
  const mark = bookmarks.find((b) => b.sourceId === id);
  const [name, setName] = useState(mark?.name ?? "");
  if (!s) return null;
  const parts = Object.entries(s.composition).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const save = (next: string | null) => runOperation({ type: "bookmark.set", opId: newOpId(), sourceId: id, name: next });
  return (
    <div className="rp-source" data-source={id}>
      <span className="rp-source__badge">{sourceClassBadge(s.classId)}</span>
      <span className="rp-source__r">r {Math.round(s.radiusM)} m</span>
      <span className="rp-source__comp">
        {parts.map(([k, n]) => <ResourceIcon key={k} id={k} amount={n} />)}
      </span>
      <span className="rp-source__actions">
        {mark && (
          <input
            className="rp-source__input"
            value={name}
            maxLength={40}
            placeholder="Name"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== mark.name && save(name)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        )}
        <Tooltip text={mark ? "Remove bookmark" : "Bookmark"}>
          <button className={`rp-source__btn${mark ? " rp-source__btn--on" : ""}`} aria-label={mark ? "Unmark" : "Bookmark"} onClick={() => save(mark ? null : "")}>
            {mark ? <BookmarkCheck size={12} aria-hidden /> : <Bookmark size={12} aria-hidden />}
          </button>
        </Tooltip>
        {driveOwned && (
          <Tooltip text="Set destination">
            <button className="rp-source__btn" aria-label="Set destination" onClick={() => {
              if (setDestination(id)) playAudio("click.soft");
            }}>
              <Crosshair size={12} aria-hidden />
            </button>
          </Tooltip>
        )}
      </span>
    </div>
  );
}

function DiscoveriesTab() {
  const d = useAtomValue(discoveriesMirrorAtom);
  // B4: a mined (depleted) rock is gone; its evidence stays in Materials above.
  const sources = useMemo(() => d.sources.filter((s) => !s.depleted).reverse(), [d.sources]);
  const mined = d.sources.length - sources.length;
  return (
    <div className="rp-disc">
      <section className="rp-branch">
        <div className="rp-branch__label">Materials</div>
        <div className="rp-mats">
          {Object.keys(MATERIAL_NAMES).map((m) => {
            const f = d.families[m];
            const how = f ? [f.inspected ? "inspected" : null, f.extracted ? "mined" : null].filter(Boolean).join(" · ") : "not found yet";
            return (
              <Tooltip key={m} text={`${MATERIAL_NAMES[m]} · ${how}`} className={`rp-mat${f ? " rp-mat--found" : ""}`}>
                <ResourceGlyph id={m} />
                <span className="rp-mat__state">
                  {f?.inspected && <ScanLine size={10} strokeWidth={2} aria-label="inspected" />}
                  {f?.extracted && <Pickaxe size={10} strokeWidth={2} aria-label="mined" />}
                </span>
              </Tooltip>
            );
          })}
        </div>
      </section>
      <section className="rp-branch">
        <div className="rp-branch__label">Trials</div>
        <div className="rp-card__chips">
          {TRIALS.map((t) => <ReqChip key={t.id} req={{ kind: "trial", trialId: t.id }} met={!!d.trials[t.id]} />)}
        </div>
      </section>
      <section className="rp-branch">
        <div className="rp-branch__label">Sources {sources.length}{mined > 0 ? ` · mined ${mined}` : ""}</div>
        {sources.length === 0 ? (
          <div className="rp-empty">Inspect rocks with <KeyChip action="inspect" /></div>
        ) : (
          <div className="rp-disc__sources">
            {sources.map((s) => <SourceRow key={s.id} id={s.id} />)}
          </div>
        )}
      </section>
    </div>
  );
}

export default function ResearchPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("options");
  const ev = useAtomValue(evidenceViewAtom);
  const unlocked = RESEARCH_NODES.filter((n) => ev.completed.has(n.id)).length;
  return (
    <Panel
      title="Research"
      tier={2}
      width={760}
      fixedHeight
      onClose={onClose}
      headerRight={
        <>
          <span className="rp-count" data-testid="research-count">{unlocked}/{RESEARCH_NODES.length}</span>
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
        </>
      }
    >
      {tab === "options" ? <OptionsTab /> : <DiscoveriesTab />}
    </Panel>
  );
}
