import * as THREE from "three";
import {
  Fn,
  texture,
  uv,
  normalWorld,
  tangentWorld,
  bitangentWorld,
  positionWorld,
  positionLocal,
  normalLocal,
  cameraPosition,
  vec2,
  vec3,
  vec4,
  float,
  dot,
  normalize,
  clamp,
  pow,
  sub,
} from "three/tsl";
import {
  LUNA_POSITION_KM,
  LUNA_RADIUS_KM,
} from "@/sim/celestialConstants";
import { kmToScaledUnits } from "@/sim/units";
import type { CelestialBodyConfig } from "../types";

export { LUNA_POSITION_KM, LUNA_RADIUS_KM };

const LUNA_ALBEDO = new THREE.Color(0.44, 0.42, 0.40);

// ── Displacement ──
const DISPLACEMENT_SCALE_KM = 10.786; // ~10.8 km peak-to-valley (real lunar range)

// ─────────────────────────────────────────────────────────────────────
// Luna fragment: rocky/airless with displacement-derived bumps.
// Sobel filter on displacement texture for perturbed normal,
// hard diffuse, opposition surge, earthshine on dark side.
// ─────────────────────────────────────────────────────────────────────

function buildLunaFragmentNode(
  colorTex: THREE.Texture,
  dispTex: THREE.Texture,
  bumpStrength: number,
  texelSize: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any,
) {
  return Fn(() => {
    const uvCoord = uv();
    const sunDir = normalize(uSunRel);
    const albedo = texture(colorTex, uvCoord).rgb;

    // ── Perturbed normal from heightmap (Sobel filter) ──
    const t = float(texelSize * 2.0);

    // 3x3 neighbourhood heights
    const hTL = texture(dispTex, uvCoord.add(vec2(t.negate(), t))).r;
    const hTC = texture(dispTex, uvCoord.add(vec2(0, t))).r;
    const hTR = texture(dispTex, uvCoord.add(vec2(t, t))).r;
    const hML = texture(dispTex, uvCoord.add(vec2(t.negate(), 0))).r;
    const hMR = texture(dispTex, uvCoord.add(vec2(t, 0))).r;
    const hBL = texture(dispTex, uvCoord.add(vec2(t.negate(), t.negate()))).r;
    const hBC = texture(dispTex, uvCoord.add(vec2(0, t.negate()))).r;
    const hBR = texture(dispTex, uvCoord.add(vec2(t, t.negate()))).r;

    // Sobel horizontal: [-1 0 +1; -2 0 +2; -1 0 +1]
    const gradU = hTR.add(hMR.mul(2)).add(hBR)
      .sub(hTL).sub(hML.mul(2)).sub(hBL)
      .mul(float(bumpStrength));

    // Sobel vertical:   [+1 +2 +1;  0  0  0; -1 -2 -1]
    const gradV = hTL.add(hTC.mul(2)).add(hTR)
      .sub(hBL).sub(hBC.mul(2)).sub(hBR)
      .mul(float(bumpStrength));

    // Tangent-space perturbed normal
    // @ts-ignore -- TSL MathNode inference limitation
    const tsNormal = normalize(vec3(gradU.negate(), gradV.negate(), float(1.0)));

    // TBN matrix -- requires geometry with computed tangents
    // @ts-ignore -- TSL node type inference limitation
    const T: any = normalize(tangentWorld); // eslint-disable-line @typescript-eslint/no-explicit-any
    // @ts-ignore -- TSL node type inference limitation
    const B: any = normalize(bitangentWorld); // eslint-disable-line @typescript-eslint/no-explicit-any
    const N_geom: any = normalize(normalWorld); // eslint-disable-line @typescript-eslint/no-explicit-any
    const N = normalize(
      T.mul(tsNormal.x).add(B.mul(tsNormal.y)).add(N_geom.mul(tsNormal.z)),
    );

    const NdotL = dot(N, sunDir);
    const diffuse = clamp(NdotL, 0, 1);

    const viewDir = normalize(sub(cameraPosition, positionWorld));
    const halfVec = normalize(sunDir.add(viewDir));
    const NdotH = dot(N, halfVec).max(0);
    const surge = pow(NdotH, float(3.0)).mul(0.12).mul(diffuse);

    const earthshine = float(0.002);
    const earthshineColor = vec3(0.55, 0.65, 1.0);
    const darkSideMask = clamp(NdotL.negate().mul(2.0), 0, 1);
    const darkColor = albedo
      .mul(earthshine)
      .mul(earthshineColor)
      .mul(darkSideMask);

    const col = albedo.mul(diffuse.add(surge)).add(darkColor);
    return vec4(col, 1.0);
  })();
}

function buildLunaPositionNode(
  dispTex: THREE.Texture,
  displacementScaled: number,
) {
  const uDisp = float(displacementScaled);
  return Fn(() => {
    const d = texture(dispTex, uv()).r;
    return positionLocal.add(normalLocal.mul(d.mul(uDisp)));
  })();
}

// ─────────────────────────────────────────────────────────────────────

export const lunaConfig: CelestialBodyConfig = {
  id: "luna",
  positionKm: LUNA_POSITION_KM,
  radiusKm: LUNA_RADIUS_KM,

  billboardMode: "world-space",

  lod: { near: 40_000, far: 250_000 },
  near: {
    textures: {
      color: "/textures/luna/luna_color_8k.ktx2",
      displacement: "/textures/luna/luna_displacement_16.ktx2",
    },
    segments: 128,
    computeTangents: true,
  },
  mid: {
    textures: {
      color: "/textures/luna/luna_color_2k.ktx2",
      displacement: "/textures/luna/luna_displacement_4.ktx2",
    },
    segments: 48,
    computeTangents: true,
  },
  far: { albedo: LUNA_ALBEDO },
  stellarPoint: { geometricAlbedo: 0.136, color: [0.85, 0.82, 0.78] },

  buildFragmentNode: ({ textures, uSunRel, tier }) => {
    const bumpStrength = tier === "near" ? 0.8 : 0.6;
    const texelSize = tier === "near" ? 1 / 4096 : 1 / 1024;
    return buildLunaFragmentNode(textures.color, textures.displacement, bumpStrength, texelSize, uSunRel);
  },

  buildPositionNode: ({ textures }) => {
    const displacementScaled = kmToScaledUnits(DISPLACEMENT_SCALE_KM);
    return buildLunaPositionNode(textures.displacement, displacementScaled);
  },
};
