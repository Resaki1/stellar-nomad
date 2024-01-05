"use client";

import { useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Stats, StatsGl } from "@react-three/drei";
import "./Scene.scss";
import { Joystick } from "react-joystick-component";
import { IJoystickUpdateEvent } from "react-joystick-component/build/lib/Joystick";
import SpaceShip from "@/components/Spaceship";
import StarsComponent from "../Stars/StarsComponent";

const Scene = () => {
  const [movement, setMovement] = useState<{
    yaw: number | null;
    pitch: number | null;
  }>({ yaw: 0, pitch: 0 });

  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  const handleMove = (event: IJoystickUpdateEvent) => {
    // Update the spaceship movement based on joystick input
    setMovement({ yaw: event.x, pitch: event.y });
  };

  const handleStop = () => {
    // Reset the spaceship movement when the joystick is released
    setMovement({ yaw: 0, pitch: 0 });
  };

  return (
    <div className="container">
      <Canvas style={{ background: "black" }} frameloop="always">
        {isSafari ? <Stats /> : <StatsGl />}
        <ambientLight intensity={0.5} />
        <directionalLight // Star
          intensity={12}
          position={[0, 0, 500]}
          color="white"
        />
        <SpaceShip movement={movement} />
        <StarsComponent />
      </Canvas>
      <div className="joystick">
        <Joystick
          size={100}
          baseColor="#111111"
          stickColor="#666666"
          move={handleMove}
          stop={handleStop}
          pos={{ x: 0, y: 0 }}
        />
      </div>
    </div>
  );
};

export default Scene;
