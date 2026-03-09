"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useMemo } from "react";

import {
  researchAtom,
  assaySamplesAtom,
  activeResearchNodeAtom,
  startResearchAtom,
} from "@/store/research";
import { addToastAtom } from "@/store/toast";
import { RESEARCH_NODES, type ResearchNodeDef } from "@/data/content";

import "./ResearchPanel.scss";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

type NodeState = "completed" | "active" | "available" | "locked";

type TreeNode = {
  def: ResearchNodeDef;
  state: NodeState;
  children: TreeNode[];
};

/**
 * Build a top-down tree from the flat RESEARCH_NODES list.
 * Root nodes have no prerequisites.
 */
function buildTree(
  completed: Set<string>,
  activeId: string | null,
): TreeNode[] {
  // Index: parentId → children that list parentId in prerequisites
  const childrenOf = new Map<string, ResearchNodeDef[]>();
  const roots: ResearchNodeDef[] = [];

  for (const node of RESEARCH_NODES) {
    if (node.prerequisites.length === 0) {
      roots.push(node);
    } else {
      // A node can appear under EACH of its prerequisites
      // But to avoid duplication, we use the FIRST prerequisite as primary parent
      const parent = node.prerequisites[0];
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent)!.push(node);
    }
  }

  function getState(node: ResearchNodeDef): NodeState {
    if (completed.has(node.id)) return "completed";
    if (activeId === node.id) return "active";
    const allPrereqsDone = node.prerequisites.every((p) => completed.has(p));
    return allPrereqsDone ? "available" : "locked";
  }

  function recurse(nodeDef: ResearchNodeDef): TreeNode {
    const children = (childrenOf.get(nodeDef.id) ?? []).map(recurse);
    return { def: nodeDef, state: getState(nodeDef), children };
  }

  return roots.map(recurse);
}

export default function ResearchPanel({ onClose }: { onClose: () => void }) {
  const assaySamples = useAtomValue(assaySamplesAtom);
  const activeResearch = useAtomValue(activeResearchNodeAtom);
  const researchState = useAtomValue(researchAtom);
  const startResearch = useSetAtom(startResearchAtom);
  const addToast = useSetAtom(addToastAtom);

  const completed = useMemo(
    () => new Set(researchState.completedNodes),
    [researchState.completedNodes],
  );

  const tree = useMemo(
    () => buildTree(completed, researchState.activeResearch?.nodeId ?? null),
    [completed, researchState.activeResearch?.nodeId],
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

        {/* Active research progress */}
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

        {/* Research tree */}
        <div className="research-panel__section-title">Research Tree</div>
        <div className="research-panel__tree">
          {tree.length === 0 ? (
            <div className="research-panel__empty">
              Mine asteroids to collect Assay Samples and begin research.
            </div>
          ) : (
            tree.map((node) => (
              <ResearchTreeNode
                key={node.def.id}
                node={node}
                depth={0}
                assaySamples={assaySamples}
                isResearching={!!activeResearch}
                onStart={handleStart}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function ResearchTreeNode({
  node,
  depth,
  assaySamples,
  isResearching,
  onStart,
}: {
  node: TreeNode;
  depth: number;
  assaySamples: number;
  isResearching: boolean;
  onStart: (id: string) => void;
}) {
  const { def, state, children } = node;
  const canAfford = assaySamples >= def.costs.assaySamples;
  const canStart = state === "available" && !isResearching && canAfford;
  // Show children if completed, active, or available
  const showChildren = state !== "locked" || children.some((c) => c.state !== "locked");

  return (
    <div className="research-tree__branch" style={{ paddingLeft: depth > 0 ? 20 : 0 }}>
      {depth > 0 && <div className="research-tree__connector" />}
      <div
        className={`research-tree__node research-tree__node--${state}`}
      >
        <div className="research-tree__node-row">
          <span className="research-tree__node-icon">
            {state === "completed"
              ? "✓"
              : state === "active"
                ? "◉"
                : state === "available"
                  ? "○"
                  : "🔒"}
          </span>
          <div className="research-tree__node-info">
            <div className="research-tree__node-name">{def.name}</div>
            <div className="research-tree__node-desc">{def.desc}</div>
          </div>
          <div className="research-tree__node-meta">
            {state === "available" || state === "locked" ? (
              <>
                <span
                  className={`research-tree__node-cost ${
                    !canAfford && state === "available"
                      ? "research-tree__node-cost--insufficient"
                      : ""
                  }`}
                >
                  🔬 {def.costs.assaySamples}
                </span>
                <span className="research-tree__node-duration">
                  {formatTime(def.durationSeconds)}
                </span>
              </>
            ) : state === "active" ? (
              <span className="research-tree__node-duration">In Progress</span>
            ) : null}
          </div>
          {state === "available" && (
            <button
              className="research-tree__start-btn"
              disabled={!canStart}
              onClick={() => onStart(def.id)}
            >
              {isResearching ? "Busy" : !canAfford ? "Need" : "Start"}
            </button>
          )}
        </div>
      </div>
      {showChildren && children.length > 0 && (
        <div className="research-tree__children">
          {children.map((child) => (
            <ResearchTreeNode
              key={child.def.id}
              node={child}
              depth={depth + 1}
              assaySamples={assaySamples}
              isResearching={isResearching}
              onStart={onStart}
            />
          ))}
        </div>
      )}
    </div>
  );
}
