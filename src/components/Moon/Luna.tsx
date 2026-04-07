"use client";

import { memo } from "react";
import CelestialBody from "../celestial/CelestialBody";
import { lunaConfig } from "../celestial/bodies/luna";

export { LUNA_POSITION_KM, LUNA_RADIUS_KM } from "../celestial/bodies/luna";

export default memo(() => <CelestialBody config={lunaConfig} />);
