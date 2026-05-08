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
  // Optional Three.js layer to route this mesh through a separate render pass
  // (e.g. cloud shell rendered at half-res — see src/components/space/renderLayers.ts).
  renderLayer?: number;
  // Fired by the React ref callback when the mesh mounts (with the mesh) or
  // unmounts (with null). Lets a body-specific module register the mesh as a
  // matrixWorld provider for off-scene-graph passes (e.g. the fullscreen-quad
  // cloud ray-march needs Earth's world transform but renders in its own scene).
  onMount?: (mesh: THREE.Mesh | null) => void;
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
