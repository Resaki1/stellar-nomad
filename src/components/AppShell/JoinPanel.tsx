"use client";

/**
 * Join card (docs/M4_COOP_PLAN.md §4.1): room code → world, host, slots and version at a glance,
 * one Join button. The preview is read-only; nothing connects, stores a credential or takes a
 * slot before Join. Each refusal is one short line with one action, in a fixed-size slot.
 */
import { Check, User, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { unlockAudio } from "@/audio/engine";
import Panel from "@/components/HUD/Shell/Panel";
import { PILOT_NAME_MAX, chosenPilotName, defaultPilotName, setPilotName } from "@/net/pilotName";
import type { RoomInfo } from "@/net/signaling";
import type { SaveMeta } from "@/save/types";

type Refusal = "no_room" | "unreachable" | "full" | "version" | "credential" | "closed";
type Card =
  | { s: "empty" }
  | { s: "checking" }
  | { s: "room"; info: RoomInfo; refusal: Refusal | null }
  | { s: "refused"; refusal: Refusal };

const MESSAGE: Record<Refusal, string> = {
  no_room: "Code expired or unknown",
  unreachable: "Can't reach host",
  full: "Session full",
  version: "Different game version",
  credential: "Not recognised by host",
  closed: "Session closed",
};
type Action = "edit" | "retry" | "reload" | "back";
const ACTION: Record<Refusal, Action> = {
  no_room: "edit",
  unreachable: "retry",
  full: "retry",
  version: "reload",
  credential: "back",
  closed: "retry",
};
const ACTION_LABEL: Record<Action, string> = { edit: "Edit code", retry: "Retry", reload: "Reload", back: "Back" };

const CODE_RE = /^[A-Z0-9]{6}$/;
const normal = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);

function toRefusal(reason: string): Refusal {
  switch (reason) {
    case "no_room":
    case "full":
    case "credential":
    case "closed":
    case "unreachable":
      return reason;
    case "timeout":
      return "unreachable";
    default:
      return "version"; // protocol, content, version
  }
}

