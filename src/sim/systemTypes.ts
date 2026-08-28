export type UnitsSpec = {
  distance: "km";
  radius: "m";
  angle: "deg" | "rad";
};

export type StreamingConfig = {
  chunkSizeKm: number;
  loadRadiusKm: number;
  unloadRadiusKm: number;
  maxActiveChunks?: number;
};

export type RenderConfig = {
  drawRadiusKm?: number;
  fadeKm?: { start: number; end: number };
  /** Full-geometry render range (km). Defaults to drawRadiusKm when unset. */
  nearRadiusKm?: number;
  /** Simplified LOD1 geometry render range (km). 0 = disabled. */
  midRadiusKm?: number;
  /** Billboard impostor render range (km). 0 = disabled. */
  farRadiusKm?: number;
  /** Width of the LOD cross-fade zone at the near/far boundary (km). */
  crossFadeKm?: number;
};

export type GenerationConfig = {
  maxAsteroidsPerChunk?: number;
};

export type SystemDefaults = {
  streaming?: Partial<StreamingConfig>;
  render?: Partial<RenderConfig>;
  generation?: Partial<GenerationConfig>;
};

export type AsteroidModelDef = {
  id: string;
  src: string;
  /** Simplified LOD1 model source. If omitted, mid tier is skipped for this model. */
  lod1Src?: string;
  /** Mesh name for the LOD1 model. Falls back to first mesh if omitted. */
  lod1MeshName?: string;
  /**
   * Name of the mesh inside the GLB to instance. If omitted, the first Mesh
   * found in the scene will be used.
   */
  meshName?: string;
  /**
   * Applied as a transform on the InstancedMesh itself (i.e., affects all instances).
   * Use this to correct authoring scale differences between assets.
   */
  baseScale?: number;
  /**
   * Applied as a transform on the InstancedMesh itself (i.e., affects all instances).
   * Useful for aligning axis conventions between assets.
   */
  baseRotationDeg?: [number, number, number];
};

export type WeightedModelRef = {
  modelId: string;
  weight: number;
};

export type ResourceTypeDef = {
  id: string;
  name: string;
  /** Optional unit label (e.g. "kg", "t"). */
  unit?: string;
  /** Optional icon URL for HUD (e.g. "/assets/resources/silicates.png"). */
  icon?: string;
  /**
   * Optional cargo units per 1 unit of this resource.
   * Defaults to 1 if omitted.
   */
  cargoUnitsPerUnit?: number;
};

export type WeightedResourceRef = {
  resourceId: string;
  weight: number;
};

// ---------------------------------------------------------------------------
// Asteroid-class / multi-resource types
// ---------------------------------------------------------------------------

/** Min/max fraction (0–1) for a single resource within an asteroid class. */
export type ResourceRange = {
  resourceId: string;
  /** Minimum fraction (0–1). */
  min: number;
  /** Maximum fraction (0–1). */
  max: number;
};

/**
 * Defines one asteroid spectral class (e.g. S-Type, C-Type, X-Type).
 * Each class has a selection weight and a set of resource ranges.
 */
export type AsteroidClassDef = {
  id: string;
  name: string;
  /** Selection weight (higher = more common). */
  weight: number;
  /** Per-resource composition ranges. Rolled independently then normalised. */
  resources: ResourceRange[];
};

export type SystemResources = {
  /** Declares which resource IDs exist in this system. */
  types: ResourceTypeDef[];
  /**
   * @deprecated Replaced by AsteroidResourcesDef.classes
   */
  defaultDistribution?: WeightedResourceRef[];
};

export type BoxShape = {
  type: "box";
  halfExtentsKm: [number, number, number];
  rotationDeg?: [number, number, number];
  /** Width (km) of the density falloff zone at the edge. 0 = hard cutoff. */
  edgeFalloffKm?: number;
};

