"use client";

import { memo, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  uniform,
  texture,
  uv,
  normalWorld,
  positionWorld,
  positionLocal,
  normalLocal,
  vec3,
  vec4,
  float,
  dot,
  normalize,
  clamp,
  pow,
  sub,
  cameraPosition,
} from "three/tsl";
import SimGroup from "../space/SimGroup";
import { kmToScaledUnits, toScaledUnitsKm } from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";
import {
  STAR_POSITION_KM,
  LUNA_POSITION_KM,
  LUNA_RADIUS_KM,
} from "@/sim/celestialConstants";

export { LUNA_POSITION_KM, LUNA_RADIUS_KM };

const LUNA_ROTATION = new THREE.Euler(0, 0, 0);

// ── Displacement settings ──
const DISPLACEMENT_SCALE_KM = 10.786; // ~10.8 km peak-to-valley (real lunar range)

// ── Reusable vectors (no per-frame allocs) ──
const _sunScaled = new THREE.Vector3();
const _lunaScaled = new THREE.Vector3();
const _sunRelative = new THREE.Vector3();
const _relativeKm = new THREE.Vector3();

type LunaProps = {
  positionKm?: [number, number, number];
  sunPositionKm?: [number, number, number];
  radiusKm?: number;
};

function Luna({
  positionKm = LUNA_POSITION_KM,
  sunPositionKm = STAR_POSITION_KM,
  radiusKm = LUNA_RADIUS_KM,
}: LunaProps) {
  const worldOrigin = useWorldOrigin();

  const scaledRadius = useMemo(() => kmToScaledUnits(radiusKm), [radiusKm]);
  const displacementScaled = useMemo(
    () => kmToScaledUnits(DISPLACEMENT_SCALE_KM),
    []
  );

  const tex = useTexture({
    color: "/textures/luna/luna_color_2k.webp",
    displacement: "/textures/luna/luna_displacement_8bit.webp",
  }) as Record<string, THREE.Texture>;

  useMemo(() => {
    // Color map is sRGB
    tex.color.colorSpace = THREE.SRGBColorSpace;
    tex.color.needsUpdate = true;
    // Displacement is linear data
    tex.displacement.colorSpace = THREE.NoColorSpace;
    tex.displacement.needsUpdate = true;
  }, [tex]);

  // Sphere geometry — 96 segments is enough for the moon at typical viewing distances
  const sphereGeo = useMemo(() => {
    const geo = new THREE.SphereGeometry(scaledRadius, 96, 96);
    return geo;
  }, [scaledRadius]);

  // Sun direction uniform (relative to luna, in scaled units)
  const uSunRel = useMemo(() => uniform(new THREE.Vector3(0, 0, 1)), []);

  // ── TSL Node Material ──
  const lunaMat = useMemo(() => {
    const mat = new NodeMaterial();
    mat.side = THREE.FrontSide;

    // Vertex displacement from heightmap
    const uDisplacementScale = float(displacementScaled);
    mat.positionNode = Fn(() => {
      const dispSample = texture(tex.displacement, uv()).r;
      const displaced = positionLocal.add(
        normalLocal.mul(dispSample.mul(uDisplacementScale))
      );
      return displaced;
    })();

    // Fragment: diffuse lighting with subtle backscatter
    mat.fragmentNode = Fn(() => {
      const uvCoord = uv();
      const sunDir = normalize(uSunRel);

      const albedo = texture(tex.color, uvCoord).rgb;

      // Geometric normal in world space
      const N = normalize(normalWorld);
      const NdotL = dot(N, sunDir);

      // ── Lambertian diffuse — sharp cutoff like the real Moon ──
      // No wrap: the Moon has no atmosphere, so the terminator is hard.
      // Clamp to zero; negative = shadow.
      const diffuse = clamp(NdotL, 0, 1);

      // ── Opposition surge (Hapke backscatter) ──
      // The Moon brightens near full phase (shadow hiding + coherent
      // backscatter). Only applies on the lit side.
      const viewDir = normalize(sub(cameraPosition, positionWorld));
      const halfVec = normalize(sunDir.add(viewDir));
      const NdotH = dot(N, halfVec).max(0);
      const surge = pow(NdotH, float(3.0)).mul(0.12).mul(diffuse);

      // ── Earthshine ──
      // Extremely faint — only perceptible when adapted to darkness,
      // essentially invisible in a game scene with the lit side nearby.
      const earthshine = float(0.002);
      const earthshineColor = vec3(0.55, 0.65, 1.0);
      const darkSideMask = clamp(NdotL.negate().mul(2.0), 0, 1);
      const darkColor = albedo.mul(earthshine).mul(earthshineColor).mul(darkSideMask);

      // Combine: lit contribution + earthshine on dark side only
      const col = albedo.mul(diffuse.add(surge)).add(darkColor);

      return vec4(col, 1.0);
    })();

    return mat;
  }, [tex, uSunRel, displacementScaled]);

  useFrame(() => {
    // Compute sun direction relative to Luna in scaled space
    _relativeKm.set(positionKm[0], positionKm[1], positionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _lunaScaled);

    _relativeKm.set(sunPositionKm[0], sunPositionKm[1], sunPositionKm[2]);
    _relativeKm.sub(worldOrigin.worldOriginKm);
    toScaledUnitsKm(_relativeKm, _sunScaled);

    _sunRelative.copy(_sunScaled).sub(_lunaScaled);
    uSunRel.value.copy(_sunRelative);
  });

  return (
    <SimGroup space="scaled" positionKm={positionKm}>
      <group rotation={LUNA_ROTATION}>
        <mesh geometry={sphereGeo} material={lunaMat} />
      </group>
    </SimGroup>
  );
}

useTexture.preload("/textures/luna/luna_color_2k.webp");
useTexture.preload("/textures/luna/luna_displacement_8bit.webp");

export default memo(Luna);
