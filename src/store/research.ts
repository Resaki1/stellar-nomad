// ---------------------------------------------------------------------------
// Research + Assay Samples state
// ---------------------------------------------------------------------------
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
  RESEARCH_NODES,
  getResearchNode,
  type ResearchNodeDef,
} from "@/data/content";

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

export type ResearchState = {
  /** Non-cargo currency earned from mining. */
  assaySamples: number;
  /** IDs of completed research nodes. */
  completedNodes: string[];
  /** Currently active research (only one at a time). */
  activeResearch: { nodeId: string; elapsedS: number } | null;
};

const DEFAULT_RESEARCH: ResearchState = {
  assaySamples: 0,
  completedNodes: [],
  activeResearch: null,
};

export const researchAtom = atomWithStorage<ResearchState>(
  "research-v1",
  DEFAULT_RESEARCH,
);

// ---------------------------------------------------------------------------
// Derived: assay samples count
// ---------------------------------------------------------------------------

export const assaySamplesAtom = atom((get) => get(researchAtom).assaySamples);

// ---------------------------------------------------------------------------
// Derived: set of completed node IDs (for quick lookup)
// ---------------------------------------------------------------------------

export const completedNodeSetAtom = atom((get) => {
  return new Set(get(researchAtom).completedNodes);
});

// ---------------------------------------------------------------------------
// Derived: visible (available) research nodes
//   Visible = all prerequisites completed AND not completed AND not active
// ---------------------------------------------------------------------------

export const visibleNodesAtom = atom((get): ResearchNodeDef[] => {
  const completed = get(completedNodeSetAtom);
  const active = get(researchAtom).activeResearch;

  return RESEARCH_NODES.filter((node) => {
    if (completed.has(node.id)) return false;
    if (active?.nodeId === node.id) return false;
    return node.prerequisites.every((pre) => completed.has(pre));
  });
});

// ---------------------------------------------------------------------------
// Derived: active research node def (convenience)
// ---------------------------------------------------------------------------

export const activeResearchNodeAtom = atom((get) => {
  const state = get(researchAtom);
  if (!state.activeResearch) return null;
  const node = getResearchNode(state.activeResearch.nodeId);
  if (!node) return null;
  return { ...state.activeResearch, node };
});

// ---------------------------------------------------------------------------
// Derived: unlocked item IDs (from completed research)
// ---------------------------------------------------------------------------

export const unlockedItemIdsAtom = atom((get): Set<string> => {
  const completed = get(completedNodeSetAtom);
  const set = new Set<string>();

  for (const node of RESEARCH_NODES) {
    if (!completed.has(node.id)) continue;
    if (node.unlocks.items) {
      for (const itemId of node.unlocks.items) set.add(itemId);
    }
  }

  return set;
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Add assay samples (e.g. from mining). */
export const addAssaySamplesAtom = atom(
  null,
  (get, set, amount: number): void => {
    if (amount <= 0) return;
    const state = get(researchAtom);
    set(researchAtom, {
      ...state,
      assaySamples: state.assaySamples + Math.floor(amount),
    });
  },
);

/** Start a research node. Deducts assay samples immediately. */
export const startResearchAtom = atom(
  null,
  (get, set, nodeId: string): boolean => {
    const state = get(researchAtom);
    if (state.activeResearch) return false; // already researching

    const node = getResearchNode(nodeId);
    if (!node) return false;

    // Check prerequisites
    const completed = new Set(state.completedNodes);
    if (!node.prerequisites.every((p) => completed.has(p))) return false;

    // Check cost
    if (state.assaySamples < node.costs.assaySamples) return false;

    set(researchAtom, {
      ...state,
      assaySamples: state.assaySamples - node.costs.assaySamples,
      activeResearch: { nodeId, elapsedS: 0 },
    });
    return true;
  },
);

/**
 * Advance the active research timer by `deltaS` seconds.
 * Returns the completed node ID if research just finished, else null.
 */
export const tickResearchAtom = atom(
  null,
  (get, set, deltaS: number): string | null => {
    const state = get(researchAtom);
    if (!state.activeResearch || deltaS <= 0) return null;

    const node = getResearchNode(state.activeResearch.nodeId);
    if (!node) return null;

    const newElapsed = state.activeResearch.elapsedS + deltaS;

    if (newElapsed >= node.durationSeconds) {
      // Research complete
      set(researchAtom, {
        ...state,
        completedNodes: [...state.completedNodes, node.id],
        activeResearch: null,
      });
      return node.id;
    }

    set(researchAtom, {
      ...state,
      activeResearch: { ...state.activeResearch, elapsedS: newElapsed },
    });
    return null;
  },
);
