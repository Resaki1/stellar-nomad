import { useEffect, useRef, useState } from "react";
import { useGesture } from "@use-gesture/react";
import { Joystick } from "react-joystick-component";
import { IJoystickUpdateEvent } from "react-joystick-component/build/lib/Joystick";
import "./Navigation.scss";
import { useAtom, useAtomValue } from "jotai";
import { movementAtom, settingsAtom } from "@/store/store";
import { useHotkeys } from "react-hotkeys-hook";

type WASD = "w" | "a" | "s" | "d";

const Navigation = () => {
  const settings = useAtomValue(settingsAtom);
  const [movement, setMovement] = useAtom(movementAtom);
  const [showBar, setShowBar] = useState(false);
  const timeoutId = useRef<NodeJS.Timeout | null>(null);
  const dragPosition = useRef<number>();

  const pitch = (y: number | null) => {
    if (!y) return null;
    return settings.invertPitch ? y : -1 * y;
  };

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
    setMovement((prev) => ({ ...prev, yaw, pitch }));
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

  const handleMove = (event: IJoystickUpdateEvent) => {
    // Update the spaceship movement based on joystick input
    setMovement((prevMovement) => ({
      yaw: event.x ?? 0,
      pitch: pitch(event.y) ?? 0,
      speed: prevMovement.speed,
    }));
  };

  const handleStop = () => {
    // Reset the spaceship movement when the joystick is released
    setMovement((prevMovement) => ({
      yaw: 0,
      pitch: 0,
      speed: prevMovement.speed,
    }));
  };

  const bind = useGesture({
    onDrag: ({ down, movement: [_, y] }) => {
      if (down) {
        setShowBar(true);
        if (dragPosition.current === undefined) {
          dragPosition.current = y;
        } else {
          const screenHeight = window.innerHeight;
          const delta = (dragPosition.current - y) / screenHeight;
          setMovement((prevMovement) => ({
            ...prevMovement,
            speed: Math.min(Math.max(prevMovement.speed + delta * 2, 0), 1),
          }));
          dragPosition.current = y;
        }
      } else {
        timeoutId.current = setTimeout(() => setShowBar(false), 2000);
        dragPosition.current = undefined;
      }
    },
    onScroll: ({ delta: [_, y] }) => {
      if (y < 0) {
      } else {
      }
    },
  });

  return (
    <div className="navigation">
      <div className="joystick">
        <Joystick
          size={100}
          baseColor="#111111"
          stickColor="#666666"
          move={handleMove}
          stop={handleStop}
        />
      </div>
      <div className="acceleration" {...bind()}>
        <div
          className={`acceleration__indicator ${
            showBar ? "acceleration__indicator--show" : ""
          }`}
        >
          <div className="acceleration__bar-container">
            <div
              className="acceleration__bar"
              style={{ height: movement.speed * 100 + "%" }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default Navigation;
