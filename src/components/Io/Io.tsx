"use client";

import { memo } from "react";
import CelestialBody from "../celestial/CelestialBody";
import { ioConfig } from "../celestial/bodies/io";

export { IO_POSITION_KM, IO_RADIUS_KM } from "../celestial/bodies/io";

export default memo(() => <CelestialBody config={ioConfig} />);
