"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { STAR_POSITION_KM } from "./Star";
import { useWorldOrigin } from "@/sim/worldOrigin";

type SunLightProps = {
  sunPositionKm?: [number, number, number];
  intensity?: number;
  color?: string | number;
};

const _dir = new THREE.Vector3();

const SunLight = ({
  sunPositionKm = STAR_POSITION_KM,
  intensity = 30,
  color = "white",
}: SunLightProps) => {
  const ref = useRef<THREE.DirectionalLight>(null!);
  const worldOrigin = useWorldOrigin();

  useFrame(() => {
    // DirectionalLight.position is interpreted as a direction vector.
    // Compute sun direction relative to the ship so it stays correct
    // regardless of the world origin.
    _dir.set(
      sunPositionKm[0] - worldOrigin.shipPosKm.x,
      sunPositionKm[1] - worldOrigin.shipPosKm.y,
      sunPositionKm[2] - worldOrigin.shipPosKm.z,
    ).normalize();
    ref.current.position.copy(_dir);
  });

  return (
    <directionalLight
      ref={ref}
      intensity={intensity}
      color={color}
    />
  );
};

export default SunLight;