export type SphereShape = {
  type: "sphere";
  radiusKm: number;
  /** Width (km) of the density falloff zone at the edge. 0 = hard cutoff. */
  edgeFalloffKm?: number;
};

export type FieldShape = BoxShape | SphereShape;

export type DensityPopulation = {
  mode: "density";
  densityPerKm3: number;
  /**
   * 0..1 range. 0 means no variation. 0.25 means ±25% variation in count per chunk.
   */
  jitter?: number;
  /**
   * Hard cap per-chunk (field-level).
   */
  maxPerChunk?: number;
};

export type CountPopulation = {
  mode: "count";
  /**
   * Phase 1 interpretation: approximate count per chunk.
   * (If you later want “count for the entire field volume,” we can introduce
   * a new mode that uses field volume estimation.)
   */
  approxCount: number;
  maxPerChunk?: number;
};

export type PopulationDef = DensityPopulation | CountPopulation;

export type SizeDistribution = "uniform" | "logNormal" | "powerLaw";

export type SizeDef = {
  minRadiusM: number;
  maxRadiusM: number;
  distribution: SizeDistribution;
  params?: Record<string, number>;
};

/**
 * Optional POI marker display config. Attached to any game object that
 * generates a POI (asteroid fields, planets, stations, etc.).
 * When omitted, the POI system applies per-type defaults.
 */
export type POIMarkerConfig = {
  /** Hide marker when closer than this (km). Default varies by type. */
  minDistanceKm?: number;
  /** Hide marker when farther than this (km). Default varies by type. */
  maxDistanceKm?: number;
};

/**
 * Gas species understood by the atmosphere derivation
 * (src/components/celestial/bodies/atmosphereData.ts — per-gas Rayleigh
 * cross-sections, molar masses, and molecular absorption live there).
 */
export type AtmosphereGasId =
  | "n2"
  | "o2"
  | "co2"
  | "ar"
  | "ch4"
  | "h2"
  | "he"
  | "h2o"
  | "so2";

/**
 * High-level physical description of a body's atmosphere. Everything the
 * renderer needs (Rayleigh/Mie coefficients, scale heights, ozone, sun
 * illuminance) is DERIVED from this + the body's mass/radius + the star —
 * see deriveAtmosphere() in atmosphereData.ts. Only aerosol properties
 * (haze*) are art-directed knobs: dust/cloud load isn't derivable from
 * bulk physics.
 *
 * For gas giants there is no surface; by convention `radiusKm` is the 1-bar
 * level, so use surfacePressureBar: 1 with the temperature at that level.
 */
export type AtmosphereDef = {
  /** Pressure at the reference surface (bar). Earth ≈ 1.013, Mars ≈ 0.006, Venus ≈ 92. */
  surfacePressureBar: number;
  /** Temperature at the reference surface (K). Sets the density scale height. */
  surfaceTemperatureK: number;
  /** Mole fractions per gas (need not sum to 1 — normalised on read). */
  composition: Partial<Record<AtmosphereGasId, number>>;
  /** Aerosol load relative to Earth's clear-sky baseline (1 = Earth haze). Default 1. */
  haze?: number;
  /** Aerosol single-scatter tint (RGB on Mie scattering). Default white. */
  hazeTint?: [number, number, number];
  /** Aerosol absorption tint (RGB on Mie absorption) — e.g. Mars dust absorbs blue. Default white. */
  hazeAbsorptionTint?: [number, number, number];
  /** Aerosol density scale height (km). Default 0.15 × Rayleigh scale height (Earth → 1.2). */
  hazeScaleHeightKm?: number;
  /**
   * Mie phase anisotropy — scalar, or per-RGB for wavelength-dependent forward
   * peaking (Mars dust: g_blue > g_red → the blue sunset glow around the sun).
   * Default 0.8.
   */
  mieG?: number | [number, number, number];
  /** Mean surface albedo for multi-scatter ground bounce. Default [0.3, 0.3, 0.3]. */
  groundAlbedo?: [number, number, number];
};

