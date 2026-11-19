// ---------------------------------------------------------------------------
// TimedEffectsTicker — decrements timed consumable effect durations each frame.
//
// Lives inside the R3F <Canvas> to get useFrame, but renders nothing.
// Solo Settings stops the Canvas frame loop. Shared sessions keep ticking.
// ---------------------------------------------------------------------------
"use client";

import { useFrame } from "@react-three/fiber";
import { isSimPaused } from "@/sim/simPause";
import { useStore } from "jotai";

import { tickTimedEffectsAtom, activeTimedEffectsAtom } from "@/store/timedEffects";

export default function TimedEffectsTicker() {
  const store = useStore();

  useFrame((_, delta) => {
    if (isSimPaused()) return;

    // Only tick if there are active effects
    const effects = store.get(activeTimedEffectsAtom);
    if (effects.length === 0) return;

    const dt = Math.min(delta, 0.1);
    store.set(tickTimedEffectsAtom, dt);
  });

  return null;
}
