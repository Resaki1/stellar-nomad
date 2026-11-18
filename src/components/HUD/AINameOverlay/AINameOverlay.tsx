"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { aiNameAtom } from "@/store/aiName";
import { setCursorNeeded } from "@/input/pointerLock";
import { activeCommsMessageAtom, playedMessageIdsAtom } from "@/store/comms";
import { NAMING_AFTER_IDS } from "@/data/commsMessages";

import { playAudio } from "@/audio";
import "./AINameOverlay.scss";

const MAX_NAME_LENGTH = 20;

/**
 * Inline naming panel that appears after the AI greeting message is dismissed.
 * Positioned at the bottom center — same location as the comms overlay —
 * so it feels like a natural continuation of the dialogue.
 */
export default function AINameOverlay() {
  const aiName = useAtomValue(aiNameAtom);
  const setAiName = useSetAtom(aiNameAtom);
  const activeMessage = useAtomValue(activeCommsMessageAtom);
  const playedIds = useAtomValue(playedMessageIdsAtom);

  const isNamed = aiName !== null;
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Only after the opening premise is dismissed (no flash before it is enqueued).
  const greetingPlayed = NAMING_AFTER_IDS.some((id) => playedIds.includes(id));
  const visible = !isNamed && !activeMessage && greetingPlayed;
  useEffect(() => {
    if (visible) inputRef.current?.focus();
  }, [visible]);
  useEffect(() => setCursorNeeded("ai-name", visible), [visible]);

  const confirm = useCallback(() => {
    const trimmed = inputValue.trim();
    if (trimmed.length === 0) {
      playAudio("ui.reject");
      return;
    }
    playAudio("click.hard");
    setAiName(trimmed);
  }, [inputValue, setAiName]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        confirm();
      }
    },
    [confirm],
  );

  // Hide when already named or when a comms message is on screen
  if (!visible) return null;

  return (
    <div className="ai-name-overlay">
      <div className="ai-name-overlay__panel">
        <label className="ai-name-overlay__label" htmlFor="ai-name-input">
          Enter AI Name:
        </label>

        <div className="ai-name-overlay__row">
          <input
            ref={inputRef}
            id="ai-name-input"
            className="ai-name-overlay__input"
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value.slice(0, MAX_NAME_LENGTH))}
            onKeyDown={onKeyDown}
            placeholder="Enter name..."
            maxLength={MAX_NAME_LENGTH}
            autoComplete="off"
            spellCheck={false}
          />

          <button
            className="ai-name-overlay__confirm"
            onClick={confirm}
            disabled={inputValue.trim().length === 0}
          >
            Confirm{" "}
            <span className="ai-name-overlay__key-hint">[Enter]</span>
          </button>
        </div>
      </div>
    </div>
  );
}
