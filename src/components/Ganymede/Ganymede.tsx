"use client";

import { memo } from "react";
import CelestialBody from "../celestial/CelestialBody";
import { ganymedeConfig } from "../celestial/bodies/ganymede";

export { GANYMEDE_POSITION_KM, GANYMEDE_RADIUS_KM } from "../celestial/bodies/ganymede";

export default memo(() => <CelestialBody config={ganymedeConfig} />);
