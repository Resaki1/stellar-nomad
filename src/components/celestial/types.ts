import type * as THREE from "three";
import type { WorldOriginContextValue } from "@/sim/worldOrigin";

export type Vec3Tuple = [number, number, number];

export type LODTier = {
  textures: Record<string, string>;
  segments: number;
  computeTangents?: boolean;
};

export type FarBillboardConfig = {
  albedo: THREE.Color;
  sizeMultiplier?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildFragment?: (ctx: { albedo: THREE.Color; uSpR: any; uSpU: any; uSpF: any }) => any;
};

export type StellarPointConfig = {
  geometricAlbedo: number;
  color: readonly [number, number, number];
};

export type ExtraMeshDef = {
  key: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  tier: "near" | "mid";
};

export type FragmentNodeContext = {
  textures: Record<string, THREE.Texture>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uniforms: Record<string, any>;
  tier: "near" | "mid";
};

export type OnFrameContext = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uniforms: Record<string, any>;
  worldOrigin: WorldOriginContextValue;
  camera: THREE.Camera;
  positionKm: Vec3Tuple;
  sunPositionKm: Vec3Tuple;
  distKm: number;
};

export type ExtraMeshContext = {
  scaledRadius: number;
  textures: Record<string, THREE.Texture>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunRel: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uniforms: Record<string, any>;
  tier: "near" | "mid";
};

export type CelestialBodyConfig = {
  id: string;
  positionKm: Vec3Tuple;
  sunPositionKm?: Vec3Tuple;
  radiusKm: number;
  rotation?: THREE.Euler;

  lod: { near?: number; far: number };
  near?: LODTier;
  mid: LODTier;
  far: FarBillboardConfig;
  stellarPoint: StellarPointConfig;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildFragmentNode: (ctx: FragmentNodeContext) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildPositionNode?: (ctx: FragmentNodeContext) => any;

  extraMeshes?: (ctx: ExtraMeshContext) => ExtraMeshDef[];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createUniforms?: () => Record<string, any>;
  onFrame?: (ctx: OnFrameContext) => void;

  billboardMode?: "camera-space" | "world-space";
  onTexturesLoaded?: (tier: "near" | "mid", textures: Record<string, THREE.Texture>) => void;
};
