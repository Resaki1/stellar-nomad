import { Sphere } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import {
  AdditiveBlending,
  Color,
  DataTexture,
  FrontSide,
  Mesh,
  NearestFilter,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
} from "three";

const position = new Vector3(0, 0, 19000);

const createRadialGlowTexture = () => {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const seed = 1337;
  let rand = seed;
  const random = () => {
    rand = (rand * 16807) % 2147483647;
    return (rand - 1) / 2147483646;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy) * 2;
      const falloff = Math.max(0, 1 - dist);
      const smooth = Math.pow(falloff, 1.6);
      const noise = (random() - 0.5) * 0.035; // dithering noise to break banding
      const alpha = Math.max(0, Math.min(1, smooth + noise));
      const base = (y * size + x) * 4;
      data[base] = 255;
      data[base + 1] = 233;
      data[base + 2] = 212;
      data[base + 3] = Math.floor(alpha * 255);
    }
  }

  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
};

const Star = () => {
  const star = useRef<Mesh>(null!);
  const glowTexture = useMemo(() => createRadialGlowTexture(), []);

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
        <Sphere args={[480, 64, 64]}>
          <meshStandardMaterial
            color="#fff4e6"
            emissive="#fff4e6"
            emissiveIntensity={28}
            side={FrontSide}
            depthTest={true}
            dithering
          />
        </Sphere>
        <Sphere args={[650, 48, 48]}>
          <meshBasicMaterial
            color={new Color("#ffe9d5").multiplyScalar(4)}
            transparent
            opacity={0.9}
            depthWrite={false}
            blending={AdditiveBlending}
            map={glowTexture}
            toneMapped={false}
          />
        </Sphere>
      </mesh>
    </>
  );
};

export default Star;
