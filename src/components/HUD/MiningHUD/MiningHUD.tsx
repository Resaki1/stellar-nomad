"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { isTypingTarget } from "@/input/keyboard";
import { keybindsAtom } from "@/store/keybinds";
import { computedModifiersAtom, getFlag } from "@/store/modules";
import { pulseMiningActiveAtom, togglePulseMiningAtom } from "@/store/mining";
import { KeyChip } from "../shared/Chips";
import "./MiningHUD.scss";

/**
 * Laser mode instrument (dormant: no item grants pulse mining yet, and its key is unbound by
 * default). Target info, inspect and mine live on the Target Card.
 */
export default function MiningHUD() {
  const modifiers = useAtomValue(computedModifiersAtom);
  const unlocked = getFlag(modifiers, "ability.pulseMiningEnabled");
  const active = useAtomValue(pulseMiningActiveAtom);
  const toggle = useSetAtom(togglePulseMiningAtom);
  const keybinds = useAtomValue(keybindsAtom);
  const keybindsRef = useRef(keybinds);
  useEffect(() => {
    keybindsRef.current = keybinds;
  });

  useEffect(() => {
    if (!unlocked) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target)) return;
      if (keybindsRef.current.togglePulseMining.includes(e.key.toLowerCase())) toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [unlocked, toggle]);

  if (!unlocked) return null;
  return (
    <div className="mining-hud">
      <button className={`mining-hud__pulse-toggle ${active ? "mining-hud__pulse-toggle--active" : ""}`} onClick={() => toggle()}>
        <span className="mining-hud__pulse-label">LASER</span>
        <span className="mining-hud__pulse-mode">{active ? "PULSE" : "CONT"}</span>
        <KeyChip action="togglePulseMining" dim />
      </button>
    </div>
  );
}
