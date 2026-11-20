// ---------------------------------------------------------------------------
// Content (M3.3 / M3.4): items, research options and their typed evidence requirements.
// The recipe/research matrix is docs/M3_GAMEPLAY_PLAN.md §13.5 (revised after playtest 1, §13); every number is a tuning
// default. `auditContent` (src/sim/research/requirements.ts) checks the invariants.
// ---------------------------------------------------------------------------

export type ItemSlot =
  | "scanner"
  | "mining"
  | "cooling"
  | "cargo"
  | "hull"
  | "propulsion"
  | "utility";

export type ItemType = "module" | "consumable" | "special";

/**
 * A passive effect applied while a module is equipped.
 * `set` → boolean flag; `multiply` → multiplicative modifier; `add` → additive modifier.
 */
export type ItemEffect = {
  key: string;
  op: "set" | "multiply" | "add";
  value: number | boolean;
};

/** An instant effect triggered when a consumable is used. */
export type ConsumableUseEffect = {
  key: string;
  op: "multiply" | "set" | "add";
  value: number;
};

export type ItemDef = {
  id: string;
  name: string;
  uiDesc: string;
  slot: ItemSlot;
  type: ItemType;
  /** Craftable from the start, no research. */
  starter?: boolean;
  /** Icon file stem when the item reuses another item's asset. */
  icon?: string;
  effects?: ItemEffect[];
  useEffects?: ConsumableUseEffect[];
  /** Effect keys `uiDesc` already states; craft cards do not repeat them as chips (R1). */
  descStates?: string[];
  useDurationS?: number;
  cooldownS?: number;
  stackMax?: number;
  /** Counted deployable (replication kit): its hotbar slot opens placement instead of consuming it. */
  deployable?: boolean;
  /** resourceId → integer cargo units consumed. */
  recipe: Record<string, number>;
};

// ---------------------------------------------------------------------------
// Evidence: material families, trials, sites
// ---------------------------------------------------------------------------

/** A material counts as a confirmed family when it is at least this share of a rock's yield. */
export const FAMILY_MIN_SHARE = 0.03;

export const MATERIAL_NAMES: Record<string, string> = {
  silicates: "Silicates",
  fe_ni_metal: "Fe-Ni metal",
  sulfur: "Sulfur",
  carbon: "Carbon",
  hydrates: "Hydrates",
  titanium: "Titanium",
  helium_3: "Helium-3",
};

export const materialName = (id: string): string => MATERIAL_NAMES[id] ?? id;

export const SOURCE_CLASS_NAMES: Record<string, string> = {
  s_type: "S-type",
  c_type: "C-type",
  x_type: "X-type",
  l_regolith: "L-regolith",
  l_metallic: "L-metallic",
  l_volatile: "L-volatile",
};

export type TrialDef = { id: string; name: string; howTo: string };

/** One meaningful safe use each: never damage, stranding or repetition. */
export const TRIALS: TrialDef[] = [
  { id: "first_batch", name: "First propellant batch", howTo: "Complete a propellant processing batch" },
  { id: "sustained_beam", name: "Sustained extraction", howTo: "Keep the mining laser on one rock for 8 s without overheating" },
  { id: "first_fabrication", name: "First fabrication", howTo: "Fabricate any item" },
  { id: "transit_leg", name: "Transit calibration run", howTo: "Complete a transit leg to a destination" },
];

/** Tractor acquisition radius, measured from the wreck in its own orbital frame. */
export const WRECK_SALVAGE_KM = 0.3;

/** Close inspection, starter scanner: hold time on a locked rock and maximum range. */
export const INSPECT_TIME_S = 4;
export const INSPECT_RANGE_M = 2500;

/** Continuous beam seconds on one rock for `sustained_beam`. */
export const SUSTAINED_BEAM_S = 8;

export type SiteDef = {
  id: string;
  name: string;
  /** What the regional indication calls it before inspection. */
  signalName: string;
  frameId: string;
  /** Relative to `frameId`, km. */
  positionKm: [number, number, number];
  /** Regional indication: the marker shows within this distance, km. */
  signalRangeKm: number;
  /** Close inspection within this range, km (one [G] inspects and recovers: keep it = recoverRangeKm). */
  inspectRangeKm: number;
  /** Recovery (one accepted operation) within this range, km. */
  recoverRangeKm: number;
  /** One-time reward into cargo (units); recovery is refused if the hold cannot take it. */
  reward: Record<string, number>;
};