/**
 * A body's orbit about its `parent` (or about the system primary when there is
 * none). See `sim/ephemeris.ts` for the frame and the accuracy story.
 *
 * 🔑 THE UNIVERSAL FORM IS KEPLERIAN, on purpose: a procedurally generated
 * system emits these six numbers and gets correct motion with no special
 * casing. `model` opts a body into a higher-accuracy series where real data
 * exists — which is exactly the two-layer split LIGHTING_PLAN §3.0 asks for
 * ("no per-system fine-tuning").
 */
export type OrbitDef = {
  /**
   * Which model computes this body's position.
   * • omitted — generic Keplerian from the elements below.
   * • `"jpl"` — JPL's approximate-positions table (elements + per-century
   *   rates), keyed by the body's `id`. Sol's eight planets only.
   * • `"meeus-moon"` — abridged ELP2000-82B. ⚠ Required for Luna: pure Kepler
   *   is >1° off and the solar umbra is ~0.5° wide, so two-body elements do not
   *   misplace a solar eclipse, they MISS it.
   */
  model?: "jpl" | "meeus-moon";
  /** Semi-major axis, km. Ignored by the named models. */
  aKm: number;
  /** Orbital period, days. Drives the mean motion for the generic path. */
  periodDays: number;
  e?: number;
  /** Inclination to the ecliptic, degrees. */
  iDeg?: number;
  /** Longitude of the ascending node, degrees. */
  nodeDeg?: number;
  /** Longitude of periapsis (ϖ = Ω + ω), degrees. */
  periDeg?: number;
  /** Mean anomaly at `epochJD`, degrees. */
  meanAnomalyAtEpochDeg?: number;
  /** Epoch for `meanAnomalyAtEpochDeg`. Defaults to J2000. */
  epochJD?: number;
};

/** A body's spin. See `bodyOrientation()`. */
export type RotationDef = {
  /**
   * Sidereal rotation period, hours. ⚠ SIDEREAL, not solar — Earth is
   * 23.9344696 h, not 24. Using 24 drifts a full turn per year.
   */
  periodHours?: number;
  /** Explicit spin rate, deg/day (IAU `Ẇ`). Overrides `periodHours`. */
  spinDegPerDay?: number;
  /**
   * Prime-meridian angle at J2000, degrees (IAU `W₀`).
   *
   * ⚠ Measured from the IAU node `Q` at right ascension `α₀ + 90°`, so it is
   * only meaningful alongside `poleRaDeg`/`poleDecDeg`. On the tilt-only
   * fallback path it lands on a different origin — see `bodyOrientation`.
   */
  primeMeridianDeg?: number;
  /**
   * IAU pole right ascension α₀, degrees, equatorial J2000.
   *
   * 🔑 THE PREFERRED WAY TO ORIENT A BODY. `(α₀, δ₀, W₀, Ẇ)` is the one
   * unambiguous published quadruple, and it is what the WGCCRE report gives for
   * every solar-system body. Earth's is definitional: the ICRF *is* the mean
   * equator of J2000, so `α₀ = 0, δ₀ = 90`.
   */
  poleRaDeg?: number;
  /** IAU pole declination δ₀, degrees, equatorial J2000. Pairs with `poleRaDeg`. */
  poleDecDeg?: number;
  /**
   * Axial tilt from the ecliptic pole, degrees.
   *
   * ⚠ SUPERSEDED by `poleRaDeg`/`poleDecDeg` when those are present (the tilt is
   * then DERIVED from the pole). Kept as the fallback for a body described only
   * by a tilt, such as a procedurally generated one.
   */
  tiltDeg?: number;
  /**
   * Ecliptic longitude of the ascending node of the body's equator, degrees.
   *
   * ⚠⚠ MEASURED NOT RELIABLY CONVERTIBLE to an IAU pole: Earth's authored 0° is
   * the ASCENDING node while Mars's 82.9° is the DESCENDING one, so no single
   * sign recovers both. Prefer `poleRaDeg`/`poleDecDeg`.
   */
  tiltNodeDeg?: number;
};

