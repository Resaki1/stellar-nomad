import * as THREE from "three";
import {
  GANYMEDE_POSITION_KM,
  GANYMEDE_RADIUS_KM,
} from "@/sim/celestialConstants";
import type { CelestialBodyConfig } from "../types";
import { buildRockyFragmentNode } from "./rockyFragment";

export { GANYMEDE_POSITION_KM, GANYMEDE_RADIUS_KM };

// ─────────────────────────────────────────────────────────────────────

export const ganymedeConfig: CelestialBodyConfig = {
  id: "ganymede",
  positionKm: GANYMEDE_POSITION_KM,
  radiusKm: GANYMEDE_RADIUS_KM,

  lod: { near: 50_000, far: 350_000 },
  near: { textures: { color: "/textures/ganymede/8k_ganymede.ktx2" }, segments: 128 },
  mid: { textures: { color: "/textures/ganymede/2k_ganymede.ktx2" }, segments: 48 },
  far: { albedo: new THREE.Color(0.45, 0.43, 0.40) },
  stellarPoint: { geometricAlbedo: 0.43, color: [0.78, 0.76, 0.72] },

  buildFragmentNode: ({ textures, uSunRel }) =>
    buildRockyFragmentNode(textures.color, uSunRel, 0.10),
};
