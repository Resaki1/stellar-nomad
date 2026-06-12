"use client";

import { memo } from "react";
import CelestialBody from "../celestial/CelestialBody";
import { mercuryConfig } from "../celestial/bodies/mercury";

export { MERCURY_POSITION_KM, MERCURY_RADIUS_KM } from "../celestial/bodies/mercury";

const Mercury = memo(() => <CelestialBody config={mercuryConfig} />);
Mercury.displayName = "Mercury";
export default Mercury;
