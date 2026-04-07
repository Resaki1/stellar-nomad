"use client";

import { memo } from "react";
import CelestialBody from "../celestial/CelestialBody";
import { jupiterConfig } from "../celestial/bodies/jupiter";

export { JUPITER_POSITION_KM, JUPITER_RADIUS_KM } from "../celestial/bodies/jupiter";

export default memo(() => <CelestialBody config={jupiterConfig} />);
