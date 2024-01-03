"use client";

import React, { useState, useEffect, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Box, Stars } from "@react-three/drei";
import "./page.scss";
import { Euler, Mesh, Quaternion, Vector3 } from "three";
import { Joystick } from "react-joystick-component";
import { IJoystickUpdateEvent } from "react-joystick-component/build/lib/Joystick";

const SpaceShip = ({
  movement,
}: {
  movement: { pitch: number | null; yaw: number | null };
}) => {
  const shipRef = useRef<Mesh>(null!);
  const speed = 10;
  const rotationSpeed = 1;
  const velocity = useRef(new Vector3(0, 0, 0));

  useFrame(({ camera }, delta) => {
    if (shipRef.current) {
      // Update target roll, yaw, and pitch values only when the joystick is being used
      if (movement.yaw || movement.pitch) {
        const pitchAxis = new Vector3(1, 0, 0).applyQuaternion(
          shipRef.current.quaternion
        );
        const rollAxis = new Vector3(0, 0, 1).applyQuaternion(
          shipRef.current.quaternion
        );
        const yawAxis = new Vector3(0, 1, 0).applyQuaternion(
          shipRef.current.quaternion
        );

        const pitchRotation = new Quaternion().setFromAxisAngle(
          pitchAxis,
          movement.pitch ? -movement.pitch * rotationSpeed * delta : 0
        );
        const rollRotation = new Quaternion().setFromAxisAngle(
          rollAxis,
          movement.yaw ? -movement.yaw * rotationSpeed * delta : 0
        );
        const yawRotation = new Quaternion().setFromAxisAngle(
          yawAxis,
          movement.yaw ? -movement.yaw * rotationSpeed * delta : 0
        );

        shipRef.current.quaternion.multiplyQuaternions(
          yawRotation.multiply(pitchRotation).multiply(rollRotation),
          shipRef.current.quaternion
        );
      }

      // Calculate the forward direction
      const direction = new Vector3(0, 0, -1); // This is the forward direction in the spaceship's local space
      direction.applyQuaternion(shipRef.current.quaternion); // Rotate the direction by the spaceship's rotation

      // Set velocity to direction multiplied by speed
      velocity.current = direction.multiplyScalar(speed);

      // Update spaceship position based on velocity and delta time
      shipRef.current.position.add(
        velocity.current.clone().multiplyScalar(delta)
      );

      // Calculate the camera's position
      const offset = new Vector3(0, 2, 10); // Offset relative to the spaceship
      offset.applyQuaternion(shipRef.current.quaternion); // Rotate the offset by the spaceship's rotation
      camera.position.copy(shipRef.current.position).add(offset); // Add the offset to the spaceship's position

      // Set the camera's rotation to match the spaceship's rotation
      camera.quaternion.copy(shipRef.current.quaternion);
    }
  });

  return (
    <Box ref={shipRef} args={[1, 1, 2]}>
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
      <Canvas style={{ background: "black" }} frameloop="always">
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
