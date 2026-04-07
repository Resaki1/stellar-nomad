import * as THREE from "three";
import {
  IO_POSITION_KM,
  IO_RADIUS_KM,
} from "@/sim/celestialConstants";
import type { CelestialBodyConfig } from "../types";
import { buildRockyFragmentNode } from "./rockyFragment";

export { IO_POSITION_KM, IO_RADIUS_KM };

// ─────────────────────────────────────────────────────────────────────

export const ioConfig: CelestialBodyConfig = {
  id: "io",
  positionKm: IO_POSITION_KM,
  radiusKm: IO_RADIUS_KM,

  lod: { near: 40_000, far: 350_000 },
  near: { textures: { color: "/textures/io/4k_io.ktx2" }, segments: 128 },
  mid: { textures: { color: "/textures/io/2k_io.ktx2" }, segments: 48 },
  far: { albedo: new THREE.Color(0.36, 0.26, 0.14) },
  stellarPoint: { geometricAlbedo: 0.63, color: [0.90, 0.78, 0.50] },

  buildFragmentNode: ({ textures, uSunRel }) =>
    buildRockyFragmentNode(textures.color, uSunRel, 0.10),
};
