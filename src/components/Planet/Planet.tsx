import { Sphere, shaderMaterial, useTexture } from "@react-three/drei";
import { extend, useFrame } from "@react-three/fiber";
import { memo, useRef } from "react";
import {
  AdditiveBlending,
  DoubleSide,
  Euler,
  FrontSide,
  Group,
  Mesh,
  Vector3,
} from "three";

const AtmosphereShaderMaterial = shaderMaterial(
  // Uniforms
  {
    sunDirection: new Vector3(0, 0, 1),
  },
  `
  varying vec3 vPosition;
  varying vec3 vNormal;

  void main() {
    vPosition = position;
    vNormal = normalize(normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
  `,
  `
  uniform vec3 sunDirection;
varying vec3 vPosition;
varying vec3 vNormal;

const float Hr = 8.0; // Rayleigh scale height
const float Hm = 1.2; // Mie scale height
const vec3 betaR = vec3(5.8e-6, 1.35e-5, 3.31e-5); // Rayleigh scattering coefficients
const float betaM = 4e-5; // Mie scattering coefficient
const float planetRadius = 94.5; // Planet radius
const float atmosphereThickness = 5.0; // Atmosphere thickness

float rayleighPhase(float cosTheta) {
  return (3.0 / (16.0 * 3.14159265)) * (1.0 + cosTheta * cosTheta);
}

float miePhase(float cosTheta, float g) {
  float g2 = g * g;
  return (3.0 / (8.0 * 3.14159265)) * ((1.0 - g2) / (2.0 + g2)) * (1.0 + cosTheta * cosTheta) / pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
}

void main() {
  vec3 normalizedPosition = normalize(vPosition);
  float heightAboveSurface = length(vPosition) - planetRadius;

  // Calculate the atmospheric density based on height
  float rho = exp(-heightAboveSurface / Hr) + exp(-heightAboveSurface / Hm);

  vec3 betaRTheta = betaR * rho;
  float betaMTheta = betaM * rho;

  float cosTheta = dot(normalizedPosition, sunDirection);
  float rayleigh = rayleighPhase(cosTheta);
  float mie = miePhase(cosTheta, 0.76);

  // Intensity of the scattering effect
  vec3 scatter = (betaRTheta * rayleigh + betaMTheta * mie) * 1.0;

  // Final color based on the scattering
  vec3 finalColor = vec3(1.0) - exp(-scatter);

  // Calculate alpha for the edge fade effect
  // The alpha should start at 1 at the planet's surface and go to 0 at the edge of the atmosphere
  float edgeStart = planetRadius; // At the planet's surface
  float edgeEnd = planetRadius + atmosphereThickness; // At the upper limit of the atmosphere
  float alpha = smoothstep(edgeEnd, edgeStart, heightAboveSurface);

  // Apply the calculated alpha value
  gl_FragColor = vec4(finalColor * scatter, alpha);
}
  `
);

extend({ AtmosphereShaderMaterial });

const position = new Vector3(1000, 0, -1000);
const rotation = new Euler(1.1 * Math.PI, 1.8 * Math.PI, 0.8 * Math.PI);
const sunDirection = new Vector3(0, 0, -1);
const size = 400;

const Planet = () => {
  const planet = useRef<Group>(null!);
  const atmosphere = useRef<Mesh>(null!);
  const texture = useTexture({
    map: "/textures/earth_day.webp",
    specularMap: "/textures/earth_specular.webp",
  });
  const clouds = useTexture({
    map: "/textures/earth_clouds.webp",
    alphaMap: "/textures/earth_clouds.webp",
  });

  useFrame(({ camera }) => {
    if (planet.current) {
      planet.current.position.copy(camera.position).add(position);
    }
  });

  return (
    <group position={position} rotation={rotation} ref={planet}>
      {/* <Sphere args={[81, 64, 64]} ref={atmosphere}>
        <atmosphereShaderMaterial
          attach="material"
          args={[
            {
              sunDirection: sunDirection,
            },
          ]}
          side={DoubleSide}
          depthWrite={false}
          blending={AdditiveBlending}
        />
      </Sphere> */}
      <Sphere args={[size, 48, 48]}>
        <meshPhongMaterial
          {...texture}
          shininess={100}
          specular={"lightblue"}
          side={FrontSide}
        />
      </Sphere>
      <Sphere args={[size * 1.01, 64, 64]}>
        <meshPhongMaterial {...clouds} transparent alphaTest={0} />
      </Sphere>
    </group>
  );
};

useTexture.preload("/textures/earth_day.webp");

export default memo(Planet);
