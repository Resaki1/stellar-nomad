import { Stars } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import {
  Points,
  BufferGeometry,
  NormalBufferAttributes,
  Material,
  Vector3,
} from "three";
import { LOCAL_UNITS_PER_KM, SCALED_UNITS_PER_KM } from "@/sim/units";

const StarsComponent = () => {
  const stars = useRef<
    Points<BufferGeometry<NormalBufferAttributes>, Material | Material[]>
  >(null!);
  const scaledPosition = useMemo(() => new Vector3(), []);

  useFrame(({ camera }) => {
    if (stars.current) {
      scaledPosition
        .copy(camera.position)
        .multiplyScalar(SCALED_UNITS_PER_KM / LOCAL_UNITS_PER_KM);
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
