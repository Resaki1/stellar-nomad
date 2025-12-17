/* eslint-disable jsx-a11y/alt-text */
import { Billboard, Image, Sphere } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { FrontSide, Mesh, Vector3 } from "three";

const position = new Vector3(0, 0, 19000);

type StarProps = {
  bloom: boolean;
};

const Star = ({ bloom }: StarProps) => {
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
        intensity={10}
        color="white"
        castShadow
        scale={512}
      />
      <mesh ref={star} position={position}>
        {!bloom && (
          <Billboard>
            <Image url="/assets/star.png" scale={2048} transparent />
          </Billboard>
        )}
        <Sphere args={[512, 16, 16]}>
          <meshBasicMaterial
            color={[512, 512, 512]}
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
