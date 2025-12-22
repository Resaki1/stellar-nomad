// Deprecated: using image-based stars for realistic star positioning

import { Stars } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import {
  Points,
  BufferGeometry,
  NormalBufferAttributes,
  Material,
  Vector3,
} from "three";
import { SCALED_UNITS_PER_KM } from "@/sim/units";

const scaledPosition = new Vector3();

const StarsComponent = () => {
  const stars = useRef<
    Points<BufferGeometry<NormalBufferAttributes>, Material | Material[]>
  >(null!);

  useFrame(({ camera }) => {
    if (stars.current) {
      scaledPosition.copy(camera.position).multiplyScalar(SCALED_UNITS_PER_KM);
      stars.current.position.copy(scaledPosition);
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
