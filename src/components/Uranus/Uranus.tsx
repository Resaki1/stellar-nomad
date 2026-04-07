"use client";

import { memo } from "react";
import CelestialBody from "../celestial/CelestialBody";
import { uranusConfig } from "../celestial/bodies/uranus";

export { URANUS_POSITION_KM, URANUS_RADIUS_KM } from "../celestial/bodies/uranus";

export default memo(() => <CelestialBody config={uranusConfig} />);
