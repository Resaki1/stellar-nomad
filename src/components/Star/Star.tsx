import { Sphere } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { FrontSide, Mesh, Vector3 } from "three";

const position = new Vector3(0, 0, 19000);

const Star = () => {
  const star = useRef<Mesh>(null!);

  useFrame(({ camera }) => {
    if (star.current) {
      star.current.position.copy(camera.position).add(position);
    }
  });

  return (
    <>
      <directionalLight // Star
        position={position}
        intensity={12}
        color="white"
        castShadow
        scale={512}
      />
      <mesh ref={star} position={position}>
        <Sphere args={[512, 48, 48]}>
          <meshStandardMaterial
            color="#fff4e6"
            emissive="#fff4e6"
            emissiveIntensity={60}
            side={FrontSide}
            depthTest={true}
            dithering
          />
        </Sphere>
      </mesh>
    </>
  );
};

export default Star;
