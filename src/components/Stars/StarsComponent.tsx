import { Stars } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import {
  Points,
  BufferGeometry,
  NormalBufferAttributes,
  Material,
} from "three";

const StarsComponent = () => {
  const stars = useRef<
    Points<BufferGeometry<NormalBufferAttributes>, Material | Material[]>
  >(null!);

  useFrame(({ camera }) => {
    if (stars.current) {
      stars.current.position.copy(camera.position);
    }
  });

  return (
    <Stars
      ref={stars}
      radius={200}
      depth={50}
      count={5000}
      factor={4}
      saturation={0}
      fade
      speed={0.2}
    />
  );
};

export default StarsComponent;
