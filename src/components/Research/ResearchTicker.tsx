// ---------------------------------------------------------------------------
// ResearchTicker — advances the active research timer each frame.
//
// Lives inside the R3F <Canvas> to get useFrame, but renders nothing.
// Does NOT tick while the settings menu (pause overlay) is open.
// ---------------------------------------------------------------------------
"use client";

import { useFrame } from "@react-three/fiber";
import { isSimPaused } from "@/sim/simPause";
import { useStore } from "jotai";
import { useRef } from "react";

import { researchAtom, researchElapsedAtom, lastCompletedResearchIdAtom } from "@/store/research";
import { settingsIsOpenAtom } from "@/store/store";
import { addToastAtom } from "@/store/toast";
import { getResearchNode, getItemDef } from "@/data/content";
import { newOpId, runOperation } from "@/store/operations";

export default function ResearchTicker() {
  const store = useStore();
  const elapsedRef = useRef(0);
  const persistTimerRef = useRef(0);

  useFrame((_, delta) => {
    if (isSimPaused()) return;
    // Don't progress while paused (settings open)
    const paused = store.get(settingsIsOpenAtom);
    if (paused) return;

    const state = store.get(researchAtom);
    if (!state.activeResearch) {
      // Reset volatile elapsed when no active research
      if (elapsedRef.current !== 0) {
        elapsedRef.current = 0;
        store.set(researchElapsedAtom, 0);
      }
      return;
    }

    // Clamp delta to avoid huge jumps after tab-away
    const dt = Math.min(delta, 0.1);

    const node = getResearchNode(state.activeResearch.nodeId);
    if (!node) return;

    // Sync from persisted on first frame
    if (elapsedRef.current === 0 && state.activeResearch.elapsedS > 0) {
      elapsedRef.current = state.activeResearch.elapsedS;
    }

    const newElapsed = elapsedRef.current + dt;
    elapsedRef.current = newElapsed;

    // Update volatile atom for smooth UI
    store.set(researchElapsedAtom, newElapsed);

    if (newElapsed >= node.durationSeconds) {
      elapsedRef.current = 0;
      store.set(researchElapsedAtom, 0);
      runOperation({ type: "research.complete", opId: newOpId(), nodeId: node.id, elapsedS: newElapsed }, (o) => {
        if (o.status !== "accepted" || o.result.type !== "research.complete") return;
        store.set(lastCompletedResearchIdAtom, node.id);
        const unlockedNames = o.result.unlockedItems.map((id) => getItemDef(id)?.name ?? id).join(", ");
        store.set(addToastAtom, {
          audio: "silent",
          message: `Research Complete: ${node.name}`,
          detail: unlockedNames ? `Blueprints unlocked: ${unlockedNames}` : undefined,
          durationMs: 5000,
        });
      });
    } else {
      // Persist periodically (every ~5s) for crash recovery
      persistTimerRef.current += dt;
      if (persistTimerRef.current >= 5) {
        persistTimerRef.current = 0;
        store.set(researchAtom, {
          ...state,
          activeResearch: { ...state.activeResearch, elapsedS: newElapsed },
        });
      }
    }
  });

  return null;
}
