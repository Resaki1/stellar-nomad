"use client";

import { memo } from "react";
import CelestialBody from "../celestial/CelestialBody";
import { venusConfig } from "../celestial/bodies/venus";

export { VENUS_POSITION_KM, VENUS_RADIUS_KM } from "../celestial/bodies/venus";

const Venus = memo(() => <CelestialBody config={venusConfig} />);
Venus.displayName = "Venus";
export default Venus;
