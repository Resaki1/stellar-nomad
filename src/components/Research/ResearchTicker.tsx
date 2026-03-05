// ---------------------------------------------------------------------------
// ResearchTicker — advances the active research timer each frame.
//
// Lives inside the R3F <Canvas> to get useFrame, but renders nothing.
// Does NOT tick while the settings menu (pause overlay) is open.
// ---------------------------------------------------------------------------
"use client";

import { useFrame } from "@react-three/fiber";
import { useStore } from "jotai";
import { useRef, useCallback } from "react";

import { researchAtom, tickResearchAtom } from "@/store/research";
import { settingsIsOpenAtom } from "@/store/store";
import { addToastAtom } from "@/store/toast";
import { getResearchNode, getItemDef } from "@/data/content";

export default function ResearchTicker() {
  const store = useStore();

  useFrame((_, delta) => {
    // Don't progress while paused (settings open)
    const paused = store.get(settingsIsOpenAtom);
    if (paused) return;

    const state = store.get(researchAtom);
    if (!state.activeResearch) return;

    // Clamp delta to avoid huge jumps after tab-away
    const dt = Math.min(delta, 0.1);

    // We call tickResearch imperatively via the store
    const node = getResearchNode(state.activeResearch.nodeId);
    if (!node) return;

    const newElapsed = state.activeResearch.elapsedS + dt;

    if (newElapsed >= node.durationSeconds) {
      // Complete
      store.set(researchAtom, {
        ...state,
        completedNodes: [...state.completedNodes, node.id],
        activeResearch: null,
      });

      // Toast
      const unlockedNames = (node.unlocks.items ?? [])
        .map((id) => {
          const def = getItemDef(id);
          return def?.name ?? id;
        })
        .join(", ");

      store.set(addToastAtom, {
        message: `Research Complete: ${node.name}`,
        detail: unlockedNames ? `Blueprints unlocked: ${unlockedNames}` : undefined,
        durationMs: 5000,
      });
    } else {
      store.set(researchAtom, {
        ...state,
        activeResearch: { ...state.activeResearch, elapsedS: newElapsed },
      });
    }
  });

  return null;
}
