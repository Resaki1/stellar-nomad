import { movementAtom, settingsAtom } from "@/store/store";
import { useAtomValue, useSetAtom } from "jotai";
import { useState, useEffect } from "react";
import { useHotkeys } from "react-hotkeys-hook";

type WASD = "w" | "a" | "s" | "d";

const KeyboardControls = () => {
  const settings = useAtomValue(settingsAtom);

  const setPitch = (y: number) => {
    return settings.invertPitch ? y : -1 * y;
  };

  const setMovement = useSetAtom(movementAtom);

  const [keyState, setKeyState] = useState({
    w: false,
    a: false,
    s: false,
    d: false,
    e: false,
    c: false,
  });

  // Update movement based on current keyState
  useEffect(() => {
    const yaw = keyState.d === keyState.a ? 0 : keyState.d ? 1 : -1;
    const pitch = keyState.w === keyState.s ? 0 : keyState.w ? 1 : -1;
    setMovement((prev) => ({ ...prev, yaw, pitch: setPitch(pitch) }));
  }, [keyState, setMovement]);

  // Handlers to update keyState
  const handleKeyDown = (key: WASD) =>
    setKeyState((prev) => ({ ...prev, [key]: true }));
  const handleKeyUp = (key: WASD) =>
    setKeyState((prev) => ({ ...prev, [key]: false }));

  // Hotkeys setup
  useHotkeys("w", () => handleKeyDown("w"), { keydown: true });
  useHotkeys("w", () => handleKeyUp("w"), { keyup: true });
  useHotkeys("a", () => handleKeyDown("a"), { keydown: true });
  useHotkeys("a", () => handleKeyUp("a"), { keyup: true });
  useHotkeys("s", () => handleKeyDown("s"), { keydown: true });
  useHotkeys("s", () => handleKeyUp("s"), { keyup: true });
  useHotkeys("d", () => handleKeyDown("d"), { keydown: true });
  useHotkeys("d", () => handleKeyUp("d"), { keyup: true });

  useHotkeys("e", () => setKeyState((prev) => ({ ...prev, e: true })), {
    keydown: true,
  });
  useHotkeys("e", () => setKeyState((prev) => ({ ...prev, e: false })), {
    keyup: true,
  });
  useHotkeys("c", () => setKeyState((prev) => ({ ...prev, c: true })), {
    keydown: true,
  });
  useHotkeys("c", () => setKeyState((prev) => ({ ...prev, c: false })), {
    keyup: true,
  });

  useEffect(() => {
    const stepSize = 0.1;
    if (keyState.e) {
      setMovement((prev) => ({
        ...prev,
        speed: Math.min(prev.speed + stepSize, 1),
      }));
    }

    if (keyState.c) {
      setMovement((prev) => ({
        ...prev,
        speed: Math.max(prev.speed - stepSize, 0),
      }));
    }
  }, [keyState, setMovement]);

  return <></>;
};

export default KeyboardControls;
