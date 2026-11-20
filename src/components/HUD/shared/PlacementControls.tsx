"use client";

import { useEffect, useId, useRef } from "react";
import { useAtomValue, useStore } from "jotai";
import { Box, CircleCheck, Crosshair, Fuel, MapPinPlus, Mouse, TriangleAlert } from "lucide-react";
import { getAppPhase } from "@/components/AppShell/appState";
import { useFullscreenMode } from "@/components/AppShell/FullscreenControl";
import { isTypingTarget } from "@/input/keyboard";
import { isCursorNeeded, isTouchDevice } from "@/input/pointerLock";
import { MAX_POINT_NAME } from "@/sim/replication/points";
import { formatDistance } from "@/sim/units";
import { isDeadAtom } from "@/store/death";
import { industryPanelOpenAtom } from "@/store/industryHud";
import { keybindsAtom } from "@/store/keybinds";
import { settingsIsOpenAtom } from "@/store/store";
import { KeyChip } from "./Chips";

import "./PlacementControls.scss";

const RESERVED_KEYS = ["escape", "enter", "tab", " ", "control", "shift", "alt", "meta"];
const backKey = (menuKeys: readonly string[]) => menuKeys.find(key => !RESERVED_KEYS.includes(key));

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

interface PlacementCardProps {
  kind: "point" | "depot";
  distanceKm: number;
  kits: number;
  name: string;
  onNameChange: (name: string) => void;
  ready: boolean;
  blocked?: string | null;
  clearMessage?: string;
  warning?: string;
  refusal?: string | null;
  pending: boolean;
  isActive: () => boolean;
  cancel: () => void;
  confirm: () => void;
}

function PlacementCancelKeys() {
  const fullscreen = useFullscreenMode() === "fullscreen";
  const back = backKey(useAtomValue(keybindsAtom).toggleSettings);
  return <span className="placement-keys" aria-hidden="true">
    {back && <span className="placement-keys__back"><KeyChip keyName={back} /></span>}
    {!fullscreen && <span className={back ? "placement-keys__escape-fallback" : undefined}><KeyChip keyName="escape" /></span>}
  </span>;
}

/** Both kinds share the same naming field, confirmation paths and placement shortcuts. */
export function PlacementCard({
  kind, distanceKm, kits, name, onNameChange, ready, blocked, clearMessage = "Clear to place", warning, refusal,
  pending, isActive, cancel, confirm,
}: PlacementCardProps) {
  const store = useStore();
  const headingId = useId();
  const card = useRef<HTMLElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const depot = kind === "depot";
  const Icon = depot ? Box : MapPinPlus;

  useEffect(() => {
    const active = () => isActive() && !store.get(settingsIsOpenAtom) &&
      !store.get(industryPanelOpenAtom) && !store.get(isDeadAtom);
    const onKeyDown = (e: KeyboardEvent) => {
      if (!active() || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      const typing = isTypingTarget(e.target);
      const back = key === "escape" || (key === backKey(store.get(keybindsAtom).toggleSettings) && !typing);
      if (key === "tab" && !typing && field.current && !field.current.disabled && !card.current?.contains(document.activeElement)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat) field.current.focus();
      } else if (back || key === "enter") {
        e.stopImmediatePropagation();
        // Let the browser activate a focused placement button exactly once.
        if (!back && !e.repeat && e.target instanceof Element && e.target.closest("[data-placement-control]")) return;
        e.preventDefault();
        if (!e.repeat) (back ? cancel : confirm)();
      }
    };

    // Pointer lock retargets mouse events to its lock element (the game locks the body).
    // Require both ends of the gesture to be on the game so overlay clicks stay in the UI.
    const aimingAt = (target: EventTarget | null) => document.pointerLockElement
      ? target === document.pointerLockElement : target instanceof HTMLCanvasElement;
    let pressed = false;
    const onPointerDown = (e: PointerEvent) => {
      pressed = e.button === 0 && e.pointerType === "mouse" && aimingAt(e.target) && active() &&
        getAppPhase() === "playing" && !isCursorNeeded() && !isTouchDevice();
    };
    const onPointerCancel = () => { pressed = false; };
    const onClick = (e: MouseEvent) => {
      const fromGame = pressed && aimingAt(e.target);
      pressed = false;
      if (!fromGame || !active() || isCursorNeeded() || e.button !== 0 || e.detail === 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      confirm();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("click", onClick, true);
    };
  }, [cancel, confirm, isActive, store]);

  const status = pending ? "Waiting for confirmation…" : refusal ?? blocked ?? (ready ? clearMessage : "Checking clearance…");
  const tone = pending ? "checking" : refusal || blocked ? "blocked" : ready ? "ready" : "checking";
  const StatusIcon = tone === "ready" ? CircleCheck : tone === "blocked" ? TriangleAlert : Crosshair;

  return <section ref={card} className="placement-card" aria-labelledby={headingId} data-placement={kind}>
    <header className="placement-card__header">
      <span className="placement-card__icon"><Icon size={19} aria-hidden /></span>
      <div>
        <h3 id={headingId}>{depot ? "Deploy depot" : "Place replication point"}</h3>
        <p>Aim the ship · {formatDistance(distanceKm)} ahead</p>
      </div>
      <span className="placement-card__count">{kits} {kits === 1 ? "kit" : "kits"}</span>
    </header>
    <label className="placement-card__name">
      <span>{depot ? "Depot name" : "Point name"} <span className="placement-card__name-key" aria-hidden="true"><KeyChip keyName="tab" /></span></span>
      <input ref={field} value={name} onChange={e => onNameChange(e.target.value)} onFocus={e => e.currentTarget.select()}
        placeholder="Enter a name" maxLength={MAX_POINT_NAME} spellCheck={false} required disabled={pending} />
    </label>
    <div className="placement-card__feedback">
      <div className={`placement-card__status placement-card__status--${tone}`} role="status"
        data-placement-ready={ready} data-industry-clear={depot ? ready : undefined}>
        <StatusIcon size={15} aria-hidden /> {status}
      </div>
      {warning && !pending && <span className="placement-card__warning"><Fuel size={14} aria-hidden /> {warning}</span>}
    </div>
    <div className="placement-card__actions">
      <button type="button" data-placement-control data-industry-action={depot ? "cancel-placement" : undefined}
        data-point-action={depot ? undefined : "cancel"} onClick={cancel} disabled={pending}>
        Cancel <PlacementCancelKeys />
      </button>
      <button type="button" className="placement-card__primary" data-placement-control data-industry-action={depot ? "place" : undefined}
        data-point-action={depot ? undefined : "place"} onClick={confirm} disabled={pending || !ready || !name.trim()}>
        {depot ? "Deploy" : "Place"} <span aria-hidden="true"><KeyChip keyName="enter" /></span>
      </button>
    </div>
    <p className="placement-mouse-hint"><Mouse size={14} aria-hidden /> Left-click to place · Right-click to cancel</p>
  </section>;
}
