"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useMemo } from "react";

import {
  researchAtom,
  assaySamplesAtom,
  visibleNodesAtom,
  activeResearchNodeAtom,
  startResearchAtom,
} from "@/store/research";
import { addToastAtom } from "@/store/toast";
import { RESEARCH_NODES } from "@/data/content";

import "./ResearchPanel.scss";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

export default function ResearchPanel({ onClose }: { onClose: () => void }) {
  const assaySamples = useAtomValue(assaySamplesAtom);
  const visibleNodes = useAtomValue(visibleNodesAtom);
  const activeResearch = useAtomValue(activeResearchNodeAtom);
  const researchState = useAtomValue(researchAtom);
  const startResearch = useSetAtom(startResearchAtom);
  const addToast = useSetAtom(addToastAtom);

  const completedNodes = useMemo(
    () => new Set(researchState.completedNodes),
    [researchState.completedNodes],
  );

  const completedNodeDefs = useMemo(
    () => RESEARCH_NODES.filter((n) => completedNodes.has(n.id)),
    [completedNodes],
  );

  const handleStart = (nodeId: string) => {
    const ok = startResearch(nodeId);
    if (!ok) {
      addToast({ message: "Cannot start research", durationMs: 2000 });
    }
  };

  return (
    <div className="research-panel__backdrop" onClick={onClose}>
      <div className="research-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="research-panel__header">
          <div className="research-panel__title">Research Lab</div>
          <div className="research-panel__samples">
            🔬 {assaySamples} Assay Samples
          </div>
          <button className="research-panel__close" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Active research */}
        {activeResearch && (
          <div className="research-panel__active">
            <div className="research-panel__active-label">Researching</div>
            <div className="research-panel__active-name">
              {activeResearch.node.name}
            </div>
            <div className="research-panel__progress-bar">
              <div
                className="research-panel__progress-fill"
                style={{
                  width: `${Math.min(
                    100,
                    (activeResearch.elapsedS /
                      activeResearch.node.durationSeconds) *
                      100,
                  )}%`,
                }}
              />
            </div>
            <div className="research-panel__active-time">
              {formatTime(
                Math.max(
                  0,
                  activeResearch.node.durationSeconds - activeResearch.elapsedS,
                ),
              )}{" "}
              remaining
            </div>
          </div>
        )}

        {/* Available nodes */}
        <div className="research-panel__section-title">Available Research</div>
        <div className="research-panel__list">
          {visibleNodes.length === 0 && !activeResearch ? (
            <div className="research-panel__empty">
              {completedNodes.size === 0
                ? "Mine asteroids to collect Assay Samples and begin research."
                : "No new research available."}
            </div>
          ) : visibleNodes.length === 0 && activeResearch ? (
            <div className="research-panel__empty">
              Finish current research to unlock next tier.
            </div>
          ) : (
            visibleNodes.map((node) => {
              const canAfford = assaySamples >= node.costs.assaySamples;
              const disabled = !!activeResearch || !canAfford;

              return (
                <div key={node.id} className="research-panel__node">
                  <div className="research-panel__node-header">
                    <span className="research-panel__node-name">
                      {node.name}
                    </span>
                    <span className="research-panel__node-duration">
                      {formatTime(node.durationSeconds)}
                    </span>
                  </div>
                  <div className="research-panel__node-desc">{node.desc}</div>
                  <div className="research-panel__node-footer">
                    <span
                      className={`research-panel__node-cost ${
                        !canAfford ? "research-panel__node-cost--insufficient" : ""
                      }`}
                    >
                      🔬 {node.costs.assaySamples}
                    </span>
                    <button
                      className="research-panel__node-btn"
                      disabled={disabled}
                      onClick={() => handleStart(node.id)}
                    >
                      {activeResearch
                        ? "Busy"
                        : !canAfford
                          ? "Need samples"
                          : "Start"}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Completed research (collapsible) */}
        {completedNodeDefs.length > 0 && (
          <>
            <div className="research-panel__section-title">
              Completed ({completedNodeDefs.length})
            </div>
            <div className="research-panel__completed">
              {completedNodeDefs.map((n) => (
                <div key={n.id} className="research-panel__completed-node">
                  ✓ {n.name}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
