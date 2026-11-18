"use client";

import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Lightbulb } from "lucide-react";
import { dismissToastAtom, hoveredToastAtom, pruneToastsAtom, toastsAtom, touchToastAtom, type ToastValue } from "@/store/toast";
import { KeyText, ValueChip } from "../shared/Chips";

import "./NotificationStack.scss";

const PRUNE_MS = 250;

function Value({ v }: { v: ToastValue }) {
  return <ValueChip id={v.id} amount={v.amount} unit={v.unit} signed={!v.unit} />;
}

/** The one column for everything that happened (gains, unlocks, refusals, tips): top-left under cargo. */
export default function NotificationStack() {
  const items = useAtomValue(toastsAtom);
  const prune = useSetAtom(pruneToastsAtom);
  const dismiss = useSetAtom(dismissToastAtom);
  const setHovered = useSetAtom(hoveredToastAtom);
  const touch = useSetAtom(touchToastAtom);
  const any = items.length > 0;
  useEffect(() => {
    if (!any) return;
    const t = window.setInterval(prune, PRUNE_MS);
    return () => window.clearInterval(t);
  }, [any, prune]);

  return (
    <div className="notif-stack" role="status" aria-live="polite">
      {items.map((t) => (
        <div
          key={t.id}
          className={`notif-stack__item notif-stack__item--${t.kind ?? "info"}`}
          data-hint={t.hintId}
          onClick={() => dismiss(t.id)}
          onMouseEnter={() => setHovered(t.id)}
          onMouseLeave={() => {
            setHovered(null);
            touch(t.id);
          }}
        >
          <div className="notif-stack__title">
            {t.kind === "tip" && <Lightbulb size={12} strokeWidth={1.75} aria-hidden className="notif-stack__tip-icon" />}
            <span className="notif-stack__text">{t.kind === "tip" ? <KeyText text={t.message} /> : t.message}</span>
          </div>
          {(t.detail || t.values?.length) && (
            <div className="notif-stack__values">
              {t.values?.map((v) => <Value key={`${v.id}:${v.unit ?? ""}`} v={v} />)}
              {t.detail && <span className="notif-stack__detail">{t.detail}</span>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
