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
  /** Optional icon for HUD (emoji or short string). */
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
};

export type SphereShape = {
  type: "sphere";
  radiusKm: number;
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

export type AsteroidFieldDef = {
  id: string;
  seed: number | string;
  enabled?: boolean;
  frame?: "system";
  anchorKm: [number, number, number];
  shape: FieldShape;
  population: PopulationDef;
  size: SizeDef;
  models?: WeightedModelRef[];
  streaming?: Partial<StreamingConfig>;
  render?: Partial<RenderConfig>;
  tags?: string[];
  resources?: AsteroidResourcesDef;
};

export type SystemAssets = {
  asteroidModels?: AsteroidModelDef[];
};

export type SystemConfigV1 = {
  schemaVersion: 1;
  systemId: string;
  units: UnitsSpec;
  resources?: SystemResources;
  defaults?: SystemDefaults;
  assets?: SystemAssets;
  asteroidFields: AsteroidFieldDef[];
};

export type SystemConfig = SystemConfigV1;

export type ResolvedStreamingConfig = Required<
  Omit<StreamingConfig, "maxActiveChunks">
> & {
  maxActiveChunks: number;
};

export type ResolvedRenderConfig = {
  /** Max visible range (= max of nearRadiusKm, farRadiusKm). Used for streaming. */
  drawRadiusKm: number;
  /** Full-geometry render cutoff. */
  nearRadiusKm: number;
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

  // eslint-disable-next-line no-console
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
    farRadiusKm > 0 ? Math.max(nearRadiusKm, farRadiusKm) : nearRadiusKm,
    0.001
  );

  const fadeKm = fieldRender.fadeKm ?? sysRender.fadeKm;

  return { drawRadiusKm, nearRadiusKm, farRadiusKm, crossFadeKm, fadeKm };
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
