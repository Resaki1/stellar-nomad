import { movementAtom, settingsAtom } from "@/store/store";
import { useAtomValue, useSetAtom } from "jotai";
import { Joystick } from "react-joystick-component";
import { IJoystickUpdateEvent } from "react-joystick-component/build/lib/Joystick";
import "./TouchControls.scss";
import { useGesture } from "@use-gesture/react";
import { useRef } from "react";

const TouchControls = () => {
  const settings = useAtomValue(settingsAtom);
  const setMovement = useSetAtom(movementAtom);
  const dragPosition = useRef<number>();

  const pitch = (y: number | null) => {
    if (!y) return null;
    return settings.invertPitch ? y : -1 * y;
  };

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
    <>
      <div className="joystick">
        <Joystick
          size={100}
          baseColor="#111111"
          stickColor="#666666"
          move={handleMove}
          stop={handleStop}
        />
      </div>
      <div className="acceleration" {...bind()}></div>
    </>
  );
};

export default TouchControls;
