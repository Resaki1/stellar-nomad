"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  getAppPhase,
  getLoadProgress,
  getLoadTimings,
  subscribeApp,
  titleUrl,
  type LoadProgress,
} from "./appState";
import StarBackdrop from "./StarBackdrop";

const FADE_MS = 400;
/** Loader totals grow as requests start; the bar never moves backwards. One overlay per page. */
let shownPct = 0;

type Row = { label: string; state: "done" | "active" | "waiting"; detail: string };

function rows(p: LoadProgress): Row[] {
  const stageIdx = p.stage === "world" ? 0 : p.stage === "assets" ? 1 : 2;
  const st = (i: number): Row["state"] => (i < stageIdx ? "done" : i === stageIdx ? "active" : "waiting");
  const { loaded, total, inFlight } = p.assets;
  const assetDetail =
    stageIdx > 1
      ? `${total} loaded`
      : total > 0 || inFlight > 0
        ? `${loaded} / ${total}${inFlight > 0 ? ` · ${inFlight} streaming` : ""}`
        : "starting renderer";
  const w = p.warmup;
  return [
    { label: "World", state: st(0), detail: stageIdx > 0 ? "save loaded" : "reading save" },
    { label: "Assets", state: st(1), detail: stageIdx < 1 ? "" : assetDetail },
    {
      label: "GPU warm-up",
      state: st(2),
      detail: stageIdx < 2 ? "" : w.compiling ? "compiling pipelines" : `${w.run} / ${w.need} frames under ${w.thresholdMs} ms`,
    },
  ];
}

/** 0..1, filled linearly by stage: world 10 %, assets 70 %, warm-up 20 %. */
function fraction(p: LoadProgress): number {
  if (p.stage === "world") return 0.04;
  if (p.stage === "assets") return 0.1 + 0.7 * (p.assets.total > 0 ? p.assets.loaded / p.assets.total : 0);
  return 0.8 + 0.2 * (p.warmup.need > 0 ? Math.min(1, p.warmup.run / p.warmup.need) : 0);
}

function shownPercent(p: LoadProgress): number {
  shownPct = Math.max(shownPct, Math.round(fraction(p) * 100));
  return shownPct;
}

/** Opaque overlay over the mounting game; fades out when the gate opens. */
export default function LoadingOverlay() {
  const phase = useSyncExternalStore(subscribeApp, getAppPhase, () => "title" as const);
  const progress = useSyncExternalStore(subscribeApp, getLoadProgress, getLoadProgress);
  const [gone, setGone] = useState(false);
  const fading = phase === "playing";

  useEffect(() => {
    if (!fading) return;
    const t = setTimeout(() => setGone(true), FADE_MS);
    return () => clearTimeout(t);
  }, [fading]);

  if (gone || (fading && !getLoadTimings().gated)) return null;
  const pct = shownPercent(progress);

  return (
    <div className={`shell-loading${fading ? " shell-loading--fading" : ""}`} aria-busy={!fading}>
      <StarBackdrop />
      <section className="shell-loading__card" aria-labelledby="shell-loading-title">
        <div className="shell__eyebrow">Loading world</div>
        <h1 id="shell-loading-title" className="shell-loading__title">
          {progress.worldName ?? " "}
        </h1>
        {progress.error ? (
          <div className="shell-loading__error" role="alert">
            <p>{typeof window !== "undefined" && new URLSearchParams(window.location.search).has("join") ? progress.error : `Could not load the save: ${progress.error}`}</p>
            {/* The button that started the load has unmounted; focus must land here. */}
            <button type="button" className="shell-btn" autoFocus onClick={() => window.location.assign(titleUrl())}>
              Back to title
            </button>
          </div>
        ) : (
          <>
            <ol className="shell-loading__stages">
              {rows(progress).map((r) => (
                <li key={r.label} className={`shell-loading__stage shell-loading__stage--${r.state}`}>
                  <span className="shell-loading__mark" aria-hidden />
                  <span className="shell-loading__label">{r.label}</span>
                  <span className="shell-loading__detail">{r.detail}</span>
                </li>
              ))}
            </ol>
            <div
              className="shell-loading__bar"
              role="progressbar"
              aria-label="Loading progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <div className="shell-loading__fill" style={{ width: `${pct}%` }} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
