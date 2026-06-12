"use client";

import { memo } from "react";
import CelestialBody from "../celestial/CelestialBody";
import { saturnConfig } from "../celestial/bodies/saturn";

export { SATURN_POSITION_KM, SATURN_RADIUS_KM } from "../celestial/bodies/saturn";

const Saturn = memo(() => <CelestialBody config={saturnConfig} />);
Saturn.displayName = "Saturn";
export default Saturn;
