"use client";

import { memo } from "react";
import CelestialBody from "../celestial/CelestialBody";
import { europaConfig } from "../celestial/bodies/europa";

export { EUROPA_POSITION_KM, EUROPA_RADIUS_KM } from "../celestial/bodies/europa";

const Europa = memo(() => <CelestialBody config={europaConfig} />);
Europa.displayName = "Europa";
export default Europa;
