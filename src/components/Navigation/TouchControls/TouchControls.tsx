import { settingsAtom } from "@/store/store";
import { useAtomValue } from "jotai";
import { Joystick } from "react-joystick-component";
import { IJoystickUpdateEvent } from "react-joystick-component/build/lib/Joystick";
import "./TouchControls.scss";
import { useGesture } from "@use-gesture/react";
import { useEffect, useRef } from "react";
import { nudgeThrottle, playerInput } from "@/input/playerInput";

/** Touch device: joystick = pitch/yaw stick, vertical drag = throttle. Writes playerInput. */
const TouchControls = () => {
  const settings = useAtomValue(settingsAtom);
  const dragPosition = useRef<number>(undefined);

  useEffect(() => {
    playerInput.invertPitch = settings.invertPitch;
  }, [settings.invertPitch]);

  const handleMove = (event: IJoystickUpdateEvent) => {
    playerInput.stickYaw = event.x ?? 0;
    playerInput.stickPitch = event.y ?? 0;
  };

  const handleStop = () => {
    playerInput.stickYaw = 0;
    playerInput.stickPitch = 0;
  };

  const bind = useGesture({
    onDrag: ({ down, movement: [, y] }) => {
      if (!down) {
        dragPosition.current = undefined;
        return;
      }
      if (dragPosition.current !== undefined) {
        nudgeThrottle(((dragPosition.current - y) / window.innerHeight) * 2);
      }
      dragPosition.current = y;
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
