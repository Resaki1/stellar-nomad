/* eslint-disable jsx-a11y/alt-text */
import { Billboard, Image, Sphere } from "@react-three/drei";
import { FrontSide } from "three";
import SimGroup from "../space/SimGroup";
import { kmToScaledUnits } from "@/sim/units";

const STAR_POSITION_KM: [number, number, number] = [65_000_000, 0, 130_000_000];
const STAR_RADIUS_KM = 696_340;

type StarProps = {
  bloom: boolean;
};

const Star = ({ bloom }: StarProps) => {
  const scaledRadius = kmToScaledUnits(STAR_RADIUS_KM);

  return (
    <SimGroup space="scaled" positionKm={STAR_POSITION_KM}>
      <directionalLight
        position={[0, 0, 0]}
        intensity={10}
        color="white"
        castShadow
        scale={scaledRadius}
      />
      <mesh position={[0, 0, 0]}>
        {!bloom && (
          <Billboard>
            <Image url="/assets/star.png" scale={2048} transparent />
          </Billboard>
        )}
        <Sphere args={[scaledRadius, 16, 16]}>
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
