"use client";

import React, { useState, useEffect, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Box, Stars } from "@react-three/drei";
import "./page.scss";
import { Euler, MathUtils, Mesh, Quaternion, Vector3 } from "three";
import { Joystick } from "react-joystick-component";
import { IJoystickUpdateEvent } from "react-joystick-component/build/lib/Joystick";

// Define a logarithmic function
function logLimit(x: number, limit: number) {
  const sign = Math.sign(x);
  x = Math.abs(x);
  if (x > limit) {
    return sign * (Math.log(x - limit + 1) + limit);
  }
  return sign * x;
}

const quaternion = new Quaternion();
const zeroVector = new Vector3(0, 0, 0);
const xAxis = new Vector3(1, 0, 0);
const yAxis = new Vector3(0, 1, 0);
const direction = new Vector3(0, 0, -1); // This is the forward direction in the spaceship's local space
const offsetValue = new Vector3(0, 2, 10); // Offset relative to the spaceship
const offsetVector = new Vector3(0, 2, 10); // Offset relative to the spaceship

const SpaceShip = ({
  movement,
}: {
  movement: { pitch: number | null; yaw: number | null };
}) => {
  const shipRef = useRef<Mesh>(null!);
  const modelRef = useRef<Mesh>(null!);
  const speed = 10;
  const velocity = useRef(zeroVector);

  const shipHandling = 2; // Speed of visual roll

  const movementYaw = useRef(0); // Current roll
  const movementPitch = useRef(0); // Current yaw
  const visualRoll = useRef(0); // Current visual roll
  const visualPitch = useRef(0); // Current visual pitch

  useFrame(({ camera }, delta) => {
    if (shipRef.current && modelRef.current) {
      // Update target roll, yaw, and pitch values only when the joystick is being used
      if (movement.yaw || movement.pitch) {
        // Increase or decrease visual roll and pitch based on joystick input
        visualRoll.current += movement.yaw
          ? movement.yaw * shipHandling * delta
          : 0;
        visualPitch.current += movement.pitch
          ? movement.pitch * shipHandling * delta
          : 0;

        // Clamp visualRoll and visualPitch between -45 and 45 degrees
        visualRoll.current = logLimit(visualRoll.current, Math.PI / 6);
        visualPitch.current = logLimit(visualPitch.current, Math.PI / 6);

        // Increase or decrease yaw and pitch based on joystick input
        movementYaw.current += movement.yaw
          ? movement.yaw * shipHandling * delta
          : 0;
        movementPitch.current += movement.pitch
          ? movement.pitch * shipHandling * delta
          : 0;

        // Clamp movementYaw and movementPitch to a maximum rotation speed
        const maxRotationSpeed = shipHandling / 2; // Set this to your desired maximum rotation speed
        movementYaw.current = MathUtils.clamp(
          movementYaw.current,
          -maxRotationSpeed,
          maxRotationSpeed
        );
        movementPitch.current = MathUtils.clamp(
          movementPitch.current,
          -maxRotationSpeed,
          maxRotationSpeed
        );
      } else {
        // Gradually return visual roll and pitch to 0 when joystick is released
        visualRoll.current = MathUtils.lerp(
          visualRoll.current,
          0,
          shipHandling * delta
        );
        visualPitch.current = MathUtils.lerp(
          visualPitch.current,
          0,
          shipHandling * delta
        );

        // Gradually decrease the speed of yaw and pitch when joystick is released
        movementYaw.current -= movementYaw.current * shipHandling * delta;
        movementPitch.current -= movementPitch.current * shipHandling * delta;
      }

      // Apply visual roll and pitch to Box mesh's rotation
      modelRef.current.rotation.set(
        -visualPitch.current,
        modelRef.current.rotation.y,
        -visualRoll.current
      );

      // Apply yaw and pitch to ship's rotation using quaternions
      quaternion.setFromAxisAngle(yAxis, -movementYaw.current * delta);
      shipRef.current.quaternion.multiply(quaternion);
      quaternion.setFromAxisAngle(xAxis, -movementPitch.current * delta);
      shipRef.current.quaternion.multiply(quaternion);

      // Calculate the forward direction
      direction.set(0, 0, -1).applyQuaternion(shipRef.current.quaternion); // Rotate the direction by the spaceship's rotation

      // Set velocity to direction multiplied by speed
      velocity.current = direction.multiplyScalar(speed);

      // Update spaceship position based on velocity and delta time
      shipRef.current.position.add(
        velocity.current.clone().multiplyScalar(delta)
      );

      // Calculate the camera's position
      offsetVector
        .copy(offsetValue)
        .applyQuaternion(shipRef.current.quaternion); // Rotate the offset by the spaceship's rotation
      camera.position.copy(shipRef.current.position).add(offsetVector); // Add the offset to the spaceship's position

      // Set the camera's rotation to match the spaceship's rotation
      camera.quaternion.copy(shipRef.current.quaternion);
    }
  });

  return (
    <mesh ref={shipRef}>
      <Box ref={modelRef} args={[1, 1, 2]}>
        <meshStandardMaterial color="gray" />
      </Box>
    </mesh>
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
