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
  /**
   * Surface refractivity `n − 1` of the gas mixture at this body's own surface
   * density, dimensionless. ~2.77e-4 for Earth air.
   *
   * 🔑 The ONE quantity the rest of `AtmosphereParams` cannot supply, and the
   * only thing needed to turn this atmosphere into a LENS. `refractedLimbLight.ts`
   * uses it for defect D28 — sunlight bent through the limb into the umbra, i.e.
   * why a totally eclipsed Moon is coppery instead of invisible.
   *
   * ⚠ Derived, not authored: refractivity is linear in number density and
   * `rayleighRel` is DEFINED as `((n−1)_g/(n−1)_air)²·(F_g/F_air)`, so
   * `(n−1) = (n−1)_air · nRel · √rayleighRel` — see `deriveAtmosphere`. Both
   * factors are already computed there for the Rayleigh coefficient; this reuses
   * them rather than adding a table.
   */
  surfaceRefractivity: number;
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
  /**
   * Star luminosity in solar units. Static per system; feeds the PER-FRAME sun
   * illuminance derivation — see `sunIlluminanceAt()` in space/photometry.ts.
   *
   * NOTE there is deliberately no `sunIlluminance` field here any more. It is a
   * function of the body's LIVE distance to its star, so baking it into these
   * static params froze Mercury and Neptune at identical brightness (defect D17
   * in docs/LIGHTING_PLAN.md). The live value lives on `AtmosphereBodyRecord`,
   * recomputed every frame in `setAtmosphereBody()`.
   */
  starLuminositySun: number;
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
  /**
   * Top-of-atmosphere sun ILLUMINANCE at this body, game units, as a vec3
   * uniform. Recomputed every frame from the body's live distance to its star,
   * so it is automatically correct under orbital motion and for procedurally
   * generated systems (docs/LIGHTING_PLAN.md §3.0).
   *
   * ⚠ EVERY surface fragment MUST scale its albedo by `uSunIlluminance / π` to
   * produce radiance. The `1/π` is the Lambertian BRDF normalisation. Omitting
   * the whole factor was defect D02/D03b — a 6.37× error at Earth's orbit and a
   * measured 12.9× on Neptune, because a body's brightness then ignored how far
   * from the star it actually is. Use the `surfaceRadiance()` helper.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunIlluminance: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uniforms: Record<string, any>;
  /**
   * Shared body-on-body eclipse uniforms (defect D34), owned by
   * `CelestialBody`. Pass to `eclipseVisibilityNode()` for per-pixel star-disc
   * visibility.
   *
   * ⚠ Only bodies with `ownEclipse: true` should read this — every other body
   * gets the multiply applied for it by `CelestialBody`'s fragment wrapper, and
   * doing both would SQUARE the shadow.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eclipseU: any;
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
  /** Per-frame sun illuminance at this body, game units — see FragmentNodeContext. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uSunIlluminance: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uniforms: Record<string, any>;
  /**
   * Shared eclipse uniforms (D34). ⚠ Extra meshes are NOT wrapped by
   * `CelestialBody`'s fragment wrapper, so a mesh that wants eclipse coverage —
   * the cloud shell, a ring — must apply `eclipseVisibilityNode()` itself.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eclipseU: any;
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

  /**
   * Set when the body's OWN fragment shader already applies eclipse coverage
   * (defect D34). `CelestialBody` then skips its generic per-pixel multiply for
   * this body, so the shadow is not applied twice.
   *
   * ⚠ Only `earth.ts` sets this today, and for a reason worth keeping: Earth
   * threads coverage through `sunVis`, which also switches city lights on inside
   * a total eclipse and gates the ocean specular and terminator band. A flat
   * multiply cannot do that, so Earth keeps its richer path and consumes the
   * same shared occluder uniforms.
   */
  ownEclipse?: boolean;

  billboardMode?: "camera-space" | "world-space";
  onTexturesLoaded?: (tier: "near" | "mid", textures: Record<string, THREE.Texture>) => void;
};
