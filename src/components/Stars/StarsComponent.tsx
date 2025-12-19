import { Stars } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import {
  Points,
  BufferGeometry,
  NormalBufferAttributes,
  Material,
} from "three";

import { SCALED_UNITS_PER_KM } from "@/sim/units";

const StarsComponent = () => {
  const stars = useRef<
    Points<BufferGeometry<NormalBufferAttributes>, Material | Material[]>
  >(null!);

  useFrame(({ camera }) => {
    if (stars.current) {
      stars.current.position
        .copy(camera.position)
        .multiplyScalar(SCALED_UNITS_PER_KM);
    }
  });

  return (
    <Stars
      ref={stars}
      radius={100_000}
      depth={500}
      count={20_000}
      factor={2_000}
      saturation={0}
      fade
      speed={0.0}
    />
  );
};

export default StarsComponent;
