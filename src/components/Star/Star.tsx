/* eslint-disable jsx-a11y/alt-text */
import { Billboard, Image, Sphere } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { Mesh, Vector3 } from "three";

const position = new Vector3(0, 0, 500);

const Star = () => {
  const star = useRef<Mesh>(null!);

  useFrame(({ camera }) => {
    if (star.current) {
      star.current.position.copy(camera.position).add(position);
    }
  });

  return (
    <mesh ref={star} position={position}>
      <directionalLight // Star
        intensity={12}
        color="white"
        castShadow
      />
      <Sphere args={[5, 128, 128]}>
        <meshStandardMaterial
          color="white"
          emissive="white"
          emissiveIntensity={512}
          toneMapped={false}
        />
      </Sphere>
      <Billboard>
        <Image url="/assets/star.png" scale={32} transparent />
      </Billboard>
    </mesh>
  );
};

export default Star;
