"use client";

import { useCallback, useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { activeCommsMessageAtom, dismissCommsAtom } from "@/store/comms";
import { aiNameAtom } from "@/store/aiName";
import { isShipAISpeaker, signalAudioActionAtom } from "@/store/audioSignals";
import { depotPlacementAtom, industryPanelOpenAtom } from "@/store/industryHud";
import { isDeadAtom } from "@/store/death";
import { settingsIsOpenAtom } from "@/store/store";

import "./CommsOverlay.scss";

/** Replace `{{AI_NAME}}` with the player-chosen AI name. */
function resolveAiName(text: string, name: string | null): string {
  if (!name) return text;
  return text.replaceAll("{{AI_NAME}}", name);
}

/** Hide comms where recovery, settings or Industry owns the controls. Keep the queued message. */
export default function CommsOverlay() {
  const queued = useAtomValue(activeCommsMessageAtom);
  const dead = useAtomValue(isDeadAtom);
  const settingsOpen = useAtomValue(settingsIsOpenAtom);
  const industryOpen = useAtomValue(industryPanelOpenAtom);
  const aimingDepot = useAtomValue(depotPlacementAtom);
  const message = dead || settingsOpen || industryOpen || aimingDepot ? null : queued;
  const dismiss = useSetAtom(dismissCommsAtom);
  const signalAudio = useSetAtom(signalAudioActionAtom);
  const aiName = useAtomValue(aiNameAtom);

  const [pageIndex, setPageIndex] = useState(0);

  // Reset page when a new message arrives
  useEffect(() => {
    setPageIndex(0);
  }, [queued?.messageId]);

  const pages = message?.textContent ?? [];
  // Clamp in case the active message changed but the effect hasn't reset pageIndex yet
  const safePage = Math.min(pageIndex, Math.max(pages.length - 1, 0));
  const isLastPage = safePage >= pages.length - 1;

  const advance = useCallback(() => {
    if (!message) return;
    if (isShipAISpeaker(message.speaker)) {
      signalAudio(isLastPage ? "comms.chirp.dismiss" : "comms.chirp.advance");
    }
    if (isLastPage) {
      dismiss();
    } else {
      setPageIndex((p) => Math.min(p + 1, pages.length - 1));
    }
  }, [message, isLastPage, dismiss, pages.length, signalAudio]);

  // Keyboard: Enter advances / dismisses (Space stays a flight key)
  useEffect(() => {
    if (!message) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "Enter") {
        if (e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        advance();
      }
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [message, advance]);

  if (!message || pages.length === 0) return null;

  const accent = message.accent ?? "comms";

  return (
    <div
      className={`comms-overlay comms-overlay--accent-${accent}`}
      onClick={advance}
      role="button"
      tabIndex={-1}
    >
      <div className="comms-overlay__rule comms-overlay__rule--top" />

      <div className="comms-overlay__body">
        {/* Avatar: desaturated photo with an accent rim light */}
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

        <div className="comms-overlay__content">
          <div className="comms-overlay__header">
            <span className="comms-overlay__speaker">
              {resolveAiName(message.speaker, aiName)}
            </span>
            {pages.length > 1 && (
              <span className="comms-overlay__page">
                {safePage + 1} / {pages.length}
              </span>
            )}
          </div>

          <div className="comms-overlay__text">
            {resolveAiName(pages[safePage], aiName)}
          </div>

          <div className="comms-overlay__hint">
            <span className="comms-overlay__hint-key">[ENTER]</span>
            <span>{isLastPage ? "Dismiss" : "Continue"}</span>
          </div>
        </div>
      </div>

      <div className="comms-overlay__rule comms-overlay__rule--bottom" />
    </div>
  );
}
