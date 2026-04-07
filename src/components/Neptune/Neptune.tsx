"use client";

import { memo } from "react";
import CelestialBody from "../celestial/CelestialBody";
import { neptuneConfig } from "../celestial/bodies/neptune";

export { NEPTUNE_POSITION_KM, NEPTUNE_RADIUS_KM } from "../celestial/bodies/neptune";

export default memo(() => <CelestialBody config={neptuneConfig} />);
