"use client";

import { memo } from "react";
import CelestialBody from "../celestial/CelestialBody";
import { marsConfig } from "../celestial/bodies/mars";

export { MARS_POSITION_KM, MARS_RADIUS_KM } from "../celestial/bodies/mars";

const Mars = memo(() => <CelestialBody config={marsConfig} />);
Mars.displayName = "Mars";
export default Mars;
