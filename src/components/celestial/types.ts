import type * as THREE from "three";
import type { WorldOriginContextValue } from "@/sim/worldOrigin";

export type Vec3Tuple = [number, number, number];

// Physically-based atmosphere parameters (see docs/ATMOSPHERE_PLAN.md §3).
// Per-RGB scattering/absorption coefficients in m^-1; density via exponential
// scale heights (Rayleigh, Mie) + a tent layer (ozone). Presets + procedural
// derivation live in bodies/atmosphereData.ts. Optional on CelestialBodyConfig:
// bodies without it render airless (no atmosphere pass contribution).
export type AtmosphereParams = {
  groundRadiusKm: number;
  atmosphereHeightKm: number;
  rayleighScattering: Vec3Tuple;
  rayleighScaleHeightKm: number;
  // Per-RGB Mie (Phase 5): coloured aerosols — e.g. Mars dust absorbs blue
  // (butterscotch sky, blue sunset). Earth's aerosol is spectrally flat.
  mieScattering: Vec3Tuple;
  mieAbsorption: Vec3Tuple;
  mieScaleHeightKm: number;
  /**
   * Per-RGB phase anisotropy. Wavelength-dependent forward peaking is the
   * physical mechanism behind Mars' BLUE sunset glow: ~1.5 µm dust diffracts
   * blue into a tighter forward lobe (g_blue > g_red), so blue concentrates
   * around the sun while the rest of the sky stays butterscotch.
   */
  mieG: Vec3Tuple;
  ozoneAbsorption: Vec3Tuple;
  ozoneCenterKm: number;
  ozoneWidthKm: number;
  /**
   * Well-mixed molecular absorption on the RAYLEIGH density profile (m^-1,
   * per-RGB) — Frostbite's "absorber on the Rayleigh exp profile" channel.
   * CH4's red absorption (teal/blue ice giants) lands here; [0,0,0] = none.
   */
  gasAbsorption: Vec3Tuple;
  groundAlbedo: Vec3Tuple;
  /** Top-of-atmosphere sun illuminance in the unified luminance scale. */
  sunIlluminance: Vec3Tuple;
};

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

/**
 * Analytic ring annulus for the atmosphere pass (Phase 5 ring coupling). The
 * plane passes through the planet centre, lies in the body's local XZ (i.e.
 * normal = local +Y, rotated by config.rotation), matching the ring mesh in
 * extraMeshes. `opacity` is the ring's MEAN opacity — used both to clamp the
 * atmosphere fog on near-side ring pixels and to shadow the atmosphere's
 * in-scatter under the rings. (A radial alpha-profile LUT can replace the
 * constant later for gap detail like the Cassini division.)
 */
export type AtmosphereRingsDef = {
  innerRadiusKm: number;
  outerRadiusKm: number;
  opacity: number;
};

export type CelestialBodyConfig = {
  id: string;
  positionKm: Vec3Tuple;
  sunPositionKm?: Vec3Tuple;
  radiusKm: number;
  rotation?: THREE.Euler;

  // Physically-based atmosphere (docs/ATMOSPHERE_PLAN.md). Optional — bodies
  // without it are airless. Not yet read in Phase 0 (atmosphere pass is a
  // passthrough); Phase 1 consumes it for the scattering raymarch.
  atmosphere?: AtmosphereParams;
  // Ring annulus coupled into the atmosphere pass (fog clamp + sun shadow).
  // Only meaningful alongside `atmosphere` on a ringed body (Saturn).
  rings?: AtmosphereRingsDef;

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
