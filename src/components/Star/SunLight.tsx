"use client";

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { DirectionalLight, Object3D, Vector3 } from "three";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { STAR_POSITION_KM } from "./Star";
import { kmToLocalUnits, toLocalUnitsKm } from "@/sim/units";

type SunLightProps = {
  sunPositionKm?: readonly [number, number, number];
  intensity?: number;
  color?: string | number;
};

const MAX_LOCAL_LIGHT_DISTANCE_KM = 10_000;

const SunLight = ({
  sunPositionKm = STAR_POSITION_KM,
  intensity = 10,
  color = "white",
}: SunLightProps) => {
  const worldOrigin = useWorldOrigin();
  const lightRef = useRef<DirectionalLight>(null!);
  const target = useMemo(() => new Object3D(), []);
  const relative = useMemo(() => new Vector3(), []);
  const relativeLocal = useMemo(() => new Vector3(), []);
  const direction = useMemo(() => new Vector3(), []);

  useFrame(() => {
    relative.set(sunPositionKm[0], sunPositionKm[1], sunPositionKm[2]);
    relative.sub(worldOrigin.worldOriginKm);

    if (!relative.lengthSq()) return;

    toLocalUnitsKm(relative, relativeLocal);

    direction
      .copy(relativeLocal)
      .normalize()
      .multiplyScalar(
        Math.min(
          relativeLocal.length(),
          kmToLocalUnits(MAX_LOCAL_LIGHT_DISTANCE_KM)
        )
      );

    if (lightRef.current) {
      lightRef.current.position.copy(direction);
      target.position.set(0, 0, 0);
      target.updateMatrixWorld();
    }
  });

  return (
    <>
      <directionalLight ref={lightRef} intensity={intensity} color={color} target={target} />
      <primitive object={target} />
    </>
  );
};

export default SunLight;