/**
 * Authored sites (M3.7). The lunar canister sits 1,500 km beyond luna_belt's anchor, radially out from
 * the Moon (inside the field core, rocks loaded around it; 4,900 km from Luna, outside its 2 R route
 * clearance). Field and site sit 3,290 / 4,740 km north of the ecliptic, so the Moon's shadow (a
 * <= 1,753 km cylinder in the ecliptic) never reaches them; Sun-Luna-site phase 75 deg at the default
 * date, 75-105 deg over the year (Luna in view half to gibbous lit, playtest 2).
 */
export const SITES: SiteDef[] = [
  {
    id: "luna_survey_canister",
    name: "Survey canister",
    signalName: "Survey signal",
    frameId: "luna",
    positionKm: [1629, 4605, 393],
    signalRangeKm: 120_000,
    inspectRangeKm: 2,
    recoverRangeKm: 2,
    reward: { titanium: 30 },
  },
];

export function getSiteDef(id: string): SiteDef | undefined {
  return SITES.find((s) => s.id === id);
}

export function getTrialDef(id: string): TrialDef | undefined {
  return TRIALS.find((t) => t.id === id);
}

// ---------------------------------------------------------------------------
// Research options: typed requirements (bounded all + optional any-of-one)
// ---------------------------------------------------------------------------

export type Requirement =
  /** `inspected`: the family must have been confirmed by a close inspection, not only by mining. */
  | { kind: "family"; material: string; inspected?: boolean }
  /** A close inspection of a rock of this class. */
  | { kind: "sourceClass"; classId: string }
  | { kind: "trial"; trialId: string }
  | { kind: "site"; siteId: string }
  | { kind: "research"; nodeId: string };

export type ResearchBranch = "survey" | "extraction" | "thermal" | "logistics" | "propulsion" | "hull" | "lunar";

export const INDUSTRY_BLUEPRINTS = {
  depot_kit: "Depot kit",
  drone: "Utility drone",
  refinery: "Depot refinery",
  mining: "Drone mining",
  point_tank: "Replication point fuel tank",
} as const;

export type IndustryBlueprint = keyof typeof INDUSTRY_BLUEPRINTS;

export type ResearchNodeDef = {
  id: string;
  name: string;
  branch: ResearchBranch;
  /** What the unlock is for, in one line. */
  purpose: string;
  /** Every entry required. */
  all: Requirement[];
  /** At least one entry required (omitted = no any-of group). */
  any?: Requirement[];
  /** Matching material consumed by the analysis (cargo units). */
  analysis: Record<string, number>;
  unlocks: { items: string[]; industry?: IndustryBlueprint[] };
};

export const BRANCH_LABELS: Record<ResearchBranch, string> = {
  survey: "Survey",
  extraction: "Extraction",
  thermal: "Thermal",
  logistics: "Logistics",
  propulsion: "Propulsion",
  hull: "Hull",
  lunar: "Lunar opportunity",
};

