import { movementAtom, settingsAtom } from "@/store/store";
import { keybindsAtom } from "@/store/keybinds";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useCallback } from "react";

// Speed change per second while holding accel/decel key
const SPEED_RATE_PER_S = 0.5;

const KeyboardControls = () => {
  const settings = useAtomValue(settingsAtom);
  const setMovement = useSetAtom(movementAtom);
  const keybinds = useAtomValue(keybindsAtom);

  // Ref that holds a live Set of currently-pressed keys.
  const pressedKeys = useRef(new Set<string>());

  // Keep settings & keybinds in refs so listener closures never go stale
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const keybindsRef = useRef(keybinds);
  keybindsRef.current = keybinds;

  /** Check if any key bound to the given action is pressed. */
  const isActionPressed = (action: keyof typeof keybinds) => {
    const k = pressedKeys.current;
    return keybindsRef.current[action].some((key) => k.has(key));
  };

  /** Recompute and push yaw/pitch from current pressed keys. */
  const updateSteering = () => {
    const left = isActionPressed("yawLeft");
    const right = isActionPressed("yawRight");
    const up = isActionPressed("pitchUp");
    const down = isActionPressed("pitchDown");

    const yaw = right === left ? 0 : right ? 1 : -1;
    const rawPitch = up === down ? 0 : up ? 1 : -1;
    const pitch = settingsRef.current.invertPitch ? rawPitch : -rawPitch;
    setMovement((prev) => ({ ...prev, yaw, pitch }));
  };

  // Build a Set of all steering keys for fast lookup
  const steeringKeysRef = useRef(new Set<string>());
  useEffect(() => {
    const s = new Set<string>();
    for (const k of keybinds.pitchUp) s.add(k);
    for (const k of keybinds.pitchDown) s.add(k);
    for (const k of keybinds.yawLeft) s.add(k);
    for (const k of keybinds.yawRight) s.add(k);
    steeringKeysRef.current = s;
  }, [keybinds]);

  // ── Raw keydown / keyup listeners ─────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const key = e.key.toLowerCase();
      pressedKeys.current.add(key);

      if (steeringKeysRef.current.has(key)) {
        updateSteering();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      pressedKeys.current.delete(key);

      if (steeringKeysRef.current.has(key)) {
        updateSteering();
      }
    };

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

      const accel = isActionPressed("accelerate");
      const decel = isActionPressed("decelerate");

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
