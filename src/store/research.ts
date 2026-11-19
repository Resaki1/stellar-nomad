// ---------------------------------------------------------------------------
// Research and discoveries (M3.3): read-only mirrors of the WORLD's unlocked options and
// findings (the authority is their only writer), the player's bookmarks, and the actions.
// ---------------------------------------------------------------------------
import { atom } from "jotai";
import { getItemDef, getResearchNode } from "@/data/content";
import { getActiveSave, getWorldState } from "@/save/activeSave";
import { defaultDiscoveries } from "@/save/defaults";
import type { DiscoveryState, SourceBookmark } from "@/save/types";
import { describeMissingKeys, unlockedItemIds, type EvidenceView } from "@/sim/research/requirements";
import type { OperationOutcome } from "@/sim/world/commands";
import { describeRejection, newOpId, runOperation } from "@/store/operations";
import { savedAtom } from "@/store/savedAtom";
import { addToastAtom } from "@/store/toast";

/** Read-only mirror of the WORLD's unlocked research options. */
export const sharedResearchMirrorAtom = atom<readonly string[]>([]);

/** Read-only mirror of the WORLD's findings. */
export const discoveriesMirrorAtom = atom<DiscoveryState>(defaultDiscoveries());

export const completedNodeSetAtom = atom((get): ReadonlySet<string> => new Set(get(sharedResearchMirrorAtom)));

export const evidenceViewAtom = atom((get): EvidenceView => ({ discoveries: get(discoveriesMirrorAtom), completed: get(completedNodeSetAtom) }));

/** Starter items plus every unlocked option's blueprints. */
export const unlockedItemIdsAtom = atom((get): Set<string> => unlockedItemIds(get(completedNodeSetAtom)));

/** The local player's bookmarks of world sources. */
export const bookmarksAtom = savedAtom("player", "bookmarks", [] as SourceBookmark[]);

/** Signal: last unlocked option (comms and audio watch it). */
export const lastCompletedResearchIdAtom = atom<string | null>(null);

export function describeUnlockRejection(o: Extract<OperationOutcome, { status: "rejected" }>): string {
  if (o.reason === "evidence") return `Missing evidence: ${describeMissingKeys(o.evidence ?? []).join("; ")}`;
  return describeRejection(o);
}

/** Feedback for the committed unlock. Snapshot hydration and developer overrides stay quiet. */
export const announceResearchAtom = atom(null, (_get, set, id: string) => {
  const node = getResearchNode(id);
  set(lastCompletedResearchIdAtom, id);
  set(addToastAtom, { audio: "silent", kind: "success", message: "Unlocked", detail: node?.name ?? id,
    values: node?.unlocks.items.filter(item => getItemDef(item)).map(item => ({ id: item })) });
});

/** Unlock an option through the authority; feedback comes from the settled outcome only. */
export const unlockResearchAtom = atom(null, (_get, set, payload: { nodeId: string; onSettled?: (o: OperationOutcome) => void }): void => {
  runOperation({ type: "research.unlock", opId: newOpId(), nodeId: payload.nodeId }, (o) => {
    const node = getResearchNode(payload.nodeId);
    if (o.status === "rejected") {
      set(addToastAtom, { audio: "reject", kind: "warn", message: "Cannot unlock", detail: node?.name ?? payload.nodeId });
    }
    payload.onSettled?.(o);
  });
});

/** Record a client-detected trial once (no-op when the world already has it). */
export function recordTrial(trialId: string): void {
  if (!getActiveSave() || getWorldState().discoveries.trials[trialId]) return;
  runOperation({ type: "trial.record", opId: newOpId(), trialId });
}
