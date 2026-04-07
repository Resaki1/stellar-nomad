"use client";

import { memo } from "react";
import CelestialBody from "../celestial/CelestialBody";
import { earthConfig } from "../celestial/bodies/earth";

export { PLANET_POSITION_KM } from "../celestial/bodies/earth";

export default memo(() => <CelestialBody config={earthConfig} />);
