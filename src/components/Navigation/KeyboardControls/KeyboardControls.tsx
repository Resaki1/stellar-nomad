import { movementAtom, settingsAtom } from "@/store/store";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useCallback } from "react";

// Speed change per second while holding accel/decel key
const SPEED_RATE_PER_S = 0.5;

// All keys we care about, mapped to a stable set for O(1) lookup
const STEERING_KEYS = new Set(["w", "a", "s", "d"]);
const ACCEL_KEYS = new Set(["shift", "e"]);
const DECEL_KEYS = new Set(["control", "c"]);

const KeyboardControls = () => {
  const settings = useAtomValue(settingsAtom);
  const setMovement = useSetAtom(movementAtom);

  // Ref that holds a live Set of currently-pressed keys.
  // Using a ref + Set avoids re-renders on every keydown/keyup and
  // lets us handle any number of simultaneous keys correctly.
  const pressedKeys = useRef(new Set<string>());

  // Keep settings in a ref so the event-listener closure never goes stale
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // ── Raw keydown / keyup listeners ─────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Ignore key repeats (browser fires keydown repeatedly while
      // a key is held — the key is already in our set)
      if (e.repeat) return;

      // Ignore if user is typing in an input
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const key = e.key.toLowerCase();
      pressedKeys.current.add(key);

      // Update steering immediately on keydown for responsiveness
      if (STEERING_KEYS.has(key)) {
        const k = pressedKeys.current;
        const yaw = k.has("d") === k.has("a") ? 0 : k.has("d") ? 1 : -1;
        const rawPitch = k.has("w") === k.has("s") ? 0 : k.has("w") ? 1 : -1;
        const pitch = settingsRef.current.invertPitch ? rawPitch : -rawPitch;
        setMovement((prev) => ({ ...prev, yaw, pitch }));
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      pressedKeys.current.delete(key);

      if (STEERING_KEYS.has(key)) {
        const k = pressedKeys.current;
        const yaw = k.has("d") === k.has("a") ? 0 : k.has("d") ? 1 : -1;
        const rawPitch = k.has("w") === k.has("s") ? 0 : k.has("w") ? 1 : -1;
        const pitch = settingsRef.current.invertPitch ? rawPitch : -rawPitch;
        setMovement((prev) => ({ ...prev, yaw, pitch }));
      }
    };

    // Clear all keys when the tab/window loses focus so we don't get
    // stuck keys from alt-tabbing, etc.
    const onBlur = () => {
      pressedKeys.current.clear();
      setMovement((prev) => ({ ...prev, yaw: 0, pitch: 0 }));
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [setMovement]);

  // ── Scroll wheel: immediate speed steps ───────────────────────────
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const step = e.deltaY < 0 ? 0.05 : -0.05;
      setMovement((prev) => ({
        ...prev,
        speed: Math.min(Math.max(prev.speed + step, 0), 1),
      }));
    },
    [setMovement]
  );

  useEffect(() => {
    window.addEventListener("wheel", handleWheel, { passive: true });
    return () => window.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  // ── Continuous speed adjustment via rAF ───────────────────────────
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef(0);

  useEffect(() => {
    let running = true;

    const tick = (time: number) => {
      if (!running) return;
      const dt = lastTimeRef.current ? (time - lastTimeRef.current) / 1000 : 0;
      lastTimeRef.current = time;

      const k = pressedKeys.current;
      const accel = ACCEL_KEYS.values().some((ak) => k.has(ak));
      const decel = DECEL_KEYS.values().some((dk) => k.has(dk));

      if (accel) {
        setMovement((prev) => ({
          ...prev,
          speed: Math.min(prev.speed + SPEED_RATE_PER_S * dt, 1),
        }));
      }
      if (decel) {
        setMovement((prev) => ({
          ...prev,
          speed: Math.max(prev.speed - SPEED_RATE_PER_S * dt, 0),
        }));
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [setMovement]);

  return <></>;
};

export default KeyboardControls;
