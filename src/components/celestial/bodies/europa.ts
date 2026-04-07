import * as THREE from "three";
import {
  EUROPA_POSITION_KM,
  EUROPA_RADIUS_KM,
} from "@/sim/celestialConstants";
import type { CelestialBodyConfig } from "../types";
import { buildRockyFragmentNode } from "./rockyFragment";

export { EUROPA_POSITION_KM, EUROPA_RADIUS_KM };

// ─────────────────────────────────────────────────────────────────────

export const europaConfig: CelestialBodyConfig = {
  id: "europa",
  positionKm: EUROPA_POSITION_KM,
  radiusKm: EUROPA_RADIUS_KM,

  lod: { near: 35_000, far: 350_000 },
  near: { textures: { color: "/textures/europa/8k_europa.ktx2" }, segments: 128 },
  mid: { textures: { color: "/textures/europa/2k_europa.ktx2" }, segments: 48 },
  far: { albedo: new THREE.Color(0.55, 0.52, 0.48) },
  stellarPoint: { geometricAlbedo: 0.67, color: [0.88, 0.85, 0.80] },

  buildFragmentNode: ({ textures, uSunRel }) =>
    buildRockyFragmentNode(textures.color, uSunRel, 0.10),
};
