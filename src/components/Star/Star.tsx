/* eslint-disable jsx-a11y/alt-text */
import { Billboard, Image, Sphere } from "@react-three/drei";
import { useRef } from "react";
import { FrontSide, Group } from "three";
import SimGroup from "../space/SimGroup";
import { kmToScaledUnits } from "@/sim/units";

type StarProps = {
  bloom: boolean;
};

export const STAR_POSITION_KM: [number, number, number] = [
  130_000_000, 0, 130_000_000,
];
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