export const RESEARCH_NODES: ResearchNodeDef[] = [
  {
    id: "sv1_composition_survey",
    name: "Composition Survey",
    branch: "survey",
    purpose: "Faster, longer-range inspections and composition bands at target lock.",
    all: [
      { kind: "sourceClass", classId: "s_type" },
      { kind: "sourceClass", classId: "c_type" },
      { kind: "sourceClass", classId: "x_type" },
    ],
    analysis: { silicates: 20 },
    unlocks: { items: ["module_prospector_scanner_mk1"] },
  },
  {
    id: "sv2_volatile_mapping",
    name: "Volatile Mapping",
    branch: "survey",
    purpose: "A ping that marks nearby rocks and inspects from far away.",
    all: [
      { kind: "research", nodeId: "sv1_composition_survey" },
      { kind: "family", material: "hydrates", inspected: true },
      { kind: "family", material: "carbon" },
    ],
    analysis: { hydrates: 5, carbon: 5 },
    unlocks: { items: ["module_ping_array_mk1"] },
  },
  {
    id: "ex1_controlled_extraction",
    name: "Controlled Extraction",
    branch: "extraction",
    purpose: "Fit a faster, hotter beam to your ship and assign drones to mine nearby asteroids.",
    all: [
      { kind: "family", material: "fe_ni_metal", inspected: true },
      { kind: "trial", trialId: "sustained_beam" },
    ],
    analysis: { fe_ni_metal: 30 },
    unlocks: { items: ["module_beam_focuser_mk1"], industry: ["mining"] },
  },
  {
    id: "ex2_yield_analysis",
    name: "Yield Analysis",
    branch: "extraction",
    purpose: "Recover more material from every rock, a little slower.",
    all: [
      { kind: "research", nodeId: "ex1_controlled_extraction" },
      { kind: "family", material: "sulfur" },
    ],
    any: [
      { kind: "family", material: "carbon" },
      { kind: "sourceClass", classId: "c_type" },
    ],
    analysis: { sulfur: 5 },
    unlocks: { items: ["module_yield_extractor_mk1"] },
  },
  {
    id: "th1_heat_rejection",
    name: "Heat Rejection",
    branch: "thermal",
    purpose: "Longer laser duty and faster cooling for sustained work.",
    all: [
      { kind: "trial", trialId: "sustained_beam" },
      { kind: "family", material: "silicates" },
    ],
    analysis: { silicates: 30 },
    unlocks: { items: ["module_radiator_strips_mk1", "module_coolant_circulator_mk1"] },
  },
  {
    id: "lg1_bulk_handling",
    name: "Bulk Handling",
    branch: "logistics",
    purpose: "Build your first depot, equip a recovery point with a fuel tank, or expand your ship’s cargo and processing capacity.",
    all: [
      { kind: "trial", trialId: "first_batch" },
      { kind: "trial", trialId: "first_fabrication" },
    ],
    analysis: { fe_ni_metal: 30 },
    unlocks: {
      items: ["module_cargo_rack_mk1", "module_aux_tank_mk1", "module_electrolysis_cell_mk1", "consumable_depot_kit"],
      industry: ["depot_kit", "drone", "point_tank"],
    },
  },
  {
    id: "lg2_station_refining",
    name: "Station Refining",
    branch: "logistics",
    purpose: "Use depot stock to turn hydrates into ordinary propellant while you explore.",
    all: [
      { kind: "research", nodeId: "lg1_bulk_handling" },
      { kind: "trial", trialId: "first_batch" },
    ],
    analysis: { hydrates: 10, fe_ni_metal: 15 },
    unlocks: { items: [], industry: ["refinery"] },
  },
  {
    id: "pr1_transit_calibration",
    name: "Transit Drive Calibration",
    branch: "propulsion",
    purpose: "Fabricate the transit drive for travel between regions.",
    all: [
      { kind: "research", nodeId: "th1_heat_rejection" },
      { kind: "research", nodeId: "lg1_bulk_handling" },
      { kind: "sourceClass", classId: "c_type" },
      { kind: "family", material: "hydrates" },
    ],
    analysis: { hydrates: 15, fe_ni_metal: 40 },
    unlocks: { items: ["special_transit_drive"] },
  },
  {
    id: "pr2_thruster_tuning",
    name: "Thruster Tuning",
    branch: "propulsion",
    purpose: "Quicker acceleration and a higher manoeuvring top speed.",
    all: [
      { kind: "research", nodeId: "pr1_transit_calibration" },
      { kind: "trial", trialId: "transit_leg" },
    ],
    analysis: { fe_ni_metal: 20, sulfur: 5 },
    unlocks: { items: ["module_thruster_nozzles_mk1"] },
  },
  {
    id: "hl1_hull_reinforcement",
    name: "Hull Reinforcement",
    branch: "hull",
    purpose: "Tougher plating and paid automatic repairs.",
    all: [
      { kind: "family", material: "fe_ni_metal", inspected: true },
      { kind: "trial", trialId: "first_fabrication" },
    ],
    analysis: { fe_ni_metal: 20 },
    unlocks: { items: ["module_ablative_plating_mk1", "module_nanite_repair_mk1"] },
  },
  {
    id: "ln1_survey_salvage",
    name: "Survey Instrument Recovery",
    branch: "lunar",
    purpose: "Optional specialist scanner decoded from the recovered lunar survey canister.",
    all: [
      { kind: "site", siteId: "luna_survey_canister" },
      { kind: "research", nodeId: "sv2_volatile_mapping" },
    ],
    analysis: { titanium: 10 },
    unlocks: { items: ["module_integrated_sensor_suite"] },
  },
];

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const ITEMS: ItemDef[] = [
  {
    id: "consumable_depot_kit",
    name: "Depot kit",
    uiDesc: "Deploys a shared storage and fabrication depot",
    slot: "utility",
    type: "consumable",
    icon: "module_ping_array_mk1",
    deployable: true,
    stackMax: 3,
    recipe: { fe_ni_metal: 125, silicates: 90 },
  },
  // ── Starter: no research ────────────────────────────────────────────────
  {
    id: "consumable_hull_patch_kit",
    name: "Hull Patch Kit",
    uiDesc: "Restores 15 hull",
    descStates: ["ship.currentHealth"],
    slot: "utility",
    type: "consumable",
    starter: true,
    icon: "module_ablative_plating_mk1",
    useEffects: [{ key: "ship.currentHealth", op: "add", value: 15 }],
    stackMax: 10,
    recipe: { fe_ni_metal: 15, silicates: 10 },
  },
  {
    id: "consumable_heat_sink_cartridge",
    name: "Heat Sink Cartridge",
    uiDesc: "Dumps half the heat",
    descStates: ["mining.currentHeat"],
    slot: "utility",
    type: "consumable",
    starter: true,
    useEffects: [{ key: "mining.currentHeat", op: "add", value: -0.5 }],
    stackMax: 10,
    recipe: { silicates: 20, fe_ni_metal: 5 },
  },
  {
    id: "consumable_replication_kit",
    name: "Replication Kit",
    uiDesc: "Places a respawn point",
    slot: "utility",
    type: "consumable",
    starter: true,
    icon: "module_ping_array_mk1",
    deployable: true,
    stackMax: 3,
    recipe: { fe_ni_metal: 150, silicates: 100 },
  },

  // ── Survey ──────────────────────────────────────────────────────────────
  {
    id: "module_prospector_scanner_mk1",
    name: "Prospector Scanner Mk1",
    uiDesc: "Faster, longer-range inspection",
    slot: "scanner",
    type: "module",
    effects: [
      { key: "scanner.inspectTimeMultiplier", op: "multiply", value: 0.5 },
      { key: "scanner.inspectRangeMultiplier", op: "multiply", value: 1.6 },
      { key: "scanner.lockShowsCompositionBands", op: "set", value: true },
    ],
    recipe: { silicates: 120, fe_ni_metal: 40 },
  },
  {
    id: "module_ping_array_mk1",
    name: "Ping Array Mk1",
    uiDesc: "Marks nearby rocks",
    descStates: ["scanner.pingHighlightEnabled"],
    slot: "scanner",
    type: "module",
    effects: [
      { key: "scanner.pingHighlightEnabled", op: "set", value: true },
      { key: "scanner.lockShowsCompositionBands", op: "set", value: true },
      { key: "scanner.inspectRangeMultiplier", op: "multiply", value: 2.4 },
      { key: "scanner.inspectTimeMultiplier", op: "multiply", value: 0.75 },
    ],
    recipe: { silicates: 150, fe_ni_metal: 60, carbon: 6 },
  },

  // ── Extraction ──────────────────────────────────────────────────────────
  {
    id: "module_beam_focuser_mk1",
    name: "Beam Focuser Mk1",
    uiDesc: "Cuts faster, runs hotter",
    slot: "mining",
    type: "module",
    effects: [
      { key: "mining.timePerAsteroidMultiplier", op: "multiply", value: 0.7 },
      { key: "mining.powerMultiplier", op: "multiply", value: 1.3 },
      { key: "mining.heatBuildUpRateMultiplier", op: "multiply", value: 1.3 },
    ],
    recipe: { fe_ni_metal: 90, silicates: 80 },
  },
  {
    id: "module_yield_extractor_mk1",
    name: "Yield Extractor Mk1",
    uiDesc: "More material per rock",
    slot: "mining",
    type: "module",
    icon: "module_beam_focuser_mk1",
    effects: [
      { key: "mining.yieldMultiplier", op: "multiply", value: 1.25 },
      { key: "mining.timePerAsteroidMultiplier", op: "multiply", value: 1.1 },
    ],
    recipe: { fe_ni_metal: 120, silicates: 60, sulfur: 4 },
  },

  // ── Thermal ─────────────────────────────────────────────────────────────
  {
    id: "module_radiator_strips_mk1",
    name: "Radiator Strips Mk1",
    uiDesc: "Slower laser heating",
    slot: "cooling",
    type: "module",
    effects: [
      { key: "mining.heatBuildUpRateMultiplier", op: "multiply", value: 0.8 },
      { key: "mining.cooldownSpeedMultiplier", op: "multiply", value: 1.15 },
    ],
    recipe: { silicates: 140, fe_ni_metal: 40 },
  },
  {
    id: "module_coolant_circulator_mk1",
    name: "Coolant Circulator Mk1",
    uiDesc: "Much faster cooling",
    slot: "cooling",
    type: "module",
    icon: "module_radiator_strips_mk1",
    effects: [
      { key: "mining.cooldownSpeedMultiplier", op: "multiply", value: 1.4 },
      { key: "ship.heatCapacityMultiplier", op: "multiply", value: 1.25 },
    ],
    recipe: { silicates: 100, fe_ni_metal: 70, carbon: 4 },
  },

  // ── Logistics (one cargo slot: hold or tank) ────────────────────────────
  {
    id: "module_cargo_rack_mk1",
    name: "Cargo Rack Mk1",
    uiDesc: "More cargo space",
    slot: "cargo",
    type: "module",
    effects: [{ key: "ship.cargoCapacity", op: "add", value: 600 }],
    recipe: { fe_ni_metal: 150, silicates: 50 },
  },
  {
    id: "module_aux_tank_mk1",
    name: "Auxiliary Tank Mk1",
    uiDesc: "More fuel, less cargo",
    slot: "cargo",
    type: "module",
    icon: "module_cargo_rack_mk1",
    effects: [
      { key: "ship.tankKg", op: "add", value: 400 },
      { key: "ship.cargoCapacity", op: "add", value: -500 },
    ],
    recipe: { fe_ni_metal: 120, silicates: 40 },
  },
  {
    id: "module_electrolysis_cell_mk1",
    name: "Electrolysis Cell Mk1",
    uiDesc: "Faster fuel processing",
    slot: "utility",
    type: "module",
    icon: "module_spectral_mapper_mk1",
    effects: [
      { key: "processing.rateMultiplier", op: "multiply", value: 1.6 },
      { key: "ship.reactorKW", op: "add", value: 25 },
    ],
    recipe: { silicates: 80, fe_ni_metal: 60, carbon: 4 },
  },

  // ── Propulsion ──────────────────────────────────────────────────────────
  {
    id: "special_transit_drive",
    name: "Transit Drive",
    uiDesc: "Travel between regions",
    slot: "utility",
    type: "special",
    icon: "module_thruster_nozzles_mk1",
    recipe: { silicates: 600, fe_ni_metal: 550, hydrates: 30, carbon: 20, sulfur: 12 },
  },
  {
    id: "module_thruster_nozzles_mk1",
    name: "Thruster Nozzles Mk1",
    uiDesc: "Quicker, faster flight",
    slot: "propulsion",
    type: "module",
    effects: [
      { key: "ship.accelerationMultiplier", op: "multiply", value: 1.15 },
      { key: "ship.maxSpeedMultiplier", op: "multiply", value: 1.2 },
    ],
    recipe: { fe_ni_metal: 150, silicates: 80, sulfur: 6 },
  },

  // ── Hull ────────────────────────────────────────────────────────────────
  {
    id: "module_ablative_plating_mk1",
    name: "Ablative Plating Mk1",
    uiDesc: "More hull, softer impacts",
    slot: "hull",
    type: "module",
    effects: [
      { key: "ship.maxHealthMultiplier", op: "multiply", value: 1.25 },
      { key: "ship.collisionDamageMultiplier", op: "multiply", value: 0.9 },
    ],
    recipe: { fe_ni_metal: 200, silicates: 100 },
  },
  {
    id: "module_nanite_repair_mk1",
    name: "Nanite Repair System",
    uiDesc: "Self-repair using Fe-Ni",
    slot: "hull",
    type: "module",
    icon: "module_ablative_plating_mk1",
    effects: [{ key: "ship.hullRegenPerSecond", op: "add", value: 0.2 }],
    recipe: { fe_ni_metal: 150, silicates: 80, carbon: 6 },
  },

  // ── Lunar opportunity (optional specialist; titanium is fine here) ──────
  {
    id: "module_integrated_sensor_suite",
    name: "Integrated Sensor Suite",
    uiDesc: "Every scanner ability, improved",
    slot: "scanner",
    type: "module",
    icon: "module_spectral_mapper_mk1",
    effects: [
      { key: "scanner.pingHighlightEnabled", op: "set", value: true },
      { key: "scanner.lockShowsCompositionBands", op: "set", value: true },
      { key: "scanner.inspectRangeMultiplier", op: "multiply", value: 3 },
      { key: "scanner.inspectTimeMultiplier", op: "multiply", value: 0.4 },
      { key: "scanner.lockSpeedMultiplier", op: "multiply", value: 0.7 },
      { key: "scanner.allRangeMultiplier", op: "multiply", value: 1.25 },
    ],
    recipe: { silicates: 200, fe_ni_metal: 100, titanium: 60 },
  },
];

