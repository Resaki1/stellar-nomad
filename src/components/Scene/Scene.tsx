"use client";

import { useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Stats, StatsGl, useDetectGPU } from "@react-three/drei";
import { Joystick } from "react-joystick-component";
import { IJoystickUpdateEvent } from "react-joystick-component/build/lib/Joystick";
import {
  EffectComposer,
  Bloom,
  ToneMapping,
} from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import SpaceShip from "@/components/Spaceship";
import StarsComponent from "../Stars/StarsComponent";
import Star from "../Star/Star";
import "./Scene.scss";
import Planet from "../Planet/Planet";

const Scene = () => {
  const [movement, setMovement] = useState<{
    yaw: number | null;
    pitch: number | null;
  }>({ yaw: 0, pitch: 0 });

  const gpu = useDetectGPU();
  const isSafari = navigator
    ? /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
    : false;

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
      <Canvas
        style={{ background: "black" }}
        frameloop="always"
        shadows
        dpr={[1, 2]}
      >
        {isSafari ? <Stats /> : <StatsGl />}
        {gpu.tier > 1 && (
          <EffectComposer disableNormalPass>
            <Bloom mipmapBlur intensity={0.02} />
            <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
          </EffectComposer>
        )}
        <ambientLight intensity={0.5} />
        <Star />
        <Planet />
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