export type CelestialBodyDef = {
  id: string;
  name: string;
  type: "star" | "planet" | "moon";
  /** Position in km (system coordinates). */
  positionKm: [number, number, number];
  /** Radius in km. */
  radiusKm: number;
  /** Optional parent body ID (e.g. moon orbiting a planet). */
  parent?: string;
  /**
   * Orbital elements. ⚠ When present, `positionKm` becomes a FALLBACK only —
   * `sim/ephemeris.ts` computes the live position from these instead.
   */
  orbit?: OrbitDef;
  /** Spin. Omit for a body whose orientation does not matter yet. */
  rotation?: RotationDef;
  marker?: POIMarkerConfig;
  /** Body mass (kg) — surface gravity, scale heights. Required for `atmosphere`. */
  massKg?: number;
  /** Star luminosity in solar units (stars only) — drives planet sun illuminance. */
  luminositySun?: number;
  /** Physical atmosphere description; omit for airless bodies. */
  atmosphere?: AtmosphereDef;
};

export type AsteroidFieldDef = {
  id: string;
  name: string;
  seed: number | string;
  enabled?: boolean;
  frame?: "system";
  /**
   * The field's absolute centre, km.
   *
   * ⚠⚠ DERIVED, NOT AUTHORED, when `anchorBody` is set: the ephemeris rewrites
   * this in place every frame from `anchorBody` + `anchorOffsetKm`. Authoring an
   * absolute anchor made the fields stay put while their planet orbited away —
   * the belt meant to sit 15,800 km from Earth ended up 380,000 km from it.
   */
  anchorKm: [number, number, number];
  /**
   * Body this field orbits with. When set, `anchorKm` is recomputed each frame
   * as `body.positionKm + anchorOffsetKm`, so the field travels with its planet.
   */
  anchorBody?: string;
  /** Fixed offset from `anchorBody`'s centre, km. Requires `anchorBody`. */
  anchorOffsetKm?: [number, number, number];
  shape: FieldShape;
  population: PopulationDef;
  size: SizeDef;
  models?: WeightedModelRef[];
  streaming?: Partial<StreamingConfig>;
  render?: Partial<RenderConfig>;
  tags?: string[];
  resources?: AsteroidResourcesDef;
  marker?: POIMarkerConfig;
};

export type SystemAssets = {
  asteroidModels?: AsteroidModelDef[];
};

export type SystemConfigV1 = {
  schemaVersion: 1;
  systemId: string;
  units: UnitsSpec;
  /**
   * Default spawn position for new players (km).
   *
   * ⚠ LIVE: rewritten in place by `updateEphemerisPositions()` when
   * `startingBody`/`startingOffsetKm` are set, so the spawn follows its planet
   * instead of being an absolute point the planet has since orbited away from.
   */
  startingPositionKm: [number, number, number];
  /** Body the spawn point is fixed relative to. Without it the spawn is absolute. */
  startingBody?: string;
  /** Fixed offset from `startingBody`'s centre (km) — the authored spawn geometry. */
  startingOffsetKm?: [number, number, number];
  /** Default spawn rotation for new players (quaternion [x, y, z, w]). */
  startingRotationQuat: [number, number, number, number];
  resources?: SystemResources;
  defaults?: SystemDefaults;
  assets?: SystemAssets;
  celestialBodies?: CelestialBodyDef[];
  asteroidFields: AsteroidFieldDef[];
};

export type SystemConfig = SystemConfigV1;

export type ResolvedStreamingConfig = Required<
  Omit<StreamingConfig, "maxActiveChunks">
> & {
  maxActiveChunks: number;
};

