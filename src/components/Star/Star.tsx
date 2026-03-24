/* eslint-disable jsx-a11y/alt-text */
import { Billboard, Image, Sphere } from "@react-three/drei";
import { useRef } from "react";
import { FrontSide, Group } from "three";
import SimGroup from "../space/SimGroup";
import { kmToScaledUnits } from "@/sim/units";
import { STAR_POSITION_KM } from "@/sim/celestialConstants";

export { STAR_POSITION_KM };

type StarProps = {
  bloom: boolean;
};

const RADIUS = kmToScaledUnits(696_340);

const Star = ({ bloom }: StarProps) => {
  const star = useRef<Group>(null!);

  return (
    <SimGroup space="scaled" positionKm={STAR_POSITION_KM}>
      <group ref={star}>
        {!bloom && (
          <Billboard>
            <Image url="/assets/star.png" scale={2048} transparent />
          </Billboard>
        )}
        <Sphere args={[RADIUS, 16, 16]}>
          <meshBasicMaterial
            color={[4096, 4096, 4096]}
            toneMapped={false}
            side={FrontSide}
            depthTest={true}
          />
        </Sphere>
      </group>
    </SimGroup>
  );
};

export default Star;
