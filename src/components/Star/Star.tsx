/* eslint-disable jsx-a11y/alt-text */
import { Billboard, Image, Sphere } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { FrontSide, Mesh, Vector3 } from "three";

const position = new Vector3(0, 0, 512);

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
        <Billboard>
          <Image url="/assets/star.png" scale={64} transparent />
        </Billboard>
        <Sphere args={[16, 16, 16]}>
          <meshStandardMaterial
            color="white"
            emissive="white"
            emissiveIntensity={512}
            toneMapped={false}
            side={FrontSide}
            depthTest={true}
          />
        </Sphere>
      </mesh>
    </>
  );
};

export default Star;
