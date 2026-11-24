/**
 * Interstellar POI markers — which *stars* get a HUD marker.
 *
 * See [`docs/STAR_RENDERING_PLAN.md`](../../docs/STAR_RENDERING_PLAN.md) §12 (R2b).
 *
 * ── THE SEAM ────────────────────────────────────────────────────────────────
 * Three independent gates, so progression can be layered on later without
 * touching the renderer or the projector:
 *
 *  0. `markerKnowledgeAtom.interstellar` (store/markerKnowledge.ts) — no star or Sun marker
 *     until interstellar travel exists; checked before the gates below.
 *  1. `starMarkersEnabledAtom` — the PLAYER's toggle. Off hides all of them.
 *  2. `revealAllStarMarkersAtom` — a DEV/testing override that bypasses (3).
 *     ⚠ Default **true** today so the R2b work is testable. **Flip this to false
 *     when progression lands** — that single change turns the whole system from
 *     "everything visible" into "only what you have discovered".
 *  3. `revealedStarMarkerIdsAtom` — the discovered set, persisted. `revealStar`
 *     is the one call gameplay needs ("acquire Proxima on instruments").
 *
 * `STAR_MARKER_MAX_LY` keeps the HUD from filling with 166 arrows; it is a
 * presentation cap, not a progression rule.
 */

import { atom } from "jotai";
import { savedAtom } from "@/store/savedAtom";

/**
 * How many of the NEAREST stars get a marker.
 *
 * 🔑 A COUNT, NOT A RADIUS, and the reason is not just clutter. The old rule was
 * `distLy > STAR_MARKER_MAX_LY`, where `distLy` is the catalogue distance **from
 * Sol** — so it became wrong the moment the player left, the same class of defect R7f
 * fixed for the sky. A nearest-N rule has no origin baked into it.
 *
 * It also gives CONSTANT HUD density: a fixed radius holds ~12 stars near Sol and
 * could hold 40 in a dense region or 3 in a sparse one, and it can leave the player
 * with no markers at all. Six is enough to read the local neighbourhood without
 * crowding the frame. See `nearestStarCandidates` for the full argument.
 */
export const STAR_MARKER_NEAREST = 6;

/**
 * Safety cap on marker range, ly — measured from the SHIP, not from Sol.
 *
 * ⚠ Now a guard rather than the rule: it stops an empty direction producing an arrow
 * to something 300 ly away. With 8,848 candidates it essentially never binds.
 */
export const STAR_MARKER_MAX_LY = 30;

/** The player's own toggle. */
export const starMarkersEnabledAtom = atom(true);

/**
 * Testing override: show every star inside `STAR_MARKER_MAX_LY` regardless of
 * discovery. **Set to false when progression lands.**
 */
export const revealAllStarMarkersAtom = atom(true);

/** Discovered star ids (player save). */
export const revealedStarMarkerIdsAtom = savedAtom("player", "starMarkers", []);

/** Gameplay's entry point: "the player has acquired this star". */
export const revealStarMarkerAtom = atom(null, (get, set, id: string) => {
  const ids = get(revealedStarMarkerIdsAtom);
  if (!ids.includes(id)) set(revealedStarMarkerIdsAtom, [...ids, id]);
});

/** For a "new game" flow. */
export const resetStarMarkersAtom = atom(null, (_get, set) => {
  set(revealedStarMarkerIdsAtom, []);
});
