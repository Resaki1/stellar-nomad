"use client";

/** Settings → friends: open this world to friends (host) or leave; shows the room code and link. */
import { useState, useSyncExternalStore } from "react";
import { coopSnapshot, subscribeCoop } from "@/net/coopState";
import { titleUrl } from "@/components/AppShell/appState";

export default function CoopSettings() {
  const c = useSyncExternalStore(subscribeCoop, coopSnapshot, coopSnapshot);
  const [busy, setBusy] = useState(false);
  const link = c.code ? `${window.location.origin}/?join=${c.code}` : "";
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };
  return (
    <div className="coop-settings">
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
          <div className="coop-settings__code" aria-label="room code">{c.code}</div>
          <button className="settings-menu__button settings-menu__button--subtle" onClick={() => void navigator.clipboard?.writeText(link)}>
            copy link
          </button>
          <button
            className="settings-menu__button settings-menu__button--subtle"
            disabled={busy}
            onClick={() => run(() => import("@/net/hostController").then((m) => m.stopHosting()))}
          >
            close
          </button>
        </>
      )}
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
