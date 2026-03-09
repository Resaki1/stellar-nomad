"use client";

import { useAtomValue } from "jotai";
import { useRef, useEffect } from "react";

import { pingBracketBuffer } from "@/store/mining";
import { computedModifiersAtom, getFlag } from "@/store/modules";

import "./PingBrackets.scss";

// ---------------------------------------------------------------------------
// Styling constants (easy to tweak)
// ---------------------------------------------------------------------------
const BASE_OPACITY = 0.4;
const PULSE_AMPLITUDE = 0.08; // subtle breathing
const PULSE_PERIOD_S = 2.8; // seconds per breath cycle

export default function PingBrackets() {
  const pingEnabled = getFlag(
    useAtomValue(computedModifiersAtom),
    "scanner.pingHighlightEnabled",
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const enabledRef = useRef(pingEnabled);
  enabledRef.current = pingEnabled;

  // Single rAF loop that reads the mutable buffer directly — no React in the hot path
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const elMap = new Map<number, HTMLElement>();
    // Track elements being faded out so we don't revive them
    const fadingOut = new Set<number>();

    let rafId: number;

    const tick = () => {
      rafId = requestAnimationFrame(tick);

      if (!enabledRef.current) {
        if (el.children.length > 0) {
          el.innerHTML = "";
          elMap.clear();
          fadingOut.clear();
        }
        return;
      }

      const candidates = pingBracketBuffer.candidates;
      const t = performance.now() / 1000;
      const breath =
        BASE_OPACITY + PULSE_AMPLITUDE * Math.sin((t / PULSE_PERIOD_S) * Math.PI * 2);

      // Build set of current IDs
      const currentIds = new Set<number>();
      for (let i = 0; i < candidates.length; i++) currentIds.add(candidates[i].instanceId);

      // Remove stale elements
      elMap.forEach((child, id) => {
        if (!currentIds.has(id) && !fadingOut.has(id)) {
          child.style.opacity = "0";
          fadingOut.add(id);
          setTimeout(() => {
            child.remove();
            elMap.delete(id);
            fadingOut.delete(id);
          }, 200);
        }
      });

      // Update / create brackets
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (fadingOut.has(c.instanceId)) continue;

        let bracket = elMap.get(c.instanceId);
        if (!bracket) {
          bracket = createBracketElement(c.instanceId);
          el.appendChild(bracket);
          elMap.set(c.instanceId, bracket);
          // Fade-in: set opacity on next frame so transition triggers
          const b = bracket;
          requestAnimationFrame(() => {
            b.style.opacity = String(breath);
          });
          continue; // skip positioning this frame to let fade-in start from 0
        }

        bracket.style.left = `${c.sx * 100}%`;
        bracket.style.top = `${c.sy * 100}%`;
        bracket.style.width = `${c.halfSize * 2}px`;
        bracket.style.height = `${c.halfSize * 2}px`;
        bracket.style.opacity = String(breath);
      }
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      el.innerHTML = "";
      elMap.clear();
      fadingOut.clear();
    };
  }, []); // stable — reads enabledRef + buffer directly

  return <div ref={containerRef} className="ping-brackets" />;
}

function createBracketElement(instanceId: number): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "ping-brackets__bracket";
  el.dataset.id = String(instanceId);
  el.style.opacity = "0";

  // 4 corner lines via pseudo-like child divs
  const corners = ["tl", "tr", "bl", "br"] as const;
  for (const corner of corners) {
    const c = document.createElement("div");
    c.className = `ping-brackets__corner ping-brackets__corner--${corner}`;
    el.appendChild(c);
  }

  return el;
}
