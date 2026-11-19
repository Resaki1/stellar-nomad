"use client";

/** HUD connection pill: room code and pilots while hosting, link state while a guest. Hidden solo. */
import { useEffect, useState, useSyncExternalStore } from "react";
import { coopSnapshot, subscribeCoop } from "@/net/coopState";
import { guestState, JOIN_MESSAGES } from "@/net/guestController";
import { MAX_PLAYERS } from "@/sim/session/protocol";
import "./CoopPill.scss";

export default function CoopPill() {
  const c = useSyncExternalStore(subscribeCoop, coopSnapshot, coopSnapshot);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (c.role !== "guest") return;
    const t = setInterval(() => setWaiting(guestState()?.client.waiting() ?? false), 500);
    return () => clearInterval(t);
  }, [c.role]);
  if (c.role === "solo") return null;
  const down = c.status !== "joined" || waiting;
  let guestLabel = c.code;
  if (c.status === "refused") guestLabel = JOIN_MESSAGES[c.detail as keyof typeof JOIN_MESSAGES] ?? "Session ended";
  else if (guestState()?.client.hostClosing || c.detail === "closed") guestLabel = "Host closed the world";
  else if (waiting) guestLabel = "Waiting for host";
  else if (c.status !== "joined") guestLabel = "Reconnecting";
  return (
    <div className={`coop-pill${down ? " coop-pill--down" : ""}`} data-status={waiting ? "waiting" : c.status}>
      <span className="coop-pill__dot" />
      {c.role === "host" ? (
        <>
          <span className="coop-pill__code">{c.code}</span>
          <span className="coop-pill__n">
            {c.players}/{MAX_PLAYERS}
          </span>
        </>
      ) : (
        <span>{guestLabel}</span>
      )}
    </div>
  );
}
