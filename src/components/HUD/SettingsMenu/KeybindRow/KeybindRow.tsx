"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  KeybindAction,
  MAX_KEYS_PER_ACTION,
  bindKeyAtom,
  clearKeySlotAtom,
  displayKey,
  keybindsAtom,
} from "@/store/keybinds";

import "./KeybindRow.scss";

interface KeybindRowProps {
  action: KeybindAction;
  label: string;
}

export default function KeybindRow({ action, label }: KeybindRowProps) {
  const keybinds = useAtomValue(keybindsAtom);
  const bindKey = useSetAtom(bindKeyAtom);
  const clearSlot = useSetAtom(clearKeySlotAtom);

  // Which slot index is currently listening for a new key (-1 = none)
  const [listeningSlot, setListeningSlot] = useState(-1);
  const listeningRef = useRef(listeningSlot);
  listeningRef.current = listeningSlot;

  const keys = keybinds[action];

  // Build the visible slots: existing keys + one empty slot if room
  const slots: (string | null)[] = [
    ...keys.slice(0, MAX_KEYS_PER_ACTION),
  ];
  if (slots.length < MAX_KEYS_PER_ACTION) {
    slots.push(null); // empty placeholder slot
  }

  // ── Listen for the next keypress when a slot is active ──────────
  const handleCapture = useCallback(
    (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const slot = listeningRef.current;
      if (slot < 0) return;

      const key = e.key.toLowerCase();

      // Escape cancels rebinding
      if (key === "escape") {
        setListeningSlot(-1);
        return;
      }

      bindKey({ action, slotIndex: slot, key });
      setListeningSlot(-1);
    },
    [action, bindKey]
  );

  useEffect(() => {
    if (listeningSlot < 0) return;
    // Capture phase so we grab the event before anything else
    window.addEventListener("keydown", handleCapture, true);
    return () => window.removeEventListener("keydown", handleCapture, true);
  }, [listeningSlot, handleCapture]);

  // Click outside while listening → cancel
  useEffect(() => {
    if (listeningSlot < 0) return;
    const onClick = () => setListeningSlot(-1);
    // Delay so the click that started listening doesn't also cancel it
    const id = setTimeout(() => {
      window.addEventListener("click", onClick, true);
    }, 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener("click", onClick, true);
    };
  }, [listeningSlot]);

  return (
    <div className="keybind-row">
      <span className="keybind-row__label">{label}</span>
      <div className="keybind-row__keys">
        {slots.map((keyVal, idx) => {
          const isListening = listeningSlot === idx;
          const isEmpty = keyVal === null;

          return (
            <button
              key={idx}
              className={[
                "keybind-row__key",
                isListening && "keybind-row__key--listening",
                isEmpty && !isListening && "keybind-row__key--empty",
              ]
                .filter(Boolean)
                .join(" ")}
              title={
                isListening
                  ? "Press a key… (Esc to cancel)"
                  : isEmpty
                  ? "Click to bind"
                  : "Click to rebind · Right-click to clear"
              }
              onClick={(e) => {
                e.stopPropagation();
                if (isListening) return;
                setListeningSlot(idx);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!isEmpty) {
                  clearSlot({ action, slotIndex: idx });
                }
              }}
            >
              {isListening ? "…" : isEmpty ? "+" : displayKey(keyVal)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
