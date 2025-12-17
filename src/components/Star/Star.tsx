/* eslint-disable jsx-a11y/alt-text */
import { Billboard, Image, Sphere } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  AdditiveBlending,
  Color,
  FrontSide,
  Mesh,
  ShaderMaterial,
  Vector3,
} from "three";

const position = new Vector3(0, 0, 19000);

type StarProps = {
  bloom: boolean;
};

const Star = ({ bloom }: StarProps) => {
  const star = useRef<Mesh>(null!);

  const glowMaterial = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: AdditiveBlending,
        toneMapped: false,
        uniforms: {
          uColor: { value: new Color("#fff5e8") },
          uIntensity: { value: 1.4 },
          uFalloff: { value: 2.8 },
          uSoftness: { value: 0.6 },
        },
        vertexShader: `
          varying vec2 vUv;

          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          varying vec2 vUv;
          uniform vec3 uColor;
          uniform float uIntensity;
          uniform float uFalloff;
          uniform float uSoftness;

          void main() {
            vec2 centeredUv = vUv - 0.5;
            float dist = length(centeredUv) * 2.0;
            float halo = pow(max(0.0, 1.0 - dist), uFalloff);
            float core = smoothstep(1.0, uSoftness, 1.0 - dist);
            float alpha = clamp(halo + core, 0.0, 1.0) * uIntensity;
            gl_FragColor = vec4(uColor, alpha);
          }
        `,
      }),
    []
  );

  useEffect(() => () => glowMaterial.dispose(), [glowMaterial]);

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
        {!bloom && (
          <Billboard>
            <Image url="/assets/star.png" scale={2048} transparent />
          </Billboard>
        )}
        <Billboard>
          <mesh scale={5000} renderOrder={1}>
            <planeGeometry args={[1, 1]} />
            <primitive object={glowMaterial} attach="material" />
          </mesh>
        </Billboard>
        <Sphere args={[512, 16, 16]}>
          <meshStandardMaterial
            color="white"
            emissive="white"
            emissiveIntensity={96}
            toneMapped={false}
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
