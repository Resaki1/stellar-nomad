import { FLIGHT_ACTIONS, playerInput, pressFlightAction, releaseHeldActions, nudgeThrottle, type FlightAction } from "./playerInput";

/** Keybind key string for an event. macOS Alt turns letters into symbols (Alt+W = "∑"), so letters come from `code`. */
export function keyFromEvent(e: KeyboardEvent): string {
  if (e.altKey && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  return e.key.toLowerCase();
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export interface KeyboardHooks {
  /** Current bindings: action → keys. */
  bindings(): Readonly<Record<string, readonly string[]>>;
  /** True while gameplay keys must be ignored (settings menu open). */
  blocked(): boolean;
  /** Edge callbacks for every bound action, flight or not. */
  onPress?(action: string): void;
  onRelease?(action: string): void;
}

export interface KeyboardDevice {
  detach(): void;
  /** Drop every held key (blur, settings opened). */
  releaseAll(): void;
}

const WHEEL_STEP = 0.05;
const MODIFIER_CODE = /^(Shift|Control|Alt|Meta)(Left|Right)$/;

function isKeyboardFocusedControl(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName || !el.matches) return false;
  const control = el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button";
  return control && el.matches(":focus-visible");
}

/** Keyboard + wheel → playerInput. Held keys are tracked by `code` so a modifier change cannot strand one. */
export function attachKeyboard(hooks: KeyboardHooks): KeyboardDevice {
  const down = new Map<string, string>();
  const heldActions = new Set<string>();

  const actionsHeld = (): Set<string> => {
    const keys = new Set<string>();
    down.forEach((k) => keys.add(k));
    const held = new Set<string>();
    const b = hooks.bindings();
    for (const action in b) if (b[action].some((k) => keys.has(k))) held.add(action);
    return held;
  };

  const sync = (): void => {
    const now = actionsHeld();
    heldActions.forEach((a) => {
      if (!now.has(a)) hooks.onRelease?.(a);
    });
    now.forEach((a) => {
      if (heldActions.has(a)) return;
      if ((FLIGHT_ACTIONS as readonly string[]).includes(a)) pressFlightAction(a as FlightAction);
      hooks.onPress?.(a);
    });
    heldActions.clear();
    now.forEach((a) => heldActions.add(a));
    for (const a of FLIGHT_ACTIONS) playerInput.held[a] = now.has(a);
  };

  const releaseAll = (): void => {
    down.clear();
    sync();
    releaseHeldActions();
  };

  const isFlightKey = (key: string): boolean => {
    const b = hooks.bindings();
    return FLIGHT_ACTIONS.some((a) => b[a]?.includes(key));
  };

  // macOS drops the keyup of any key released while Cmd is held, so a held W would stick.
  const dropNonModifiers = (): void => {
    let changed = false;
    down.forEach((_, code) => {
      if (!MODIFIER_CODE.test(code)) changed = down.delete(code) || changed;
    });
    if (changed) sync();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isTypingTarget(e.target) || hooks.blocked()) return;
    if (e.metaKey) {
      dropNonModifiers();
      return;
    }
    const key = keyFromEvent(e);
    // A keyboard-focused button keeps Space/Enter; a mouse-focused one must not eat strafe-up.
    if ((key === " " || key === "enter") && isKeyboardFocusedControl(e.target)) return;
    // Space would click a mouse-focused button, Alt would focus the browser menu, arrows scroll.
    if (isFlightKey(key)) e.preventDefault();
    if (e.repeat) return;
    down.set(e.code || key, key);
    sync();
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    const id = e.code || keyFromEvent(e);
    if (e.key === "Meta") dropNonModifiers();
    if (!down.delete(id)) return;
    sync();
  };

  const onWheel = (e: WheelEvent): void => {
    const target = e.target as HTMLElement | null;
    if (isTypingTarget(target) || hooks.blocked()) return;
    // The wheel belongs to a panel's own scroll content while one is open.
    if (target?.closest?.(".panel__backdrop")) return;
    nudgeThrottle(e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP);
  };

  const onVisibility = (): void => {
    if (document.hidden) releaseAll();
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", releaseAll);
  window.addEventListener("wheel", onWheel, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);

  return {
    releaseAll,
    detach() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseAll);
      window.removeEventListener("wheel", onWheel);
      document.removeEventListener("visibilitychange", onVisibility);
      releaseAll();
    },
  };
}