// ---------------------------------------------------------------------------
// Onboard processing and repair (M3.2): available from the start, no research gate.
// ---------------------------------------------------------------------------

export type ProcessingRecipeDef = {
  id: string;
  name: string;
  uiDesc: string;
  /** Cargo feedstock consumed per unit. */
  inputId: string;
};

export const PROCESSING_RECIPES: ProcessingRecipeDef[] = [
  {
    id: "hydrate_propellant",
    name: "Fuel processing",
    uiDesc: "Hydrates into fuel",
    inputId: "hydrates",
  },
];

export function getProcessingRecipe(id: string): ProcessingRecipeDef | undefined {
  return PROCESSING_RECIPES.find((r) => r.id === id);
}

/** Structural material hull repairs consume. */
export const REPAIR_MATERIAL_ID = "fe_ni_metal";

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

const _itemMap = new Map<string, ItemDef>();
for (const item of ITEMS) _itemMap.set(item.id, item);

const _nodeMap = new Map<string, ResearchNodeDef>();
for (const node of RESEARCH_NODES) _nodeMap.set(node.id, node);

export function getItemDef(id: string): ItemDef | undefined {
  return _itemMap.get(id);
}

/** Industry and the research screen read the same unlock catalogue. */
export function industryResearchNode(blueprint: IndustryBlueprint): ResearchNodeDef {
  const node = RESEARCH_NODES.find(candidate => candidate.unlocks.industry?.includes(blueprint));
  if (!node) throw new Error(`Missing research for industry blueprint ${blueprint}`);
  return node;
}

