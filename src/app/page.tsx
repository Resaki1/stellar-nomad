"use client";

import React, { useState, useEffect, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { Box, Stars } from "@react-three/drei";
import "./page.scss";
import { Mesh } from "three";
import { Joystick } from "react-joystick-component";
import { IJoystickUpdateEvent } from "react-joystick-component/build/lib/Joystick";

const SpaceShip = ({
  movement,
}: {
  movement: { pitch: number | null; yaw: number | null };
}) => {
  const shipRef = useRef<Mesh>(null!);

  useEffect(() => {
    if (shipRef.current) {
      // Update spaceship position and rotation based on movement
      // This is a simplified example, you might want to add more complex movement logic
      shipRef.current.rotation.x = movement.pitch ?? 0;
      shipRef.current.rotation.y = movement.yaw ?? 0;
    }
  }, [movement]);

  return (
    <Box ref={shipRef}>
      <meshStandardMaterial color="gray" />
    </Box>
  );
};

const Scene = () => {
  const [movement, setMovement] = useState<{
    yaw: number | null;
    pitch: number | null;
  }>({ yaw: 0, pitch: 0 });

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
      <Canvas style={{ background: "black" }}>
        <ambientLight intensity={0.5} />
        <directionalLight
          intensity={1}
          position={[0, 0, 50]} // Position the light source far away
          color="white" // Color of the star
        />
        <SpaceShip movement={movement} />
        <Stars
          radius={100}
          depth={50}
          count={5000}
          factor={4}
          saturation={0}
          fade
          speed={1}
        />
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
