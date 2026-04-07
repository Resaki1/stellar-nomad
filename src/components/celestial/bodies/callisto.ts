import * as THREE from "three";
import {
  CALLISTO_POSITION_KM,
  CALLISTO_RADIUS_KM,
} from "@/sim/celestialConstants";
import type { CelestialBodyConfig } from "../types";
import { buildRockyFragmentNode } from "./rockyFragment";

export { CALLISTO_POSITION_KM, CALLISTO_RADIUS_KM };

// ─────────────────────────────────────────────────────────────────────

export const callistoConfig: CelestialBodyConfig = {
  id: "callisto",
  positionKm: CALLISTO_POSITION_KM,
  radiusKm: CALLISTO_RADIUS_KM,

  lod: { near: 50_000, far: 350_000 },
  near: { textures: { color: "/textures/callisto/8k_callisto.ktx2" }, segments: 128 },
  mid: { textures: { color: "/textures/callisto/2k_callisto.ktx2" }, segments: 48 },
  far: { albedo: new THREE.Color(0.30, 0.28, 0.25) },
  stellarPoint: { geometricAlbedo: 0.22, color: [0.68, 0.65, 0.60] },

  buildFragmentNode: ({ textures, uSunRel }) =>
    buildRockyFragmentNode(textures.color, uSunRel, 0.10),
};
