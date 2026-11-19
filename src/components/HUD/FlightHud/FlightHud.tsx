"use client";

import { useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { keybindsAtom, displayKey } from "@/store/keybinds";
import { usedCursorReleaseAtom } from "@/store/mouseSettings";
import { flightHud } from "./flightHudBuffer";
import "./FlightHud.scss";

/** Stick ring + marker, aim marker, velocity marker, free-look and click-to-steer hints. Positioned by drawFlightHud. */
export default function FlightHud() {
  const keybinds = useAtomValue(keybindsAtom);
  const usedCursorRelease = useAtomValue(usedCursorReleaseAtom);
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
    e.hintRelease = hintRelease.current;
    return () => {
      e.ring = e.stick = e.aim = e.velocity = e.hintFreeLook = e.hintLock = e.hintRelease = null;
    };
  }, [usedCursorRelease]);

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
      <div ref={hintLock} className="flight-hud__hint flight-hud__hint--quiet" style={{ opacity: 0 }}>
        click to steer
      </div>
      {!usedCursorRelease && <div ref={hintRelease} className="flight-hud__hint flight-hud__hint--quiet" style={{ opacity: 0 }}>
        Right-click for cursor
      </div>}
    </div>
  );
}
