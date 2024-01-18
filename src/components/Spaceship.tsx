import { logLimit } from "@/helpers/math";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { Quaternion, Vector3, Mesh, MathUtils } from "three";
import { ShipOne } from "./models/ships/ShipOne";
import { Movement } from "./Navigation/Navigation";
import { lerp } from "three/src/math/MathUtils.js";

const quaternion = new Quaternion();
const zeroVector = new Vector3(0, 0, 0);
const xAxis = new Vector3(1, 0, 0);
const yAxis = new Vector3(0, 1, 0);
const direction = new Vector3(0, 0, 1); // This is the forward direction in the spaceship's local space
const offsetValue = new Vector3(0, -4, 10); // Offset relative to the spaceship
const offsetVector = offsetValue.clone();
const rotationQuaternion = new Quaternion();
rotationQuaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);

const SpaceShip = ({ movement }: { movement: Movement }) => {
  const shipRef = useRef<Mesh>(null!);
  const modelRef = useRef<Mesh>(null!);
  const speed = 100;
  const velocity = useRef(zeroVector);

  const shipHandling = 1.5; // Speed of visual roll

  const movementYaw = useRef(0); // Current roll
  const movementPitch = useRef(0); // Current yaw
  const visualRoll = useRef(0); // Current visual roll
  const visualPitch = useRef(0); // Current visual pitch
  const currentSpeed = useRef(0);

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
        visualPitch.current = logLimit(visualPitch.current, Math.PI / 12);

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
        visualPitch.current,
        modelRef.current.rotation.y,
        visualRoll.current
      );

      // Apply yaw and pitch to ship's rotation using quaternions
      quaternion.setFromAxisAngle(yAxis, -movementYaw.current * delta);
      shipRef.current.quaternion.multiply(quaternion);
      quaternion.setFromAxisAngle(xAxis, movementPitch.current * delta);
      shipRef.current.quaternion.multiply(quaternion);

      // Calculate the forward direction
      direction.set(0, 0, 1).applyQuaternion(shipRef.current.quaternion); // Rotate the direction by the spaceship's rotation

      // Smoothly transition currentSpeed towards movement.speed
      currentSpeed.current = lerp(currentSpeed.current, movement.speed, 0.05);
      // Set velocity to direction multiplied by speed
      velocity.current = direction.multiplyScalar(speed * currentSpeed.current);

      // Update spaceship position based on velocity and delta time
      shipRef.current.position.add(
        velocity.current.clone().multiplyScalar(delta)
      );

      // Calculate the camera's position
      offsetVector
        .copy(offsetValue)
        .applyQuaternion(shipRef.current.quaternion); // Rotate the offset by the spaceship's rotation
      camera.position.copy(shipRef.current.position).sub(offsetVector); // Subtract the offset from the spaceship's position

      // Set the camera's rotation to match the spaceship's rotation
      camera.quaternion.copy(shipRef.current.quaternion);

      // Multiply the camera's quaternion by the rotation quaternion
      camera.quaternion.multiply(rotationQuaternion);
    }
  });

  return (
    <mesh ref={shipRef}>
      <mesh ref={modelRef}>
        <ShipOne />
      </mesh>
    </mesh>
  );
};

export default SpaceShip;
