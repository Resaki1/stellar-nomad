import { memo, useMemo } from "react";
import { Asteroid01, Instances } from "../models/asteroids/01/Asteroid01";
import { Euler, Vector3 } from "three";
import random from "@/helpers/random";
import SimGroup from "../space/SimGroup";

const fieldPositionKm: [number, number, number] = [0, 0, 400];

const AsteroidField = () => {
  const rng = random(12344);
  const width = 1000;
  const depth = 500;
  const height = 250;
  const scale = 25;
  const probability = 0.0001;
  // Precompute the positions
  const positions = useMemo(() => {
    const temp = [];
    for (let x = -width; x < width; x += 1) {
      // adjust step size for performance/quality
      for (let z = -depth; z < depth; z += 1) {
        if (rng.nextFloat() > 1 - probability) {
          temp.push([x, rng.nextFloat() * height - height / 2, z]);
        }
      }
    }
    return temp;
  }, []);

  return (
    <SimGroup space="local" positionKm={fieldPositionKm}>
      <Instances position={[0, 0, 0]} frustumCulled={false}>
        {positions.map((pos, i) => {
          return (
            <Asteroid01
              key={i}
              position={
                new Vector3(pos[0] * scale, pos[1] * scale, pos[2] * scale)
              }
              scale={rng.nextFloat() * 10}
              rotation={
                new Euler(rng.nextFloat(), rng.nextFloat(), rng.nextFloat())
              }
            />
          );
        })}
      </Instances>
    </SimGroup>
  );
};

export default memo(AsteroidField);