export function getResearchNode(id: string): ResearchNodeDef | undefined {
  return _nodeMap.get(id);
}

export function getItemsBySlot(slot: ItemSlot): ItemDef[] {
  return ITEMS.filter((i) => i.slot === slot);
}

export const STARTER_ITEM_IDS: readonly string[] = ITEMS.filter((i) => i.starter).map((i) => i.id);

/** Icon URL: the item's own asset, or the one it reuses. */
export function getItemIconUrl(item: Pick<ItemDef, "id" | "type" | "icon">): string {
  const stem = item.icon ?? item.id;
  const folder = stem.startsWith("consumable_") ? "consumables" : "modules";
  return `/assets/${folder}/${stem}.png`;
}

export const ALL_ITEM_SLOTS: ItemSlot[] = ["scanner", "mining", "cooling", "cargo", "hull", "propulsion", "utility"];

export const SLOT_LABELS: Record<ItemSlot, string> = {
  scanner: "Scanner",
  mining: "Mining",
  cooling: "Cooling",
  cargo: "Cargo",
  hull: "Hull",
  propulsion: "Propulsion",
  utility: "Utility",
};

/** Crafting filter (D14): the drive is a special item, never equipped, so it gets its own tab. */
export type CraftCategory = "drive" | ItemSlot | "consumables" | "processing";

