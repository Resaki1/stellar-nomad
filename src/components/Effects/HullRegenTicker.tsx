// ---------------------------------------------------------------------------
// HullRegenTicker — applies passive hull regen each frame when the
// effective ship config provides a positive hullRegenPerSecond.
// ---------------------------------------------------------------------------
"use client";

import { useFrame } from "@react-three/fiber";
import { useStore } from "jotai";
import { useRef } from "react";

import { shipHealthAtom, settingsIsOpenAtom } from "@/store/store";
import { effectiveShipConfigAtom } from "@/store/shipConfig";

export default function HullRegenTicker() {
  const store = useStore();
  const accumRef = useRef(0);

  useFrame((_, delta) => {
    if (store.get(settingsIsOpenAtom)) return;

    const config = store.get(effectiveShipConfigAtom);
    const rate = config.hullRegenPerSecond;
    if (rate <= 0) return;

    const current = store.get(shipHealthAtom);
    if (current <= 0) return; // ship destroyed
    if (current >= config.maxHealth) return; // already full

    const dt = Math.min(delta, 0.1);
    // Accumulate sub-HP increments so fractional rates (e.g. 0.2 HP/s) tick
    // exactly rather than getting lost to rounding each frame.
    accumRef.current += rate * dt;
    if (accumRef.current < 0.01) return;

    const next = Math.min(config.maxHealth, current + accumRef.current);
    accumRef.current = 0;
    if (next !== current) store.set(shipHealthAtom, next);
  });

  return null;
}
