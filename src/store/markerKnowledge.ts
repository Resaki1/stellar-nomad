/**
 * Which navigation markers are relevant to this pilot yet (docs/MARKER_SYSTEM_PLAN.md §2.7).
 *
 * Bodies and stars are always DRAWN; a marker appears only once the pilot can sensibly travel
 * there. Everything derives from state that already persists (modules here; sites read the
 * comms registry in `store/sites.ts`), so there is no save field and no migration. Per pilot on
 * purpose: a co-op crewmate without a drive has no use for the Luna marker.
 */
import { atom } from "jotai";
import type { MarkerUnlock } from "@/sim/systemTypes";
import { settingsAtom } from "@/store/store";
import { transitDriveOwnedAtom } from "@/store/transit";

export interface MarkerKnowledge {
  transitDrive: boolean;
  /** No warp drive item exists yet: planets wait for it. */
  warpDrive: boolean;
  /** Stars and the Sun: no interstellar travel yet. */
  interstellar: boolean;
  /** Settings → Dev override: every marker, as before progression gating. */
  revealAll: boolean;
}

export const markerKnowledgeAtom = atom((get): MarkerKnowledge => {
  const revealAll = !!get(settingsAtom).revealAllMarkers;
  return {
    transitDrive: revealAll || get(transitDriveOwnedAtom),
    warpDrive: revealAll,
    interstellar: revealAll,
    revealAll,
  };
});

export function markerUnlocked(unlock: MarkerUnlock | undefined, k: MarkerKnowledge): boolean {
  switch (unlock ?? "always") {
    case "always": return true;
    case "transitDrive": return k.transitDrive;
    case "warpDrive": return k.warpDrive;
    case "interstellar": return k.interstellar;
    case "never": return false;
  }
}
