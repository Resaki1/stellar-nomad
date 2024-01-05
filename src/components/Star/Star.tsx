import { Sphere } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { Mesh, MeshStandardMaterial, Vector3 } from "three";

const position = new Vector3(0, 0, 500);

const Star = () => {
  const star = useRef<Mesh>(null!);

  useFrame(({ camera }) => {
    if (star.current) {
      star.current.position.copy(camera.position);
    }
  });

  return (
    <mesh ref={star}>
      <directionalLight // Star
        intensity={12}
        position={position}
        color="white"
      />
      <Sphere
        args={[5, 128, 128]}
        position={position}
        material={
          new MeshStandardMaterial({
            color: "white",
            emissive: "white",
            emissiveIntensity: 4,
            toneMapped: false,
          })
        }
      />
    </mesh>
  );
};

export default Star;
