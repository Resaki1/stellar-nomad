"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useMemo, useState } from "react";

import {
  researchAtom,
  assaySamplesAtom,
  activeResearchNodeAtom,
  startResearchAtom,
} from "@/store/research";
import { addToastAtom } from "@/store/toast";
import {
  RESEARCH_NODES,
  arePrerequisitesMet,
  describeEffect,
  getItemDef,
  TIER_2_NODE_IDS,
  type ResearchNodeDef,
} from "@/data/content";

import "./ResearchPanel.scss";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

type NodeState = "completed" | "active" | "available" | "locked";

/** Branch identity for coloring. */
type Branch = "root" | "a" | "b" | "c" | "milestone";

function getBranch(nodeId: string): Branch {
  if (nodeId.startsWith("a")) return "a";
  if (nodeId.startsWith("b")) return "b";
  if (nodeId.startsWith("c")) return "c";
  if (nodeId.startsWith("m")) return "milestone";
  return "root";
}

// ---------------------------------------------------------------------------
// Layout: fixed positions for the tree graph (column, row)
// Columns: 0=root, 1=tier1, 2=tier2a, 3=tier2b -> merged to capstone at col 3
// Actually using a 5-column layout for the diamond:
//   col 0: root
//   col 1: tier-1
//   col 2: tier-2 (upper/lower per branch)
//   col 3: capstone (tier-3)
// Each branch occupies 2 rows (for upper and lower tier-2 split)
// ---------------------------------------------------------------------------

type LayoutNode = {
  id: string;
  col: number; // 0-3
  row: number; // 0-based
  branch: Branch;
};

const TREE_LAYOUT: LayoutNode[] = [
  // Root
  { id: "r0_microlab_boot", col: 0, row: 3, branch: "root" },

  // Branch A: Survey (rows 0-1)
  { id: "a1_sensor_calibration", col: 1, row: 1, branch: "a" },
  { id: "a2a_active_scanning", col: 2, row: 0, branch: "a" },
  { id: "a2b_spectral_analysis", col: 2, row: 2, branch: "a" },
  { id: "a3_integrated_survey", col: 3, row: 1, branch: "a" },

  // Branch B: Extraction (rows 3-4)
  { id: "b1_laser_optics", col: 1, row: 4, branch: "b" },
  { id: "b2a_beam_optimization", col: 2, row: 3, branch: "b" },
  { id: "b2b_thermal_dynamics", col: 2, row: 5, branch: "b" },
  { id: "b3_pulse_extraction", col: 3, row: 4, branch: "b" },

  // Branch C: Ship Systems (rows 6-7)
  { id: "c1_structural_engineering", col: 1, row: 7, branch: "c" },
  { id: "c2a_hull_reinforcement", col: 2, row: 6, branch: "c" },
  { id: "c2b_propulsion_systems", col: 2, row: 8, branch: "c" },
  { id: "c3_integrated_platform", col: 3, row: 7, branch: "c" },

  // Milestone (bottom)
  { id: "m1_transit_drive", col: 2, row: 10, branch: "milestone" },
];

const NODE_W = 140;
const NODE_H = 44;
const COL_GAP = 40;
const ROW_GAP = 10;

function getNodePos(layout: LayoutNode): { x: number; y: number } {
  return {
    x: layout.col * (NODE_W + COL_GAP),
    y: layout.row * (NODE_H + ROW_GAP),
  };
}

// Edges: prerequisite connections
type Edge = { from: string; to: string };

const TREE_EDGES: Edge[] = [
  // Root → tier-1
  { from: "r0_microlab_boot", to: "a1_sensor_calibration" },
  { from: "r0_microlab_boot", to: "b1_laser_optics" },
  { from: "r0_microlab_boot", to: "c1_structural_engineering" },
  // A branch
  { from: "a1_sensor_calibration", to: "a2a_active_scanning" },
  { from: "a1_sensor_calibration", to: "a2b_spectral_analysis" },
  { from: "a2a_active_scanning", to: "a3_integrated_survey" },
  { from: "a2b_spectral_analysis", to: "a3_integrated_survey" },
  // B branch
  { from: "b1_laser_optics", to: "b2a_beam_optimization" },
  { from: "b1_laser_optics", to: "b2b_thermal_dynamics" },
  { from: "b2a_beam_optimization", to: "b3_pulse_extraction" },
  { from: "b2b_thermal_dynamics", to: "b3_pulse_extraction" },
  // C branch
  { from: "c1_structural_engineering", to: "c2a_hull_reinforcement" },
  { from: "c1_structural_engineering", to: "c2b_propulsion_systems" },
  { from: "c2a_hull_reinforcement", to: "c3_integrated_platform" },
  { from: "c2b_propulsion_systems", to: "c3_integrated_platform" },
];

