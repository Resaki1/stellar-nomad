"use client";

import { useAtomValue } from "jotai";
import { toastsAtom } from "@/store/toast";

import "./ToastDisplay.scss";

export default function ToastDisplay() {
  const toasts = useAtomValue(toastsAtom);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-display">
      {toasts.map((t) => (
        <div key={t.id} className="toast-display__item">
          <div className="toast-display__message">{t.message}</div>
          {t.detail && (
            <div className="toast-display__detail">{t.detail}</div>
          )}
        </div>
      ))}
    </div>
  );
}