export type ResolvedRenderConfig = {
  /** Max visible range (= max of nearRadiusKm, midRadiusKm, farRadiusKm). Used for streaming. */
  drawRadiusKm: number;
  /** Full-geometry render cutoff. */
  nearRadiusKm: number;
  /** Simplified LOD1 geometry cutoff. 0 = disabled. */
  midRadiusKm: number;
  /** Billboard impostor render cutoff. 0 = disabled. */
  farRadiusKm: number;
  /** LOD cross-fade width. */
  crossFadeKm: number;
  fadeKm?: { start: number; end: number };
};

export type ResolvedGenerationConfig = {
  maxAsteroidsPerChunk: number;
};

export type ResourceYieldDef = {
  referenceRadiusM: number;
  baseAmount: number;
  exponent: number;
  variance?: number;
  minAmount?: number;
  maxAmount?: number;
};

export type AsteroidResourcesDef = {
  seedSalt?: number | string;
  /** Asteroid spectral classes with per-class resource composition ranges. */
  classes: AsteroidClassDef[];
  /** @deprecated Legacy single-resource distribution. Ignored when classes is set. */
  distribution?: WeightedResourceRef[];
  yield: ResourceYieldDef;
};


export const DEFAULT_STREAMING: ResolvedStreamingConfig = {
  chunkSizeKm: 5,
  loadRadiusKm: 15,
  unloadRadiusKm: 20,
  maxActiveChunks: 1200,
};

export const DEFAULT_RENDER: ResolvedRenderConfig = {
  drawRadiusKm: 10,
  nearRadiusKm: 10,
  midRadiusKm: 0,
  farRadiusKm: 0,
  crossFadeKm: 0,
};

export const DEFAULT_GENERATION: ResolvedGenerationConfig = {
  maxAsteroidsPerChunk: 250,
};

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampMin(value: number, min: number): number {
  return value < min ? min : value;
}

const FALLBACK_ASTEROID_MODEL_DEFS: AsteroidModelDef[] = [
  {
    id: "asteroid_01",
    src: "/models/asteroids/asteroid01.glb",
    meshName: "Daphne_LP001_1_0",
    baseScale: 0.125,
    baseRotationDeg: [-90, 0, 0],
  },
];

export function getSystemAsteroidModelDefs(
  system: SystemConfig
): AsteroidModelDef[] {
  const defs = system.assets?.asteroidModels ?? [];
  if (defs.length > 0) return defs;

   
  console.warn(
    "[systemTypes] system.assets.asteroidModels is empty/missing — using fallback.",
    { hasAssets: !!system.assets, assets: system.assets }
  );

  return FALLBACK_ASTEROID_MODEL_DEFS;
}

export function resolveFieldRender(
  system: SystemConfig,
  field: AsteroidFieldDef
): ResolvedRenderConfig {
  const sysRender = system.defaults?.render ?? {};
  const fieldRender = field.render ?? {};

  // Legacy drawRadiusKm used as fallback for nearRadiusKm.
  const rawDrawRadius = asFiniteNumber(
    fieldRender.drawRadiusKm,
    asFiniteNumber(sysRender.drawRadiusKm, DEFAULT_RENDER.drawRadiusKm)
  );

  const nearRadiusKm = clampMin(
    asFiniteNumber(
      fieldRender.nearRadiusKm,
      asFiniteNumber(sysRender.nearRadiusKm, rawDrawRadius)
    ),
    0.001
  );

  const midRadiusKm = clampMin(
    asFiniteNumber(
      fieldRender.midRadiusKm,
      asFiniteNumber(sysRender.midRadiusKm, DEFAULT_RENDER.midRadiusKm)
    ),
    0
  );

  const farRadiusKm = clampMin(
    asFiniteNumber(
      fieldRender.farRadiusKm,
      asFiniteNumber(sysRender.farRadiusKm, DEFAULT_RENDER.farRadiusKm)
    ),
    0
  );

  const crossFadeKm = clampMin(
    asFiniteNumber(
      fieldRender.crossFadeKm,
      asFiniteNumber(sysRender.crossFadeKm, DEFAULT_RENDER.crossFadeKm)
    ),
    0
  );

  // drawRadiusKm drives streaming — must cover the full visible range.
  const drawRadiusKm = clampMin(
    Math.max(nearRadiusKm, midRadiusKm, farRadiusKm),
    0.001
  );

  const fadeKm = fieldRender.fadeKm ?? sysRender.fadeKm;

  return { drawRadiusKm, nearRadiusKm, midRadiusKm, farRadiusKm, crossFadeKm, fadeKm };
}

