// ---------------------------------------------------------------------------
// Research + Assay Samples state
// ---------------------------------------------------------------------------
import { atom } from "jotai";
import { savedAtom } from "@/store/savedAtom";
import { defaultResearch } from "@/save/defaults";
import {
  RESEARCH_NODES,
  getResearchNode,
  arePrerequisitesMet,
  type ResearchNodeDef,
} from "@/data/content";
import { unlockedItemIds } from "@/sim/ship/loadout";

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

export type { ResearchState } from "@/save/types";

/** Per-player assay samples and active timer (PR 1). */
export const researchAtom = savedAtom("player", "research", defaultResearch());

/** Read-only mirror of the WORLD's completed research; the authority is its only writer. */
export const sharedResearchMirrorAtom = atom<readonly string[]>([]);

// ---------------------------------------------------------------------------
// Derived: assay samples count
// ---------------------------------------------------------------------------

export const assaySamplesAtom = atom((get) => get(researchAtom).assaySamples);

// ---------------------------------------------------------------------------
// Derived: set of completed node IDs (for quick lookup)
// ---------------------------------------------------------------------------

export const completedNodeSetAtom = atom((get): ReadonlySet<string> => new Set(get(sharedResearchMirrorAtom)));

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
    return arePrerequisitesMet(node, completed);
  });
});

// ---------------------------------------------------------------------------
// Volatile: frame-rate elapsed time for smooth progress bars.
// The ResearchTicker writes here every frame; UI reads this for display.
// The persisted researchAtom is only updated on completion or periodically.
// ---------------------------------------------------------------------------

export const researchElapsedAtom = atom(0);

// ---------------------------------------------------------------------------
// Signal: last completed research node ID
// GameCommsTriggers watches this to fire per-research comms messages.
// ---------------------------------------------------------------------------

export const lastCompletedResearchIdAtom = atom<string | null>(null);

// ---------------------------------------------------------------------------
// Derived: active research node def (convenience)
// Uses volatile elapsed for smooth progress.
// ---------------------------------------------------------------------------

export const activeResearchNodeAtom = atom((get) => {
  const state = get(researchAtom);
  if (!state.activeResearch) return null;
  const node = getResearchNode(state.activeResearch.nodeId);
  if (!node) return null;
  // Prefer volatile elapsed for smooth UI; fallback to persisted
  const elapsed = get(researchElapsedAtom) || state.activeResearch.elapsedS;
  return { ...state.activeResearch, elapsedS: elapsed, node };
});

// ---------------------------------------------------------------------------
// Derived: unlocked item IDs (from completed research)
// ---------------------------------------------------------------------------

export const unlockedItemIdsAtom = atom((get): Set<string> => unlockedItemIds(get(completedNodeSetAtom)));

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
