"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { playAudio } from "@/audio";
import "./Panel.scss";

export type PanelActionVariant = "primary" | "secondary" | "danger" | "subtle";

export type PanelAction = {
  label: string;
  onClick: () => void;
  variant?: PanelActionVariant;
  icon?: ReactNode;
  disabled?: boolean;
  keyHint?: string;
};

export type PanelProps = {
  /** Title in display font. Omit for fully custom headers. */
  title?: string;
  /** Small uppercase label above the title. */
  eyebrow?: string;
  /** Short description under the title. */
  subtitle?: string;
  /** 1 = inspect-tier glass; 2 = deep-tier (default). */
  tier?: 1 | 2;
  /** Custom width. Accepts px number or any CSS value. */
  width?: number | string;
  /** Invoked on backdrop click, Esc, or close button press. */
  onClose: () => void;
  /** Default true. */
  closeOnBackdrop?: boolean;
  /** Default true. */
  closeOnEsc?: boolean;
  /** Right-aligned footer action. */
  primaryAction?: PanelAction;
  /** Left-aligned footer action. */
  secondaryAction?: PanelAction;
  /** Second left-aligned action (shown before secondaryAction). */
  tertiaryAction?: PanelAction;
  /** Extra content in the header, right of the title. */
  headerRight?: ReactNode;
  /** Replaces the default action footer when provided. */
  footerSlot?: ReactNode;
  /** Remove body padding for edge-to-edge content (e.g. research tree). */
  noBodyPadding?: boolean;
  /** Suppress the header entirely. */
  hideHeader?: boolean;
  children: ReactNode;
};

function ActionButton({ action }: { action: PanelAction }) {
  const variant = action.variant ?? "secondary";
  return (
    <button
      type="button"
      className={`panel__action panel__action--${variant}`}
      onClick={() => {
        // Fired from the click itself, never from an effect reacting to state
        // (trap T4): a React render hop can spend the ~20 ms budget in which a
        // sound still reads as instant.
        playAudio(variant === "primary" ? "click.hard" : "click.soft");
        action.onClick();
      }}
      disabled={action.disabled}
    >
      {action.icon && <span className="panel__action-icon">{action.icon}</span>}
      <span className="panel__action-label">{action.label}</span>
      {action.keyHint && <kbd className="panel__action-key">{action.keyHint}</kbd>}
    </button>
  );
}

/**
 * Universal modal / overlay shell. See docs/UI_STYLE_GUIDE.md §7.7.
 *
 * Every menu-space surface (settings, inventory, research, crafting, etc.)
 * uses this component so header/footer treatment, chamfered corners, glass
 * tier, backdrop, and Esc handling stay consistent.
 */
export default function Panel({
  title,
  eyebrow,
  subtitle,
  tier = 2,
  width,
  onClose,
  closeOnBackdrop = true,
  closeOnEsc = true,
  primaryAction,
  secondaryAction,
  tertiaryAction,
  headerRight,
  footerSlot,
  noBodyPadding = false,
  hideHeader = false,
  children,
}: PanelProps) {
  // Panel open/close. Every menu-space surface routes through this component
  // (style guide §7.7), so this one hook covers settings, inventory, research,
  // crafting and loadout.
  //
  // 🔑 CLOSE IS HANDLED IN THE UNMOUNT CLEANUP, NOT IN `onClose`, and that is
  // load-bearing: MEASURED, wiring only the close button, the backdrop and Esc
  // left the common path silent, because `HUD.tsx`'s own hotkey handler closes a
  // panel by setting its own state — `onClose` is never called and the panel
  // simply unmounts. Cleanup is the only place that sees every close path.
  //
  // ⚠ Both guards below exist because React double-invokes effects in dev
  // (mount → cleanup → mount). The open guard is a ref; the close guard is a
  // DURATION test, since StrictMode's synthetic unmount lands within a few ms of
  // mount while a real panel is open for far longer. A bare cleanup would play a
  // close sound immediately on every panel open, in dev only — the kind of bug
  // that gets blamed on the mixer.
  const openedRef = useRef(false);
  useEffect(() => {
    const mountedAt = performance.now();
    if (!openedRef.current) {
      openedRef.current = true;
      playAudio("click.soft");
    }
    return () => {
      if (performance.now() - mountedAt > 250) playAudio("click.soft");
    };
  }, []);

  useEffect(() => {
    if (!closeOnEsc) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [closeOnEsc, onClose]);

  const handleBackdropClick = useCallback(() => {
    // No sound here: the unmount cleanup above already covers every close path,
    // and playing one here too would double up on this one.
    if (closeOnBackdrop) onClose();
  }, [closeOnBackdrop, onClose]);

  const stop = useCallback(
    (e: React.MouseEvent) => e.stopPropagation(),
    []
  );

  const hasFooter =
    footerSlot !== undefined ||
    !!primaryAction ||
    !!secondaryAction ||
    !!tertiaryAction;

  const widthStyle =
    width === undefined
      ? undefined
      : { width: typeof width === "number" ? `${width}px` : width };

  return (
    <div className="panel__backdrop" onClick={handleBackdropClick}>
      <div
        className={`panel panel--tier-${tier}`}
        onClick={stop}
        style={widthStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? "panel-title" : undefined}
      >
        {!hideHeader && (
          <header className="panel__header">
            <div className="panel__header-main">
              {eyebrow && <div className="panel__eyebrow">{eyebrow}</div>}
              {title && (
                <h2 id="panel-title" className="panel__title">
                  {title}
                </h2>
              )}
              {subtitle && <p className="panel__subtitle">{subtitle}</p>}
            </div>
            {headerRight && <div className="panel__header-right">{headerRight}</div>}
            <button
              type="button"
              className="panel__close"
              onClick={onClose}
              aria-label="Close"
            >
              <X size={16} strokeWidth={1.75} aria-hidden />
            </button>
          </header>
        )}

        <div
          className={`panel__body ${noBodyPadding ? "panel__body--flush" : ""}`}
        >
          {children}
        </div>

        {hasFooter && (
          <footer className="panel__footer">
            {footerSlot ? (
              footerSlot
            ) : (
              <>
                <div className="panel__footer-left">
                  {tertiaryAction && <ActionButton action={tertiaryAction} />}
                  {secondaryAction && <ActionButton action={secondaryAction} />}
                </div>
                <div className="panel__footer-right">
                  {primaryAction && <ActionButton action={primaryAction} />}
                </div>
              </>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
