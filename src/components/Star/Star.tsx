/* eslint-disable jsx-a11y/alt-text */
import { Billboard, Image, Sphere } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { FrontSide, Mesh, Vector3 } from "three";

const position = new Vector3(65_000, 0, 130_000);

type StarProps = {
  bloom: boolean;
};

const RADIUS = 696.34;

const Star = ({ bloom }: StarProps) => {
  const star = useRef<Mesh>(null!);

  // move star with camera to avoid unhandled colission issues
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
        scale={RADIUS}
      />
      <mesh ref={star} position={position}>
        {!bloom && (
          <Billboard>
            <Image url="/assets/star.png" scale={2048} transparent />
          </Billboard>
        )}
        <Sphere args={[RADIUS, 16, 16]}>
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
