"use client";

import { memo } from "react";
import CelestialBody from "../celestial/CelestialBody";
import { callistoConfig } from "../celestial/bodies/callisto";

export { CALLISTO_POSITION_KM, CALLISTO_RADIUS_KM } from "../celestial/bodies/callisto";

export default memo(() => <CelestialBody config={callistoConfig} />);
