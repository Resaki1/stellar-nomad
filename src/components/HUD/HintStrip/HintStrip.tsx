"use client";

import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Lightbulb } from "lucide-react";
import { HINT_SHOW_MS, activeHintAtom, nextHintAtom } from "@/store/comms";

import "./HintStrip.scss";

/** One-time hint line: no Continue, fades after a few seconds, click to dismiss early. */
export default function HintStrip() {
  const hint = useAtomValue(activeHintAtom);
  const next = useSetAtom(nextHintAtom);
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(next, HINT_SHOW_MS);
    return () => clearTimeout(t);
  }, [hint, next]);
  if (!hint) return null;
  return (
    <div className="hint-strip" data-hint={hint.id} onClick={next} role="status">
      <Lightbulb size={13} strokeWidth={1.75} aria-hidden className="hint-strip__icon" />
      <span>{hint.text}</span>
    </div>
  );
}
