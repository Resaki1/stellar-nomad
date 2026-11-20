"use client";

import { useEffect, useRef } from "react";
import { useAtom, useAtomValue, useStore } from "jotai";
import { keybindsAtom, displayKey } from "@/store/keybinds";
import { usedCursorReleaseAtom } from "@/store/mouseSettings";
import { hudHiddenAtom } from "@/store/store";
import { getAppPhase } from "@/components/AppShell/appState";
import { mouseState } from "@/input/mouse";
import { isCursorNeeded, isPointerLocked, onSteeringRelease } from "@/input/pointerLock";
import { flightHud } from "./flightHudBuffer";
import "./FlightHud.scss";

/** Stick ring + marker, aim marker, velocity marker, free-look and click-to-steer hints. Positioned by drawFlightHud. */
export default function FlightHud() {
  const keybinds = useAtomValue(keybindsAtom);
  const [hintRetired, retireHint] = useAtom(usedCursorReleaseAtom);
  const store = useStore();
  const hintRelease = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const stick = useRef<HTMLDivElement>(null);
  const aim = useRef<HTMLDivElement>(null);
  const velocity = useRef<HTMLDivElement>(null);
  const hintFreeLook = useRef<HTMLDivElement>(null);
  const hintLock = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const e = flightHud.els;
    e.ring = ring.current;
    e.stick = stick.current;
    e.aim = aim.current;
    e.velocity = velocity.current;
    e.hintFreeLook = hintFreeLook.current;
    e.hintLock = hintLock.current;
    return () => {
      e.ring = e.stick = e.aim = e.velocity = e.hintFreeLook = e.hintLock = null;
    };
  }, []);

  useEffect(() => {
    const el = hintRelease.current;
    if (hintRetired || !el) return;
    let started = false;
    let visibleMs = 0;
    let lastFrame = 0;
    const eligible = () => isPointerLocked() && !isCursorNeeded() && !mouseState.freeLook &&
      !document.hidden && !store.get(hudHiddenAtom) && getAppPhase() === "playing";
    const start = (e: MouseEvent) => {
      if ((e.movementX || e.movementY) && eligible()) {
        started = true;
        document.removeEventListener("mousemove", start);
      }
    };
    const pause = () => {
      lastFrame = 0;
      el.style.opacity = "0";
    };
    const offRelease = onSteeringRelease(pause);
    document.addEventListener("mousemove", start);
    flightHud.updateCursorHint = () => {
      if (!started) return;
      if (!eligible()) {
        if (lastFrame) pause();
        return;
      }
      const now = performance.now();
      // A stalled renderer or background tab does not count as reading time.
      if (lastFrame) visibleMs += Math.min(now - lastFrame, 100);
      lastFrame = now;
      const opacity = visibleMs < 5000 ? "1" : "0";
      if (el.style.opacity !== opacity) el.style.opacity = opacity;
      if (visibleMs >= 5500) retireHint(true);
    };
    return () => {
      offRelease();
      document.removeEventListener("mousemove", start);
      flightHud.updateCursorHint = null;
    };
  }, [hintRetired, retireHint, store]);

  const freeLookKey = displayKey(keybinds.freeLook[0] ?? "alt");

  return (
    <div className="flight-hud" aria-hidden>
      <div ref={ring} className="flight-hud__marker flight-hud__ring" style={{ opacity: 0 }} />
      <div ref={stick} className="flight-hud__marker flight-hud__stick" style={{ opacity: 0 }} />
      <div ref={aim} className="flight-hud__marker flight-hud__aim" style={{ opacity: 0 }}>
        <span />
      </div>
      <div ref={velocity} className="flight-hud__marker flight-hud__velocity" style={{ opacity: 0 }}>
        <span />
      </div>
      <div ref={hintFreeLook} className="flight-hud__hint" style={{ opacity: 0 }}>
        <span className="flight-hud__hint-key">[{freeLookKey}]</span> free look
      </div>
      <div ref={hintLock} className="flight-hud__hint flight-hud__hint--quiet flight-hud__hint--lock" style={{ opacity: 0 }}>
        click to steer
      </div>
      {!hintRetired && <div ref={hintRelease} className="flight-hud__hint flight-hud__hint--quiet flight-hud__hint--release" style={{ opacity: 0 }}>
        Right-click for cursor
      </div>}
    </div>
  );
}
