// ---------------------------------------------------------------------------
// TimedEffectsTicker — decrements timed consumable effect durations each frame.
//
// Lives inside the R3F <Canvas> to get useFrame, but renders nothing.
// Does NOT tick while the settings menu (pause overlay) is open.
// ---------------------------------------------------------------------------
"use client";

import { useFrame } from "@react-three/fiber";
import { useStore } from "jotai";

import { tickTimedEffectsAtom, activeTimedEffectsAtom } from "@/store/timedEffects";
import { settingsIsOpenAtom } from "@/store/store";

export default function TimedEffectsTicker() {
  const store = useStore();

  useFrame((_, delta) => {
    // Don't tick while paused
    if (store.get(settingsIsOpenAtom)) return;

    // Only tick if there are active effects
    const effects = store.get(activeTimedEffectsAtom);
    if (effects.length === 0) return;

    const dt = Math.min(delta, 0.1);
    store.set(tickTimedEffectsAtom, dt);
  });

  return null;
}
