"use client";

import { useFrame } from "@react-three/fiber";
import { useStore } from "jotai";
import { tickInteractFocus } from "@/store/interact";

/** Reticle focus on sites, wrecks and placed points (rocks: MiningSystem). Ticks at 20 Hz inside. */
export default function InteractFocus() {
  const store = useStore();
  useFrame((_, dt) => tickInteractFocus(store, Math.min(dt, 0.1)));
  return null;
}
