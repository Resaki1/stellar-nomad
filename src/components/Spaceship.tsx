import { logLimit } from "@/helpers/math";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { Quaternion, Vector3, Mesh, MathUtils } from "three";
import { ShipOne } from "./models/ships/ShipOne";
import { lerp } from "three/src/math/MathUtils.js";
import { useAtomValue } from "jotai";
import { movementAtom } from "@/store/store";

const quaternion = new Quaternion();
const zeroVector = new Vector3(0, 0, 0);
const xAxis = new Vector3(1, 0, 0);
const yAxis = new Vector3(0, 1, 0);
const direction = new Vector3(0, 0, 1); // This is the forward direction in the spaceship's local space
const offsetValue = new Vector3(0, -4, 10); // Offset relative to the spaceship
const offsetVector = offsetValue.clone();
const rotationQuaternion = new Quaternion();
rotationQuaternion.setFromAxisAngle(yAxis, Math.PI);

const SpaceShip = () => {
  const movement = useAtomValue(movementAtom);
  const shipRef = useRef<Mesh>(null!);
  const modelRef = useRef<Mesh>(null!);
  const shipSpeed = 100;
  const velocity = useRef(zeroVector);

  const shipHandling = 1.5;
  const maxRotationSpeed = shipHandling / 2;

  const movementYaw = useRef(0); // Current roll
  const movementPitch = useRef(0); // Current yaw
  const visualRoll = useRef(0); // Current visual roll
  const visualPitch = useRef(0); // Current visual pitch
  const currentSpeed = useRef(0);

  useFrame(({ camera }, delta) => {
    if (shipRef.current && modelRef.current) {
      if (movement.yaw) {
        visualRoll.current = logLimit(
          visualRoll.current + movement.yaw * shipHandling * delta,
          Math.PI / 6
        );

        movementYaw.current = MathUtils.clamp(
          movementYaw.current + movement.yaw * shipHandling * delta,
          -maxRotationSpeed,
          maxRotationSpeed
        );
      } else {
        visualRoll.current = MathUtils.lerp(
          visualRoll.current,
          0,
          shipHandling * delta
        );

        movementYaw.current -= movementYaw.current * shipHandling * delta;
      }

      if (movement.pitch) {
        visualPitch.current = logLimit(
          visualPitch.current + movement.pitch * shipHandling * delta,
          Math.PI / 6
        );

        movementPitch.current = MathUtils.clamp(
          movementPitch.current + movement.pitch * shipHandling * delta,
          -maxRotationSpeed,
          maxRotationSpeed
        );
      } else {
        visualPitch.current = MathUtils.lerp(
          visualPitch.current,
          0,
          shipHandling * delta
        );

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
      currentSpeed.current = lerp(currentSpeed.current, movement.speed, 0.5);
      // Set velocity to direction multiplied by speed
      velocity.current = direction.multiplyScalar(
        shipSpeed * currentSpeed.current * delta
      );

      // Update spaceship position based on velocity and delta time
      shipRef.current.position.add(velocity.current);

      // Calculate the camera's position
      offsetVector
        .copy(offsetValue)
        .applyQuaternion(shipRef.current.quaternion); // Rotate the offset by the spaceship's rotation
      camera.position.copy(shipRef.current.position).sub(offsetVector); // Subtract the offset from the spaceship's position

      // Set the camera's rotation to match the spaceship's rotation
      camera.quaternion
        .copy(shipRef.current.quaternion)
        .multiply(rotationQuaternion);
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
