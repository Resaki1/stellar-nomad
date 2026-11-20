"use client";

import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { useFullscreenMode } from "@/components/AppShell/FullscreenControl";
import { isTypingTarget } from "@/input/keyboard";
import { keybindsAtom } from "@/store/keybinds";
import { KeyChip } from "./Chips";

import "./PlacementControls.scss";

const RESERVED_KEYS = ["escape", "enter", "tab", " ", "control", "shift", "alt", "meta"];
const backKey = (menuKeys: readonly string[]) => menuKeys.find(key => !RESERVED_KEYS.includes(key));

/** Route placement shortcuts before the same gesture reaches the ship menu or flight controls. */
export function handlePlacementKey(
  e: KeyboardEvent, menuKeys: readonly string[], cancel: () => void, confirm: () => void,
): boolean {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  const key = e.key.toLowerCase();
  const back = key === "escape" || (key === backKey(menuKeys) && !isTypingTarget(e.target));
  if (!back && key !== "enter") return false;
  e.stopImmediatePropagation();
  // Preserve native button activation when navigating the placement card with Tab.
  if (!back && !e.repeat && e.target instanceof Element && e.target.closest("[data-placement-control]")) return true;
  e.preventDefault();
  if (!e.repeat) (back ? cancel : confirm)();
  return true;
}

/** Capture only Escape in fullscreen, only while a placement card owns it. */
export function usePlacementEscapeLock(placing: boolean): void {
  const fullscreen = useFullscreenMode() === "fullscreen";
  useEffect(() => {
    if (!placing || !fullscreen) return;
    const keyboard = (navigator as Navigator & {
      keyboard?: { lock?: (codes: string[]) => Promise<void>; unlock?: () => void };
    }).keyboard;
    if (!keyboard?.lock || !keyboard.unlock) return;
    void keyboard.lock(["Escape"]).catch(() => {
      // Back, right-click and the buttons also work when the browser owns Escape.
    });
    return () => keyboard.unlock?.();
  }, [fullscreen, placing]);
}

export function PlacementCancelKeys() {
  const fullscreen = useFullscreenMode() === "fullscreen";
  const back = backKey(useAtomValue(keybindsAtom).toggleSettings);
  return <span className="placement-keys" aria-hidden="true">
    {back && <span className="placement-keys__back"><KeyChip keyName={back} /></span>}
    {!fullscreen && <span className={back ? "placement-keys__escape-fallback" : undefined}><KeyChip keyName="escape" /></span>}
  </span>;
}

export function PlacementMouseHint() {
  return <div className="placement-mouse-hint">Right-click to cancel</div>;
}
