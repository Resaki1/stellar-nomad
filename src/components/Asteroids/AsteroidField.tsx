import { memo, useMemo } from "react";
import { Asteroid01, Instances } from "../models/asteroids/01/Asteroid01";
import { Euler, Vector3 } from "three";

const fieldPosition = new Vector3(0, 0, 400);

const AsteroidField = () => {
  const width = 500;
  const depth = 250;
  const height = 250;
  const scale = 20;
  const probability = 0.0001;
  // Precompute the positions
  const positions = useMemo(() => {
    const temp = [];
    for (let x = -width; x < width; x += 1) {
      // adjust step size for performance/quality
      for (let z = -depth; z < depth; z += 1) {
        if (Math.random() > 1 - probability) {
          temp.push([x, Math.random() * height - height / 2, z]);
        }
      }
    }
    return temp;
  }, []);

  return (
    <Instances position={fieldPosition} frustumCulled={false}>
      {positions.map((pos, i) => {
        return (
          <Asteroid01
            key={i}
            position={
              new Vector3(pos[0] * scale, pos[1] * scale, pos[2] * scale)
            }
            scale={Math.random() * 10}
            rotation={new Euler(Math.random(), Math.random(), Math.random())}
          />
        );
      })}
    </Instances>
  );
};

export default memo(AsteroidField);