export default function JoinPanel({
  initialCode,
  onBack,
  onJoined,
}: {
  initialCode: string;
  onBack: () => void;
  onJoined: (meta: SaveMeta) => void;
}) {
  const [code, setCode] = useState(() => normal(initialCode));
  // The device-wide name (Settings edits the same value); empty plays as the default.
  const [name, setName] = useState(chosenPilotName);
  const [fallback] = useState(defaultPilotName);
  const [card, setCard] = useState<Card>({ s: "empty" });
  const [joining, setJoining] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const joinRef = useRef<HTMLButtonElement>(null);
  const reqId = useRef(0);
  /** Loaded with the first Join: Back / unmount cancels a join that has not booted yet. */
  const ctrl = useRef<typeof import("@/net/guestController") | null>(null);
  /** Back pressed: a Join whose module import is still in flight must not start afterwards. */
  const left = useRef(false);
  useEffect(() => {
    // Reset on (re)mount: StrictMode's dev double-invoke runs this cleanup once before use.
    left.current = false;
    return () => {
      left.current = true;
      ctrl.current?.cancelJoin();
    };
  }, []);
  const back = () => {
    left.current = true;
    ctrl.current?.cancelJoin();
    onBack();
  };

  const check = useCallback(async (c: string) => {
    const id = ++reqId.current;
    if (!CODE_RE.test(c)) return setCard({ s: "empty" });
    setCard({ s: "checking" });
    const { previewRoom } = await import("@/net/guestController");
    const p = await previewRoom(c);
    if (id !== reqId.current) return;
    setCard(p.kind === "ok" ? { s: "room", info: p.info, refusal: p.refusal } : { s: "refused", refusal: p.kind });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void check(code), 200);
    return () => clearTimeout(t);
  }, [code, check]);

  useEffect(() => {
    (initialCode ? null : codeRef.current)?.focus();
  }, [initialCode]);

  // A good preview from an invite link: Enter joins.
  useEffect(() => {
    if (card.s === "room" && !card.refusal) joinRef.current?.focus();
  }, [card]);

  const canJoin = card.s === "room" && !card.refusal && !joining;

  const join = () => {
    if (!canJoin) return;
    unlockAudio();
    setPilotName(name);
    setJoining(true);
    import("@/net/guestController")
      .then((m) => {
        ctrl.current = m;
        if (left.current) throw new m.JoinError("closed");
        return m.joinAndBoot(code);
      })
      .then(onJoined, (e: unknown) => {
        setJoining(false);
        const reason = (e as { reason?: string })?.reason ?? "unreachable";
        setCard({ s: "refused", refusal: toRefusal(reason) });
      });
  };

  const act = (a: Action) => {
    if (a === "edit") {
      codeRef.current?.focus();
      codeRef.current?.select();
    } else if (a === "retry") void check(code);
    else if (a === "reload") window.location.reload();
    else back();
  };

  const refusal = card.s === "refused" ? card.refusal : card.s === "room" ? card.refusal : null;
  const info = card.s === "room" ? card.info : null;
  const versionOk = info ? card.s === "room" && card.refusal !== "version" : null;

  return (
    <Panel
      title="Join"
      tier={2}
      width={440}
      onClose={back}
      footerSlot={
        <>
          <div className="panel__footer-left">
            <button type="button" className="panel__action panel__action--secondary" data-coop-back onClick={back}>
              <span className="panel__action-label">Back</span>
            </button>
          </div>
          <div className="panel__footer-right">
            <button
              ref={joinRef}
              type="submit"
              form="shell-join"
              data-sfx="hard"
              data-coop-join
              className="panel__action panel__action--primary"
              disabled={!canJoin}
            >
              <span className="panel__action-label">{joining ? "Joining…" : "Join"}</span>
            </button>
          </div>
        </>
      }
    >
      <form
        id="shell-join"
        className="shell-form"
        onSubmit={(e) => {
          e.preventDefault();
          join();
        }}
      >
        <input
          ref={codeRef}
          className="shell-input shell-input--mono shell-join__code"
          value={code}
          aria-label="Room code"
          placeholder="CODE"
          data-coop-code
          maxLength={6}
          autoComplete="off"
          spellCheck={false}
          disabled={joining}
          onChange={(e) => setCode(normal(e.target.value))}
        />
        <div className="shell-join" data-coop-card={card.s} aria-live="polite">
          <div className="shell-join__world" data-coop-world>
            {info?.worldName ?? (card.s === "checking" ? "…" : " ")}
          </div>
          <div className="shell-join__meta">
            <span className="shell-join__host" data-coop-host title="Host">
              <User size={14} strokeWidth={1.75} aria-hidden />
              {info?.hostName ?? "–"}
            </span>
            <span
              className="shell-join__slots"
              data-coop-slots={info ? `${info.players}/${info.maxPlayers}` : ""}
              aria-label={info ? `${info.players} of ${info.maxPlayers} pilots` : "pilots"}
            >
              {Array.from({ length: info?.maxPlayers ?? 4 }, (_, i) => (
                <i key={i} className={info && i < info.players ? "on" : ""} />
              ))}
              <span className="shell-num">{info ? `${info.players}/${info.maxPlayers}` : "–/4"}</span>
            </span>
            <span
              className={`shell-join__ver${versionOk === null ? "" : versionOk ? " shell-join__ver--ok" : " shell-join__ver--bad"}`}
              data-coop-version={versionOk === null ? "" : versionOk ? "ok" : "bad"}
            >
              {versionOk === false ? <X size={14} aria-hidden /> : versionOk ? <Check size={14} aria-hidden /> : null}
              version
            </span>
          </div>
          <div className="shell-join__status">
            {refusal && (
              <>
                <span className="shell-join__msg" role="alert" data-coop-refusal={refusal}>
                  {MESSAGE[refusal]}
                </span>
                <button type="button" className="shell-btn" data-coop-action={ACTION[refusal]} onClick={() => act(ACTION[refusal])}>
                  {ACTION_LABEL[ACTION[refusal]]}
                </button>
              </>
            )}
          </div>
        </div>
        <label className="shell-field">
          <span className="shell-field__label">Your name</span>
          <input
            className="shell-input"
            value={name}
            placeholder={fallback}
            maxLength={PILOT_NAME_MAX}
            data-coop-name
            autoComplete="off"
            spellCheck={false}
            disabled={joining}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      </form>
    </Panel>
  );
}
