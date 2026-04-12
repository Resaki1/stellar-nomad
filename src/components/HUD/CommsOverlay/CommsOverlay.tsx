"use client";

import { useCallback, useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { activeCommsMessageAtom, dismissCommsAtom } from "@/store/comms";

import "./CommsOverlay.scss";

export default function CommsOverlay() {
  const message = useAtomValue(activeCommsMessageAtom);
  const dismiss = useSetAtom(dismissCommsAtom);

  const [pageIndex, setPageIndex] = useState(0);

  // Reset page when a new message arrives
  useEffect(() => {
    setPageIndex(0);
  }, [message?.messageId]);

  const pages = message?.textContent ?? [];
  const isLastPage = pageIndex >= pages.length - 1;

  const advance = useCallback(() => {
    if (!message) return;
    if (isLastPage) {
      dismiss();
    } else {
      setPageIndex((p) => p + 1);
    }
  }, [message, isLastPage, dismiss]);

  // Keyboard: Enter to advance / dismiss
  useEffect(() => {
    if (!message) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        advance();
      }
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [message, advance]);

  if (!message || pages.length === 0) return null;

  return (
    <div className="comms-overlay">
      <div className="comms-overlay__panel">
        <div className="comms-overlay__body">
          {/* Avatar */}
          <div className="comms-overlay__avatar">
            {message.avatar ? (
              <img
                className="comms-overlay__avatar-img"
                src={message.avatar}
                alt={message.speaker}
              />
            ) : (
              <span className="comms-overlay__avatar-placeholder">?</span>
            )}
          </div>

          {/* Right column: speaker + text + footer */}
          <div className="comms-overlay__content">
            {/* Speaker */}
            <div className="comms-overlay__speaker">
              {message.speaker}
            </div>

            {/* Message text */}
            <div className="comms-overlay__text">{pages[pageIndex]}</div>

            {/* Footer: pagination + continue */}
            <div className="comms-overlay__footer">
              {pages.length > 1 && (
                <span className="comms-overlay__page-indicator">
                  {pageIndex + 1} / {pages.length}
                </span>
              )}
              <button
                className="comms-overlay__continue"
                onClick={advance}
              >
                {isLastPage ? "Dismiss" : "Continue"}{" "}
                <span className="comms-overlay__key-hint">[Enter]</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
