"use client";

/**
 * Settings → friends: the pilot name (device-wide, optional), open this world to friends (host)
 * or leave; shows the room code and link.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { coopSnapshot, subscribeCoop } from "@/net/coopState";
import { PILOT_NAME_MAX, chosenPilotName, defaultPilotName, setPilotName } from "@/net/pilotName";
import { guestState } from "@/net/guestController";
import { titleUrl } from "@/components/AppShell/appState";

export default function CoopSettings() {
  const c = useSyncExternalStore(subscribeCoop, coopSnapshot, coopSnapshot);
  const [busy, setBusy] = useState(false);
  const [route, setRoute] = useState<string | null>(null);
  useEffect(() => {
    if (c.role !== "guest" || c.status !== "joined") return;
    let active = true;
    const sample = () => {
      void guestState()?.link?.route().then(value => { if (active) setRoute(value); }).catch(() => {});
    };
    sample();
    const timer = setInterval(sample, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [c.role, c.status]);
  const [name, setName] = useState(chosenPilotName);
  const [fallback] = useState(defaultPilotName);
  // Applied on Enter, Escape, leaving the field or the menu closing (a live session relabels
  // us for everyone then). Unmount fires no reliable blur, so the draft is also flushed there.
  const draft = useRef<string | null>(null);
  const commit = () => {
    if (draft.current === null) return;
    setPilotName(draft.current);
    draft.current = null;
    setName(chosenPilotName());
  };
  useEffect(() => {
    const d = draft;
    return () => {
      if (d.current !== null) setPilotName(d.current);
      d.current = null;
    };
  }, []);
  const link = c.code ? `${window.location.origin}/?join=${c.code}` : "";
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };
  return (
    <div className="coop-settings">
      <label className="coop-settings__name-row">
        <span className="coop-settings__label">Your name</span>
        <input
          className="coop-settings__name"
          data-coop-settings-name
          value={name}
          placeholder={fallback}
          maxLength={PILOT_NAME_MAX}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setName(e.target.value);
            draft.current = e.target.value;
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            // Typing is not flying; Escape still closes the menu (and keeps the name).
            if (e.key === "Escape") commit();
            else e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </label>
      {c.role === "solo" && (
        <button
          className="settings-menu__button"
          disabled={busy}
          onClick={() => run(() => import("@/net/hostController").then((m) => m.startHosting()))}
        >
          open to friends
        </button>
      )}
      {c.role === "host" && c.code && (
        <>
          {c.detail === "invites_offline" && <div role="status">Invites offline. Reconnecting…</div>}
          <div className="coop-settings__code" aria-label="room code">{c.code}</div>
          <button className="settings-menu__button settings-menu__button--subtle" disabled={c.detail === "invites_offline"} onClick={() => void navigator.clipboard?.writeText(link)}>
            copy link
          </button>
          <button
            className="settings-menu__button settings-menu__button--subtle"
            disabled={busy}
            onClick={() => run(() => import("@/net/hostController").then((m) => m.stopHosting()))}
          >
            stop hosting
          </button>
        </>
      )}
      {c.role === "guest" && c.status === "joined" && route && <div>{route === "relay" ? "Relay connection" : "Direct connection"}</div>}
      {c.role === "guest" && (
        <button
          className="settings-menu__button settings-menu__button--subtle"
          onClick={() =>
            void import("@/net/guestController").then((m) => {
              m.leaveSession();
              window.location.assign(titleUrl());
            })
          }
        >
          leave
        </button>
      )}
      {c.status === "error" && c.detail && <div className="coop-settings__error">{c.detail}</div>}
    </div>
  );
}