const layoutMap = new Map<string, LayoutNode>();
for (const ln of TREE_LAYOUT) layoutMap.set(ln.id, ln);

const nodeMap = new Map<string, ResearchNodeDef>();
for (const node of RESEARCH_NODES) nodeMap.set(node.id, node);

// Total canvas size
const CANVAS_W = 4 * (NODE_W + COL_GAP) - COL_GAP;
const CANVAS_H = 11 * (NODE_H + ROW_GAP) - ROW_GAP;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ResearchPanel({ onClose }: { onClose: () => void }) {
  const assaySamples = useAtomValue(assaySamplesAtom);
  const activeResearch = useAtomValue(activeResearchNodeAtom);
  const researchState = useAtomValue(researchAtom);
  const startResearch = useSetAtom(startResearchAtom);
  const addToast = useSetAtom(addToastAtom);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const completed = useMemo(
    () => new Set(researchState.completedNodes),
    [researchState.completedNodes],
  );

  const activeId = researchState.activeResearch?.nodeId ?? null;

  function getState(nodeId: string): NodeState {
    if (completed.has(nodeId)) return "completed";
    if (activeId === nodeId) return "active";
    const def = nodeMap.get(nodeId);
    if (!def) return "locked";
    return arePrerequisitesMet(def, completed) ? "available" : "locked";
  }

  const handleStart = (nodeId: string) => {
    const ok = startResearch(nodeId);
    if (!ok) {
      addToast({ message: "Cannot start research", durationMs: 2000 });
    }
  };

  const selectedDef = selectedNodeId ? nodeMap.get(selectedNodeId) : null;
  const selectedState = selectedNodeId ? getState(selectedNodeId) : null;

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

        {/* Tree + Detail side-by-side */}
        <div className="research-panel__body">
          {/* Tree graph */}
          <div className="research-panel__tree-scroll">
            <div
              className="research-panel__tree-canvas"
              style={{ width: CANVAS_W, height: CANVAS_H }}
            >
              {/* SVG edges */}
              <svg className="research-panel__edges" width={CANVAS_W} height={CANVAS_H}>
                {TREE_EDGES.map(({ from, to }) => {
                  const fromL = layoutMap.get(from);
                  const toL = layoutMap.get(to);
                  if (!fromL || !toL) return null;
                  const fp = getNodePos(fromL);
                  const tp = getNodePos(toL);
                  const x1 = fp.x + NODE_W;
                  const y1 = fp.y + NODE_H / 2;
                  const x2 = tp.x;
                  const y2 = tp.y + NODE_H / 2;
                  const mx = (x1 + x2) / 2;

                  const fromState = getState(from);
                  const toState = getState(to);
                  const bothDone = fromState === "completed" && toState === "completed";
                  const oneAvailable = toState === "available" || toState === "active";

                  const branch = toL.branch;
                  let stroke = "rgba(255,255,255,0.08)";
                  if (bothDone) {
                    stroke = branch === "a" ? "rgba(100,160,255,0.35)"
                      : branch === "b" ? "rgba(255,160,60,0.35)"
                      : branch === "c" ? "rgba(80,200,120,0.35)"
                      : "rgba(255,200,60,0.35)";
                  } else if (oneAvailable) {
                    stroke = "rgba(255,255,255,0.18)";
                  }

                  return (
                    <path
                      key={`${from}-${to}`}
                      d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke={stroke}
                      strokeWidth={bothDone ? 2 : 1}
                    />
                  );
                })}

                {/* Milestone connections: dashed lines from tier-2 nodes */}
                {(() => {
                  const mLayout = layoutMap.get("m1_transit_drive");
                  if (!mLayout) return null;
                  const mPos = getNodePos(mLayout);
                  const completedTier2Count = TIER_2_NODE_IDS.filter((n) => completed.has(n)).length;

                  return TIER_2_NODE_IDS.map((nodeId) => {
                    const nLayout = layoutMap.get(nodeId);
                    if (!nLayout) return null;
                    const nPos = getNodePos(nLayout);
                    const x1 = nPos.x + NODE_W / 2;
                    const y1 = nPos.y + NODE_H;
                    const x2 = mPos.x + NODE_W / 2;
                    const y2 = mPos.y;

                    const isDone = completed.has(nodeId);
                    return (
                      <line
                        key={`m-${nodeId}`}
                        x1={x1} y1={y1} x2={x2} y2={y2}
                        stroke={isDone ? "rgba(255,200,60,0.3)" : "rgba(255,255,255,0.05)"}
                        strokeWidth={1}
                        strokeDasharray={isDone ? "none" : "4 4"}
                      />
                    );
                  });
                })()}
              </svg>

              {/* Nodes */}
              {TREE_LAYOUT.map((layout) => {
                const def = nodeMap.get(layout.id);
                if (!def) return null;
                const pos = getNodePos(layout);
                const state = getState(layout.id);
                const branch = layout.branch;
                const isSelected = selectedNodeId === layout.id;
                const canAfford = assaySamples >= def.costs.assaySamples;

                return (
                  <button
                    key={layout.id}
                    className={`rt-node rt-node--${state} rt-node--${branch} ${isSelected ? "rt-node--selected" : ""}`}
                    style={{
                      left: pos.x,
                      top: pos.y,
                      width: NODE_W,
                      height: NODE_H,
                    }}
                    onClick={() => setSelectedNodeId(layout.id === selectedNodeId ? null : layout.id)}
                  >
                    <span className="rt-node__icon">
                      {state === "completed" ? "✓"
                        : state === "active" ? "◉"
                        : state === "available" ? "○"
                        : "🔒"}
                    </span>
                    <span className="rt-node__name">{def.name}</span>
                    {(state === "available" || state === "locked") && (
                      <span className={`rt-node__cost ${!canAfford && state === "available" ? "rt-node__cost--insufficient" : ""}`}>
                        {def.costs.assaySamples}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Detail panel */}
          {selectedDef && selectedState && (
            <div className={`research-panel__detail rt-detail--${getBranch(selectedDef.id)}`}>
              <div className="rt-detail__name">{selectedDef.name}</div>
              <div className="rt-detail__desc">{selectedDef.desc}</div>

              <div className="rt-detail__meta">
                <span>🔬 {selectedDef.costs.assaySamples} samples</span>
                <span>{formatTime(selectedDef.durationSeconds)}</span>
              </div>

              {/* Research bonus */}
              {selectedDef.researchEffects && selectedDef.researchEffects.length > 0 && (
                <div className="rt-detail__section">
                  <div className="rt-detail__section-label">Research Bonus</div>
                  <div className="rt-detail__bonuses">
                    {selectedDef.researchEffects.map((eff, i) => (
                      <span key={i} className="rt-detail__bonus-tag">{describeEffect(eff)}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Unlocked items */}
              {selectedDef.unlocks.items && selectedDef.unlocks.items.length > 0 && (
                <div className="rt-detail__section">
                  <div className="rt-detail__section-label">Unlocks</div>
                  <div className="rt-detail__items">
                    {selectedDef.unlocks.items.map((itemId) => {
                      const item = getItemDef(itemId);
                      return (
                        <div key={itemId} className="rt-detail__item">
                          <span className="rt-detail__item-name">{item?.name ?? itemId}</span>
                          {item && <span className="rt-detail__item-desc">{item.uiDesc}</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Prerequisites */}
              {selectedDef.prerequisiteRule && (
                <div className="rt-detail__section">
                  <div className="rt-detail__section-label">Requires</div>
                  <div className="rt-detail__prereq">
                    Any {selectedDef.prerequisiteRule.count} tier-2 nodes ({TIER_2_NODE_IDS.filter((n) => completed.has(n)).length}/{selectedDef.prerequisiteRule.count})
                  </div>
                </div>
              )}

              {/* Action */}
              {selectedState === "available" && (
                <button
                  className="rt-detail__start-btn"
                  disabled={!!activeResearch || assaySamples < selectedDef.costs.assaySamples}
                  onClick={() => handleStart(selectedDef.id)}
                >
                  {activeResearch ? "Research in progress" : assaySamples < selectedDef.costs.assaySamples ? "Not enough samples" : "Start Research"}
                </button>
              )}
              {selectedState === "completed" && (
                <div className="rt-detail__completed-badge">Completed</div>
              )}
              {selectedState === "active" && activeResearch && (
                <div className="rt-detail__active-badge">
                  In progress: {formatTime(Math.max(0, activeResearch.node.durationSeconds - activeResearch.elapsedS))} remaining
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
