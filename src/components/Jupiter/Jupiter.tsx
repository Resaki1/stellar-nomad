"use client";

import { memo } from "react";
import CelestialBody from "../celestial/CelestialBody";
import { jupiterConfig } from "../celestial/bodies/jupiter";

export { JUPITER_POSITION_KM, JUPITER_RADIUS_KM } from "../celestial/bodies/jupiter";

const Jupiter = memo(() => <CelestialBody config={jupiterConfig} />);
Jupiter.displayName = "Jupiter";
export default Jupiter;
