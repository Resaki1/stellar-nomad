"use client";

import { STAR_POSITION_KM } from "./Star";

type SunLightProps = {
  sunPositionKm?: [number, number, number];
  intensity?: number;
  color?: string | number;
};

const SunLight = ({
  sunPositionKm = STAR_POSITION_KM,
  intensity = 30,
  color = "white",
}: SunLightProps) => {
  return (
    <>
      <directionalLight
        position={sunPositionKm}
        intensity={intensity}
        color={color}
      />
    </>
  );
};

export default SunLight;