export function resolveFieldStreaming(
  system: SystemConfig,
  field: AsteroidFieldDef,
  drawRadiusKm: number
): ResolvedStreamingConfig {
  const sysStreaming = system.defaults?.streaming ?? {};
  const fieldStreaming = field.streaming ?? {};

  const chunkSizeKm = clampMin(
    asFiniteNumber(
      fieldStreaming.chunkSizeKm,
      asFiniteNumber(sysStreaming.chunkSizeKm, DEFAULT_STREAMING.chunkSizeKm)
    ),
    0.001
  );

  // If not provided, prefer a sensible derived default based on drawRadius + one chunk ring.
  const derivedLoadRadius = Math.max(
    drawRadiusKm + chunkSizeKm,
    DEFAULT_STREAMING.loadRadiusKm
  );
  const loadRadiusKm = clampMin(
    asFiniteNumber(
      fieldStreaming.loadRadiusKm,
      asFiniteNumber(sysStreaming.loadRadiusKm, derivedLoadRadius)
    ),
    drawRadiusKm
  );

  const derivedUnloadRadius = Math.max(
    loadRadiusKm + chunkSizeKm,
    DEFAULT_STREAMING.unloadRadiusKm
  );
  const unloadRadiusKm = clampMin(
    asFiniteNumber(
      fieldStreaming.unloadRadiusKm,
      asFiniteNumber(sysStreaming.unloadRadiusKm, derivedUnloadRadius)
    ),
    loadRadiusKm
  );

  const maxActiveChunks = Math.floor(
    clampMin(
      asFiniteNumber(
        fieldStreaming.maxActiveChunks,
        asFiniteNumber(
          sysStreaming.maxActiveChunks,
          DEFAULT_STREAMING.maxActiveChunks
        )
      ),
      1
    )
  );

  return { chunkSizeKm, loadRadiusKm, unloadRadiusKm, maxActiveChunks };
}

export function resolveFieldGeneration(
  system: SystemConfig,
  field: AsteroidFieldDef
): ResolvedGenerationConfig {
  const sysGen = system.defaults?.generation ?? {};

  const sysMax = asFiniteNumber(
    sysGen.maxAsteroidsPerChunk,
    DEFAULT_GENERATION.maxAsteroidsPerChunk
  );
  const fieldMax = asFiniteNumber(
    field.population.maxPerChunk,
    Number.POSITIVE_INFINITY
  );

  const maxAsteroidsPerChunk = Math.floor(
    clampMin(Math.min(sysMax, fieldMax), 1)
  );

  return { maxAsteroidsPerChunk };
}

export function resolveFieldModels(
  system: SystemConfig,
  field: AsteroidFieldDef
): WeightedModelRef[] {
  const defs = getSystemAsteroidModelDefs(system);
  const available = new Set(defs.map((d) => d.id));

  const fieldModels = field.models ?? [];
  const filtered = fieldModels.filter((m) => available.has(m.modelId));

  if (filtered.length > 0) return filtered;

  // Fall back to the first available model def.
  if (defs.length > 0) return [{ modelId: defs[0].id, weight: 1 }];

  // Extra safety fallback.
  return [{ modelId: "asteroid_01", weight: 1 }];
}
