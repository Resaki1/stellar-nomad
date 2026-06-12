"use client";

import { memo } from "react";
import CelestialBody from "../celestial/CelestialBody";
import { ioConfig } from "../celestial/bodies/io";

export { IO_POSITION_KM, IO_RADIUS_KM } from "../celestial/bodies/io";

const Io = memo(() => <CelestialBody config={ioConfig} />);
Io.displayName = "Io";
export default Io;
