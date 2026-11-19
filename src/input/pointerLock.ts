/**
 * Pointer lock for mouse steering (docs/FLIGHT_MODEL_PLAN.md §2). DOM only: the title bundle imports it.
 * Any registered "cursor needed" reason (menu, panel, death screen) releases the lock and blocks steering.
 */

type LockablePromise = Promise<void> | undefined;
type LockOptions = { unadjustedMovement?: boolean };
type LockableElement = HTMLElement & { requestPointerLock(options?: LockOptions): LockablePromise };

export const pointerLock = {
  /** Last request outcome, for the test harness: "locked", "unadjusted-fallback", or the error name. */
  lastResult: "",
  requests: 0,
  releases: 0,
  /** Whether the last lock used raw (unaccelerated) movement. */
  unadjusted: false,
};

const cursorNeeded = new Set<string>();
const releaseListeners = new Set<() => void>();
let releasing = false;
let releasedByGame = false;
let userUnlockHandler: (() => void) | null = null;

export function isTouchDevice(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
}

export function isPointerLocked(): boolean {
  return typeof document !== "undefined" && !!document.pointerLockElement;
}

export function isCursorNeeded(): boolean {
  return cursorNeeded.size > 0;
}

/** Called whenever steering must recentre (lock released, a cursor-needing UI opened). */
export function onSteeringRelease(fn: () => void): () => void {
  releaseListeners.add(fn);
  return () => releaseListeners.delete(fn);
}

function notifyRelease(): void {
  releaseListeners.forEach((fn) => fn());
}

/** Esc (the browser's own unlock) while nothing needed the cursor: open the pause menu. */
export function setUserUnlockHandler(fn: (() => void) | null): void {
  userUnlockHandler = fn;
}

/** Must run inside a user gesture. Locks `document.body` so it works before the canvas exists. */
export function requestGamePointerLock(): void {
  requestLock(false);
}

function requestLock(closingMenu: boolean): void {
  if (typeof document === "undefined" || isTouchDevice() || isCursorNeeded() || isPointerLocked()) return;
  const el = document.body as LockableElement;
  if (!el.requestPointerLock) return;
  // Without a gesture (autostart) the request only produces a console error.
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  if (!(closingMenu && releasedByGame) && activation && !activation.isActive) {
    pointerLock.lastResult = "no-gesture";
    return;
  }
  pointerLock.requests++;
  const plain = (): void => {
    pointerLock.unadjusted = false;
    const p = el.requestPointerLock();
    if (p) p.then(() => (pointerLock.lastResult = "unadjusted-fallback")).catch((e: unknown) => {
      pointerLock.lastResult = e instanceof Error ? e.name : String(e);
    });
  };
  try {
    pointerLock.unadjusted = true;
    const p = el.requestPointerLock({ unadjustedMovement: true });
    // Older engines return undefined and ignore the options object.
    if (!p) return;
    p.then(() => (pointerLock.lastResult = "locked")).catch((e: unknown) => {
      // NotSupportedError: no raw input on this platform. Anything else (no gesture) would fail again too.
      if (e instanceof Error && e.name === "NotSupportedError") plain();
      else pointerLock.lastResult = e instanceof Error ? e.name : String(e);
    });
  } catch {
    plain();
  }
}

export function releaseGamePointerLock(): void {
  if (!isPointerLocked() || typeof document.exitPointerLock !== "function") return;
  releasing = true;
  pointerLock.releases++;
  document.exitPointerLock();
}

/**
 * Register/unregister a reason the cursor is needed. Turning one on releases the lock and recentres.
 * Clearing the last one recaptures (B12) while the closing click/key's transient activation lasts;
 * after an app-initiated release the browser can also allow recapture without fresh activation.
 */
export function setCursorNeeded(reason: string, on: boolean): void {
  if (on) {
    if (cursorNeeded.has(reason)) return;
    cursorNeeded.add(reason);
    releaseGamePointerLock();
    notifyRelease();
  } else if (cursorNeeded.delete(reason) && cursorNeeded.size === 0) {
    requestLock(true);
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("pointerlockchange", () => {
    // A recapture that resolved after another UI asked for the cursor gives it straight back.
    if (isPointerLocked()) {
      if (isCursorNeeded()) releaseGamePointerLock();
      return;
    }
    const ours = releasing;
    releasedByGame = ours;
    releasing = false;
    notifyRelease();
    // A blur/alt-tab unlock is not a pause request.
    const focused = document.hasFocus() && document.visibilityState === "visible";
    if (!ours && !isCursorNeeded() && focused) userUnlockHandler?.();
  });
}
