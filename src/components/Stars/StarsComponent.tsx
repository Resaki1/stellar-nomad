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

type StarsComponentProps = {
  space?: "local" | "scaled";
};
const StarsComponent = ({ space = "local" }: StarsComponentProps) => {
  const stars = useRef<
    Points<BufferGeometry<NormalBufferAttributes>, Material | Material[]>
  >(null!);

  useFrame(({ camera }) => {
    if (stars.current) {
      stars.current.position
        .copy(camera.position)
        .multiplyScalar(space === "scaled" ? SCALED_UNITS_PER_KM : 1);
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
