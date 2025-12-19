/* eslint-disable jsx-a11y/alt-text */
import { Billboard, Image, Sphere } from "@react-three/drei";
import { FrontSide } from "three";

import SimGroup from "@/components/space/SimGroup";
import { SCALED_UNITS_PER_KM, Vector3Like } from "@/sim/units";

const STAR_POSITION_KM: Vector3Like = [65_000_000, 0, 130_000_000];
const RADIUS_KM = 696_340;

type StarProps = {
  bloom: boolean;
  positionKm?: Vector3Like;
};

const Star = ({ bloom, positionKm = STAR_POSITION_KM }: StarProps) => {
  return (
    <SimGroup space="scaled" positionKm={positionKm}>
      <directionalLight // Star
        position={[0, 0, 0]}
        intensity={10}
        color="white"
        castShadow
        scale={RADIUS_KM * SCALED_UNITS_PER_KM}
      />
      <mesh>
        {!bloom && (
          <Billboard>
            <Image url="/assets/star.png" scale={2048} transparent />
          </Billboard>
        )}
        <Sphere args={[RADIUS_KM * SCALED_UNITS_PER_KM, 16, 16]}>
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
