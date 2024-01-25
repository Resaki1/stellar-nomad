import React, { Dispatch, SetStateAction, useRef, useState } from "react";
import { useGesture } from "@use-gesture/react";
import { Joystick } from "react-joystick-component";
import { IJoystickUpdateEvent } from "react-joystick-component/build/lib/Joystick";
import "./Navigation.scss";
import { useAtomValue } from "jotai";
import { settingsAtom } from "@/store/store";

export type Movement = {
  yaw: number | null;
  pitch: number | null;
  speed: number;
};

type NavigationProps = {
  setMovement: Dispatch<SetStateAction<Movement>>;
};

const Navigation = ({ setMovement }: NavigationProps) => {
  const settings = useAtomValue(settingsAtom);
  const [acceleration, setAcceleration] = useState(0.5);
  const [showBar, setShowBar] = useState(false);
  const timeoutId = useRef<NodeJS.Timeout | null>(null);

  const handleMove = (event: IJoystickUpdateEvent) => {
    const pitch = () => {
      if (!event.y) return null;
      return settings.invertPitch ? -1 * event.y : event.y;
    };
    // Update the spaceship movement based on joystick input
    setMovement((prevMovement) => ({
      yaw: event.x,
      pitch: pitch(),
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
        if (timeoutId.current) {
          clearTimeout(timeoutId.current);
        }
        setShowBar(true);
        timeoutId.current = setTimeout(() => setShowBar(false), 2000);
        if (y < 0) {
          setMovement((prevMovement) => ({
            ...prevMovement,
            speed: Math.min(
              prevMovement.speed ? prevMovement.speed + 0.025 : 1,
              1
            ),
          }));
          // TODO: replace with state management
          setAcceleration((prevAcceleration) =>
            Math.min(prevAcceleration + 0.025, 1)
          );
        } else {
          setMovement((prevMovement) => ({
            ...prevMovement,
            speed: Math.max(
              prevMovement.speed ? prevMovement.speed - 0.025 : 0,
              0
            ),
          }));
          setAcceleration((prevAcceleration) =>
            Math.max(prevAcceleration - 0.025, 0)
          );
        }
      }
    },
    onScroll: ({ delta: [_, y] }) => {
      console.log(y);
      if (y < 0) {
        setAcceleration((prevAcceleration) =>
          Math.min(prevAcceleration + 0.025, 1)
        );
      } else {
        setAcceleration((prevAcceleration) =>
          Math.max(prevAcceleration - 0.025, 0)
        );
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
              style={{ height: acceleration * 100 + "%" }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default Navigation;
