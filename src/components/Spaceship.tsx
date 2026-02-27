import { logLimit } from "@/helpers/math";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { Quaternion, Vector3, Mesh, MathUtils } from "three";
import { ShipOne } from "./models/ships/ShipOne";
import { lerp } from "three/src/math/MathUtils.js";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { hudInfoAtom, movementAtom } from "@/store/store";
import { knockbackImpulseAtom } from "@/store/vfx";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { toLocalUnitsKm } from "@/sim/units";

const quaternion = new Quaternion();
const xAxis = new Vector3(1, 0, 0);
const yAxis = new Vector3(0, 1, 0);
const forwardDirection = new Vector3(0, 0, 1);
const cameraOffset = new Vector3(0, -4, 10);
const offsetVector = cameraOffset.clone();
const rotationQuaternion = new Quaternion();
rotationQuaternion.setFromAxisAngle(yAxis, Math.PI);

const shipHandling = 1.5;
const maxRotationSpeed = shipHandling / 2;

const SHIP_MAX_SPEED_MPS = 200;
const SHIP_MAX_SPEED_KMPS = SHIP_MAX_SPEED_MPS / 1000;

const KNOCKBACK_DECAY = 4.0; // how fast knockback decays per second

let timeAccumulator = 0;
const hudUpdateInterval = 0.25;

const SpaceShip = () => {
  const movement = useAtomValue(movementAtom);
  const setHudInfo = useSetAtom(hudInfoAtom);
  const [knockbackImpulse, setKnockbackImpulse] = useAtom(knockbackImpulseAtom);
  const worldOrigin = useWorldOrigin();
  const shipRef = useRef<Mesh>(null!);
  const modelRef = useRef<Mesh>(null!);

  const shipSimPos = useRef(new Vector3());
  const velocity = useRef(new Vector3());
  const localRelative = useRef(new Vector3());

  // Knockback velocity (decays over time, in km/s components)
  const knockbackVel = useRef(new Vector3());

  const movementYaw = useRef(0);
  const movementPitch = useRef(0);
  const visualRoll = useRef(0);
  const visualPitch = useRef(0);
  const currentSpeed = useRef(0);
  const oldPosition = useRef(new Vector3());

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
        visualRoll.current = MathUtils.lerp(visualRoll.current, 0, shipHandling * delta);
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
        visualPitch.current = MathUtils.lerp(visualPitch.current, 0, shipHandling * delta);
        movementPitch.current -= movementPitch.current * shipHandling * delta;
      }

      modelRef.current.rotation.set(visualPitch.current, modelRef.current.rotation.y, visualRoll.current);

      // Apply yaw and pitch to ship rotation
      quaternion.setFromAxisAngle(yAxis, -movementYaw.current * delta);
      shipRef.current.quaternion.multiply(quaternion);
      quaternion.setFromAxisAngle(xAxis, movementPitch.current * delta);
      shipRef.current.quaternion.multiply(quaternion);

      forwardDirection.set(0, 0, 1).applyQuaternion(shipRef.current.quaternion);

      currentSpeed.current = lerp(currentSpeed.current, movement.speed, 0.01);

      // Consume knockback impulse if present
      if (knockbackImpulse) {
        knockbackVel.current.set(
          knockbackImpulse.dx * knockbackImpulse.magnitude,
          knockbackImpulse.dy * knockbackImpulse.magnitude,
          knockbackImpulse.dz * knockbackImpulse.magnitude
        );
        setKnockbackImpulse(null);
      }

      velocity.current
        .copy(forwardDirection)
        .multiplyScalar(SHIP_MAX_SPEED_KMPS * currentSpeed.current * delta);

      // Add knockback contribution
      if (knockbackVel.current.lengthSq() > 1e-12) {
        velocity.current.addScaledVector(knockbackVel.current, delta);
        // Decay knockback
        knockbackVel.current.multiplyScalar(Math.max(0, 1 - KNOCKBACK_DECAY * delta));
        if (knockbackVel.current.lengthSq() < 1e-12) {
          knockbackVel.current.set(0, 0, 0);
        }
      }

      shipSimPos.current.add(velocity.current);
      worldOrigin.setShipPosKm(shipSimPos.current);
      worldOrigin.maybeRecenter(shipSimPos.current);

      localRelative.current.copy(shipSimPos.current).sub(worldOrigin.worldOriginKm);
      toLocalUnitsKm(localRelative.current, shipRef.current.position);

      timeAccumulator += delta;
      if (timeAccumulator > hudUpdateInterval) {
        const speedKmPerSec = shipSimPos.current.distanceTo(oldPosition.current) / hudUpdateInterval;

        setHudInfo({
          speed: speedKmPerSec * 1000,
        });

        timeAccumulator = 0;
        oldPosition.current.copy(shipSimPos.current);
      }

      offsetVector.copy(cameraOffset).applyQuaternion(shipRef.current.quaternion);
      offsetVector.add(forwardDirection.normalize().multiplyScalar(currentSpeed.current * 0.75 + 1));

      camera.position.copy(shipRef.current.position).sub(offsetVector);
      camera.quaternion.copy(shipRef.current.quaternion).multiply(rotationQuaternion);
    }
  });

  return (
    <mesh ref={shipRef} name="playerShip">
      <ShipOne ref={modelRef} name="playerShipModel" />
    </mesh>
  );
};

export default SpaceShip;