export const CRAFT_CATEGORIES: CraftCategory[] = ["drive", "scanner", "mining", "cooling", "cargo", "propulsion", "hull", "utility", "consumables", "processing"];

export const CRAFT_CATEGORY_LABELS: Record<CraftCategory, string> = {
  ...SLOT_LABELS, drive: "Drive", consumables: "Consumables", processing: "Processing",
};

export function craftCategory(item: Pick<ItemDef, "type" | "slot">): CraftCategory {
  return item.type === "special" ? "drive" : item.type === "consumable" ? "consumables" : item.slot;
}

// ---------------------------------------------------------------------------
// Human-readable effect descriptions
// ---------------------------------------------------------------------------

function fmtPct(multiplier: number): string {
  const pct = Math.round((multiplier - 1) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

const signed = (v: number): string => `${v >= 0 ? "+" : ""}${v}`;

const EFFECT_DESCRIPTIONS: Record<string, (value: number | boolean, op: string) => string> = {
  "scanner.pingHighlightEnabled": () => "Ping highlight",
  "scanner.lockShowsCompositionBands": () => "Composition bands",
  "scanner.inspectTimeMultiplier": (v) => `Inspect time ${fmtPct(v as number)}`,
  "scanner.inspectRangeMultiplier": (v) => `Inspect range ${fmtPct(v as number)}`,
  "scanner.lockSpeedMultiplier": (v) => `Lock time ${fmtPct(v as number)}`,
  "scanner.allRangeMultiplier": (v) => `Sensor range ${fmtPct(v as number)}`,
  "ship.cargoCapacity": (v) => `Cargo ${signed(v as number)}`,
  "ship.tankKg": (v) => `Tank ${signed(v as number)} kg`,
  "ship.reactorKW": (v) => `Reactor ${signed(v as number)} kW`,
  "ship.heatCapacityMultiplier": (v) => `Heat buffer ${fmtPct(v as number)}`,
  "processing.rateMultiplier": (v) => `Processing ${fmtPct(v as number)}`,
  "mining.timePerAsteroidMultiplier": (v) => `Mining time ${fmtPct(v as number)}`,
  "mining.powerMultiplier": (v) => `Laser power ${fmtPct(v as number)}`,
  "mining.heatBuildUpRateMultiplier": (v) => `Laser heating ${fmtPct(v as number)}`,
  "mining.yieldMultiplier": (v) => `Yield ${fmtPct(v as number)}`,
  "mining.cooldownSpeedMultiplier": (v) => `Cooling ${fmtPct(v as number)}`,
  "ship.maxHealthMultiplier": (v) => `Max hull ${fmtPct(v as number)}`,
  "ship.collisionDamageMultiplier": (v) => `Impact damage ${fmtPct(v as number)}`,
  "ship.hullRegenPerSecond": (v) => `Repair ${v} HP/s`,
  "ship.decelerationMultiplier": (v) => `Braking ${fmtPct(v as number)}`,
  "ship.accelerationMultiplier": (v) => `Acceleration ${fmtPct(v as number)}`,
  "ship.maxSpeedMultiplier": (v) => `Top speed ${fmtPct(v as number)}`,
  "mining.currentHeat": (v, op) =>
    op === "add" ? `Heat ${(v as number) > 0 ? "+" : ""}${Math.round((v as number) * 100)}%` : op === "set" ? "Full heat reset" : `Heat ×${v}`,
  "ship.currentHealth": (v, op) => (op === "add" ? `Hull +${v}` : `Hull = ${v}`),
};

/** Multipliers where a smaller value is the improvement. */
const LOWER_IS_BETTER = new Set([
  "mining.powerMultiplier", "mining.heatBuildUpRateMultiplier", "mining.timePerAsteroidMultiplier",
  "ship.collisionDamageMultiplier", "scanner.inspectTimeMultiplier", "scanner.lockSpeedMultiplier",
]);

/** True when the effect costs the player something (shown as a tradeoff, not a buff). */
export function isDrawback(eff: { key: string; op: string; value: number | boolean }): boolean {
  if (typeof eff.value !== "number") return false;
  if (eff.op === "multiply") return LOWER_IS_BETTER.has(eff.key) ? eff.value > 1 : eff.value < 1;
  return eff.op === "add" && eff.value < 0;
}

export function describeEffect(eff: { key: string; op: string; value: number | boolean }): string {
  const fn = EFFECT_DESCRIPTIONS[eff.key];
  if (fn) return fn(eff.value, eff.op);
  const label = eff.key.split(".").pop() ?? eff.key;
  if (eff.op === "set") return `${label}: ${eff.value ? "ON" : "OFF"}`;
  if (eff.op === "multiply") return `${label} ${fmtPct(eff.value as number)}`;
  return `${label} ${eff.value}`;
}
