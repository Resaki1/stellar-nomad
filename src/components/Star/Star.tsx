/* eslint-disable jsx-a11y/alt-text */
import { Billboard, Image, Sphere } from "@react-three/drei";
import { useMemo, useRef } from "react";
import { FrontSide, Mesh } from "three";
import SimGroup from "@/components/space/SimGroup";
import { Vector3Tuple, kmToScaledUnits } from "@/sim/units";

const SUN_POSITION_KM: Vector3Tuple = [65_000_000, 0, 130_000_000];

type StarProps = {
  bloom: boolean;
};

const RADIUS_KM = 696_340;

const Star = ({ bloom }: StarProps) => {
  const star = useRef<Mesh>(null!);
  const radiusScaled = useMemo(() => kmToScaledUnits(RADIUS_KM), []);

  return (
    <SimGroup space="scaled" positionKm={SUN_POSITION_KM}>
      <directionalLight // Star
        position={[0, 0, 0]}
        intensity={10}
        color="white"
        castShadow
        scale={radiusScaled}
      />
      <mesh ref={star}>
        {!bloom && (
          <Billboard>
            <Image url="/assets/star.png" scale={2048} transparent />
          </Billboard>
        )}
        <Sphere args={[radiusScaled, 16, 16]}>
          <meshBasicMaterial
            color={[512, 512, 512]}
            toneMapped={false}
            side={FrontSide}
            depthTest={true}
          />
        </Sphere>
      </mesh>
    </SimGroup>
  );
};

export default Star;
