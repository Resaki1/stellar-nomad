// ---------------------------------------------------------------------------
// Content definitions: items (modules + consumables) and research nodes.
//
// To add new items or research nodes, simply append to the arrays below.
// The rest of the system will pick them up automatically.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
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
 * A passive effect applied while a module is equipped (or as a research bonus).
 *
 * - `set`       → boolean flag; overrides to `value`
 * - `multiply`  → multiplicative modifier (e.g. 0.85 = 15 % reduction)
 * - `add`       → additive modifier (e.g. +400)
 */
export type ItemEffect = {
  key: string;
  op: "set" | "multiply" | "add";
  value: number | boolean;
};

/**
 * An instant effect triggered when a consumable is used.
 */
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
  /** Passive effects (modules only). */
  effects?: ItemEffect[];
  /** Instant-use effects (consumables only). */
  useEffects?: ConsumableUseEffect[];
  /** Duration for timed consumable effects, in seconds. */
  useDurationS?: number;
  /** Cooldown between uses in seconds (consumables only). */
  cooldownS?: number;
  /** Max stack size (consumables only). */
  stackMax?: number;
  /** Crafting recipe: resourceId → amount required. */
  recipe: Record<string, number>;
};

/**
 * Prerequisite rule for milestone nodes that don't use a fixed list.
 * `type: "anyN"` means: at least `count` nodes from `nodes` must be completed.
 */
export type PrerequisiteRule = {
  type: "anyN";
  nodes: string[];
  count: number;
};

export type ResearchNodeDef = {
  id: string;
  name: string;
  desc: string;
  durationSeconds: number;
  costs: { assaySamples: number };
  prerequisites: string[];
  /** Special prerequisite rule (e.g. "any 3 tier-2 nodes"). Checked in addition to `prerequisites`. */
  prerequisiteRule?: PrerequisiteRule;
  /** Passive effects applied permanently when this node is completed. */
  researchEffects?: ItemEffect[];
  unlocks: {
    items?: string[];
    research?: string[];
  };
};

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const ITEMS: ItemDef[] = [
  // =========================================================================
  // SCANNER SLOT — Branch A (Survey & Detection)
  // =========================================================================
  {
    id: "module_prospector_scanner_mk1",
    name: "Prospector Scanner Mk1",
    uiDesc: "Target lock shows asteroid type (S / C / X)",
    slot: "scanner",
    type: "module",
    effects: [
      { key: "scanner.lockShowsAsteroidType", op: "set", value: true },
    ],
    recipe: { silicates: 180, fe_ni_metal: 60, carbon: 20, sulfur: 8 },
  },
  {
    id: "module_ping_array_mk1",
    name: "Ping Array Mk1",
    uiDesc: "Active ping highlights nearby targetable asteroids",
    slot: "scanner",
    type: "module",
    effects: [
      { key: "scanner.pingHighlightEnabled", op: "set", value: true },
      { key: "scanner.pingHighlightRangeMultiplier", op: "multiply", value: 1.15 },
    ],
    recipe: { silicates: 260, fe_ni_metal: 90, carbon: 25, sulfur: 15 },
  },
  {
    id: "module_spectral_mapper_mk1",
    name: "Spectral Mapper Mk1",
    uiDesc: "Target lock shows composition bands (metal / hydrate / carbon rich)",
    slot: "scanner",
    type: "module",
    effects: [
      { key: "scanner.lockShowsCompositionBands", op: "set", value: true },
    ],
    recipe: { silicates: 200, fe_ni_metal: 80, carbon: 60, sulfur: 20, hydrates: 30 },
  },
  {
    id: "module_integrated_sensor_suite",
    name: "Integrated Sensor Suite",
    uiDesc: "All scanner capabilities unified: type, ping, composition, yield estimate",
    slot: "scanner",
    type: "module",
    effects: [
      { key: "scanner.lockShowsAsteroidType", op: "set", value: true },
      { key: "scanner.pingHighlightEnabled", op: "set", value: true },
      { key: "scanner.pingHighlightRangeMultiplier", op: "multiply", value: 1.25 },
      { key: "scanner.lockShowsCompositionBands", op: "set", value: true },
      { key: "scanner.lockShowsYieldEstimate", op: "set", value: true },
    ],
    recipe: { silicates: 400, fe_ni_metal: 150, carbon: 80, sulfur: 40, hydrates: 50, titanium: 30 },
  },

  // =========================================================================
  // MINING SLOT — Branch B (Extraction Engineering)
  // =========================================================================
  {
    id: "module_beam_focuser_mk1",
    name: "Beam Focuser Mk1",
    uiDesc: "Faster mining per asteroid",
    slot: "mining",
    type: "module",
    effects: [
      { key: "mining.timePerAsteroidMultiplier", op: "multiply", value: 0.85 },
    ],
    recipe: { silicates: 200, fe_ni_metal: 70, carbon: 40, sulfur: 10 },
  },
  {
    id: "module_beam_focuser_mk2",
    name: "Beam Focuser Mk2",
    uiDesc: "Significantly faster mining per asteroid",
    slot: "mining",
    type: "module",
    effects: [
      { key: "mining.timePerAsteroidMultiplier", op: "multiply", value: 0.75 },
    ],
    recipe: { silicates: 400, fe_ni_metal: 120, carbon: 60, sulfur: 25 },
  },
  {
    id: "module_yield_extractor_mk1",
    name: "Yield Extractor Mk1",
    uiDesc: "More resources per asteroid mined",
    slot: "mining",
    type: "module",
    effects: [
      { key: "mining.yieldMultiplier", op: "multiply", value: 1.20 },
    ],
    recipe: { silicates: 300, fe_ni_metal: 100, carbon: 80, sulfur: 30 },
  },
  {
    id: "module_pulse_modulator_mk1",
    name: "Pulse Modulator Mk1",
    uiDesc: "Unlock Pulse Mining mode (sustained mining, near-zero overheat risk)",
    slot: "mining",
    type: "module",
    effects: [
      { key: "ability.pulseMiningEnabled", op: "set", value: true },
    ],
    recipe: { silicates: 350, fe_ni_metal: 100, carbon: 60, sulfur: 40, helium_3: 20 },
  },

  // =========================================================================
  // COOLING SLOT — Branch B (Thermal sub-branch)
  // =========================================================================
  {
    id: "module_radiator_strips_mk1",
    name: "Radiator Strips Mk1",
    uiDesc: "Mine longer before overheating",
    slot: "cooling",
    type: "module",
    effects: [
      { key: "mining.heatBuildUpRateMultiplier", op: "multiply", value: 0.80 },
    ],
    recipe: { silicates: 350, fe_ni_metal: 80, carbon: 50, sulfur: 30 },
  },
  {
    id: "module_coolant_circulator_mk1",
    name: "Coolant Circulator Mk1",
    uiDesc: "Faster recovery when overheated",
    slot: "cooling",
    type: "module",
    effects: [
      { key: "mining.cooldownSpeedMultiplier", op: "multiply", value: 1.30 },
    ],
    recipe: { silicates: 280, fe_ni_metal: 100, carbon: 40, sulfur: 35 },
  },
  {
    id: "module_radiator_strips_mk2",
    name: "Radiator Strips Mk2",
    uiDesc: "Substantially slower heat buildup during mining",
    slot: "cooling",
    type: "module",
    effects: [
      { key: "mining.heatBuildUpRateMultiplier", op: "multiply", value: 0.65 },
    ],
    recipe: { silicates: 500, fe_ni_metal: 120, carbon: 80, sulfur: 50, titanium: 15 },
  },

  // =========================================================================
  // CARGO SLOT — Branch C (Ship Systems)
  // =========================================================================
  {
    id: "module_cargo_rack_mk1",
    name: "Cargo Rack Mk1",
    uiDesc: "More cargo space",
    slot: "cargo",
    type: "module",
    effects: [{ key: "ship.cargoCapacity", op: "add", value: 400 }],
    recipe: { silicates: 250, fe_ni_metal: 120, sulfur: 10 },
  },
  {
    id: "module_cargo_rack_mk2",
    name: "Cargo Rack Mk2",
    uiDesc: "Significantly more cargo space",
    slot: "cargo",
    type: "module",
    effects: [{ key: "ship.cargoCapacity", op: "add", value: 800 }],
    recipe: { silicates: 500, fe_ni_metal: 250, sulfur: 20 },
  },

  // =========================================================================
  // HULL SLOT — Branch C (Hull sub-branch)
  // =========================================================================
  {
    id: "module_ablative_plating_mk1",
    name: "Ablative Plating Mk1",
    uiDesc: "More hull HP, collisions hurt less",
    slot: "hull",
    type: "module",
    effects: [
      { key: "ship.maxHealthMultiplier", op: "multiply", value: 1.25 },
      { key: "ship.collisionDamageMultiplier", op: "multiply", value: 0.90 },
    ],
    recipe: { silicates: 300, fe_ni_metal: 200, carbon: 30, sulfur: 15 },
  },
  {
    id: "module_ablative_plating_mk2",
    name: "Ablative Plating Mk2",
    uiDesc: "Substantially more hull HP, significantly reduced collision damage",
    slot: "hull",
    type: "module",
    effects: [
      { key: "ship.maxHealthMultiplier", op: "multiply", value: 1.50 },
      { key: "ship.collisionDamageMultiplier", op: "multiply", value: 0.80 },
    ],
    recipe: { silicates: 500, fe_ni_metal: 350, carbon: 40, sulfur: 25, titanium: 40 },
  },
  {
    id: "module_nanite_repair_mk1",
    name: "Nanite Repair System",
    uiDesc: "Slow passive hull regeneration",
    slot: "hull",
    type: "module",
    effects: [
      { key: "ship.hullRegenPerSecond", op: "add", value: 0.2 },
    ],
    recipe: { silicates: 300, fe_ni_metal: 250, carbon: 100, sulfur: 40, titanium: 30, helium_3: 20 },
  },

  // =========================================================================
  // PROPULSION SLOT — Branch C (Propulsion sub-branch)
  // =========================================================================
  {
    id: "module_reaction_wheels_mk1",
    name: "Reaction Wheels Mk1",
    uiDesc: "Better control + stronger braking",
    slot: "propulsion",
    type: "module",
    effects: [
      { key: "ship.decelerationMultiplier", op: "multiply", value: 1.20 },
    ],
    recipe: { silicates: 180, fe_ni_metal: 200, carbon: 15, sulfur: 20 },
  },
  {
    id: "module_thruster_nozzles_mk1",
    name: "Thruster Nozzles Mk1",
    uiDesc: "Faster acceleration + higher top speed",
    slot: "propulsion",
    type: "module",
    effects: [
      { key: "ship.accelerationMultiplier", op: "multiply", value: 1.15 },
      { key: "ship.maxSpeedMultiplier", op: "multiply", value: 1.20 },
    ],
    recipe: { silicates: 250, fe_ni_metal: 250, carbon: 20, sulfur: 30 },
  },
  {
    id: "module_thruster_nozzles_mk2",
    name: "Thruster Nozzles Mk2",
    uiDesc: "Significantly faster acceleration + much higher top speed",
    slot: "propulsion",
    type: "module",
    effects: [
      { key: "ship.accelerationMultiplier", op: "multiply", value: 1.25 },
      { key: "ship.maxSpeedMultiplier", op: "multiply", value: 1.40 },
    ],
    recipe: { silicates: 400, fe_ni_metal: 400, carbon: 30, sulfur: 50, helium_3: 25 },
  },

  // =========================================================================
  // UTILITY SLOT — Branch A (Spectral sub-branch)
  // =========================================================================
  {
    id: "module_assay_enhancer_mk1",
    name: "Assay Enhancer Mk1",
    uiDesc: "Improved assay sample recovery from mining",
    slot: "utility",
    type: "module",
    effects: [
      { key: "mining.assaySampleBonusChance", op: "add", value: 0.20 },
    ],
    recipe: { silicates: 150, fe_ni_metal: 60, carbon: 50, sulfur: 20, hydrates: 40 },
  },

  // =========================================================================
  // CONSUMABLES — Branch A (Survey)
  // =========================================================================
  {
    id: "consumable_assay_probe",
    name: "Assay Probe",
    uiDesc: "Shows locked target's full resource breakdown before mining",
    slot: "utility",
    type: "consumable",
    stackMax: 10,
    recipe: { silicates: 60, carbon: 20, hydrates: 15 },
  },
  {
    id: "consumable_scanner_pulse",
    name: "Scanner Pulse",
    uiDesc: "Enhanced sensor sweep reveals additional asteroid data for 30s",
    slot: "utility",
    type: "consumable",
    useDurationS: 30,
    stackMax: 10,
    recipe: { silicates: 80, fe_ni_metal: 30, carbon: 15 },
  },
  {
    id: "consumable_composition_scan",
    name: "Composition Scan",
    uiDesc: "All asteroids in range show their type for 30s",
    slot: "utility",
    type: "consumable",
    useDurationS: 30,
    stackMax: 10,
    recipe: { silicates: 100, carbon: 30, hydrates: 25 },
  },
  {
    id: "consumable_deep_scan_probe",
    name: "Deep Scan Probe",
    uiDesc: "Complete data on all asteroids in a large radius for 60s",
    slot: "utility",
    type: "consumable",
    useDurationS: 60,
    stackMax: 5,
    recipe: { silicates: 120, fe_ni_metal: 50, carbon: 40, hydrates: 30 },
  },

  // =========================================================================
  // CONSUMABLES — Branch B (Extraction)
  // =========================================================================
  {
    id: "consumable_overclock_charge",
    name: "Overclock Charge",
    uiDesc: "Mining speed +30% for 20s",
    slot: "utility",
    type: "consumable",
    useEffects: [
      { key: "mining.timePerAsteroidMultiplier", op: "multiply", value: 0.70 },
    ],
    useDurationS: 20,
    stackMax: 10,
    recipe: { silicates: 80, carbon: 20, sulfur: 15 },
  },
  {
    id: "consumable_precision_charge",
    name: "Precision Charge",
    uiDesc: "Guarantees bonus resource yield from current mining target",
    slot: "utility",
    type: "consumable",
    stackMax: 5,
    recipe: { silicates: 100, fe_ni_metal: 30, sulfur: 25 },
  },
  {
    id: "consumable_heat_sink_cartridge",
    name: "Heat Sink Cartridge",
    uiDesc: "Emergency heat dump — vents significant laser heat instantly",
    slot: "utility",
    type: "consumable",
    useEffects: [
      { key: "mining.currentHeat", op: "add", value: -0.5 },
    ],
    stackMax: 10,
    recipe: { silicates: 90, carbon: 30, sulfur: 8 },
  },
  {
    id: "consumable_thermal_purge",
    name: "Thermal Purge Charge",
    uiDesc: "Complete heat reset — more potent than standard heat sinks",
    slot: "utility",
    type: "consumable",
    useEffects: [
      { key: "mining.currentHeat", op: "set", value: 0.0 },
    ],
    stackMax: 5,
    recipe: { silicates: 150, carbon: 40, sulfur: 25 },
  },

  // =========================================================================
  // CONSUMABLES — Branch C (Ship Systems)
  // =========================================================================
  {
    id: "consumable_hull_patch_kit",
    name: "Hull Patch Kit",
    uiDesc: "Field repair: restores 15 hull HP",
    slot: "utility",
    type: "consumable",
    useEffects: [
      { key: "ship.currentHealth", op: "add", value: 15 },
    ],
    stackMax: 10,
    recipe: { silicates: 100, fe_ni_metal: 60, sulfur: 10 },
  },
  {
    id: "consumable_emergency_repair_kit",
    name: "Emergency Repair Kit",
    uiDesc: "Substantial hull restoration: restores 30 hull HP",
    slot: "utility",
    type: "consumable",
    useEffects: [
      { key: "ship.currentHealth", op: "add", value: 30 },
    ],
    stackMax: 5,
    recipe: { silicates: 180, fe_ni_metal: 120, sulfur: 20 },
  },
  {
    id: "consumable_afterburner_charge",
    name: "Afterburner Charge",
    uiDesc: "Speed +50% for 8s",
    slot: "utility",
    type: "consumable",
    useEffects: [
      { key: "ship.maxSpeedMultiplier", op: "multiply", value: 1.50 },
      { key: "ship.accelerationMultiplier", op: "multiply", value: 1.50 },
    ],
    useDurationS: 8,
    stackMax: 5,
    recipe: { silicates: 80, fe_ni_metal: 60, sulfur: 15 },
  },

  // =========================================================================
  // SPECIAL ITEMS
  // =========================================================================
  {
    id: "special_transit_drive",
    name: "Interplanetary Transit Drive",
    uiDesc: "Enables fast transit to the Moon",
    slot: "utility",
    type: "special",
    recipe: { silicates: 800, fe_ni_metal: 600, carbon: 200, sulfur: 100, hydrates: 50 },
  },
];

// ---------------------------------------------------------------------------
// Research nodes
// ---------------------------------------------------------------------------

/** IDs of all tier-2 research nodes (used for milestone prerequisite check). */
export const TIER_2_NODE_IDS = [
  "a2a_active_scanning",
  "a2b_spectral_analysis",
  "b2a_beam_optimization",
  "b2b_thermal_dynamics",
  "c2a_hull_reinforcement",
  "c2b_propulsion_systems",
] as const;

export const RESEARCH_NODES: ResearchNodeDef[] = [
  // ── Root ──────────────────────────────────────────────────────────────────
  {
    id: "r0_microlab_boot",
    name: "MicroLab Boot Sequence",
    desc: "Initialize onboard analysis lab. ESA uplink handshake, assay framework bootstrap",
    durationSeconds: 45,
    costs: { assaySamples: 1 },
    prerequisites: [],
    unlocks: {
      research: [
        "a1_sensor_calibration",
        "b1_laser_optics",
        "c1_structural_engineering",
      ],
    },
  },

  // ── Branch A: Survey & Detection ──────────────────────────────────────────
  {
    id: "a1_sensor_calibration",
    name: "Sensor Calibration",
    desc: "Refine the sensor array to interpret asteroid return signals more precisely",
    durationSeconds: 90,
    costs: { assaySamples: 2 },
    prerequisites: ["r0_microlab_boot"],
    researchEffects: [
      { key: "scanner.lockSpeedMultiplier", op: "multiply", value: 0.85 },
    ],
    unlocks: {
      items: ["module_prospector_scanner_mk1", "consumable_assay_probe"],
      research: ["a2a_active_scanning", "a2b_spectral_analysis"],
    },
  },
  {
    id: "a2a_active_scanning",
    name: "Active Scanning",
    desc: "Develop wide-angle active ping for rapid field survey and asteroid detection",
    durationSeconds: 180,
    costs: { assaySamples: 5 },
    prerequisites: ["a1_sensor_calibration"],
    researchEffects: [
      { key: "mining.yieldMultiplier", op: "multiply", value: 1.05 },
    ],
    unlocks: {
      items: ["module_ping_array_mk1", "consumable_scanner_pulse"],
      research: ["a3_integrated_survey"],
    },
  },
  {
    id: "a2b_spectral_analysis",
    name: "Spectral Analysis",
    desc: "Map spectral signatures to resolve composition bands during target analysis",
    durationSeconds: 200,
    costs: { assaySamples: 6 },
    prerequisites: ["a1_sensor_calibration"],
    researchEffects: [
      { key: "mining.assaySampleBonusChance", op: "add", value: 0.15 },
    ],
    unlocks: {
      items: ["module_spectral_mapper_mk1", "module_assay_enhancer_mk1", "consumable_composition_scan"],
      research: ["a3_integrated_survey"],
    },
  },
  {
    id: "a3_integrated_survey",
    name: "Integrated Survey Suite",
    desc: "Fuse active and spectral systems into a unified deep-field survey platform",
    durationSeconds: 360,
    costs: { assaySamples: 12 },
    prerequisites: ["a2a_active_scanning", "a2b_spectral_analysis"],
    researchEffects: [
      { key: "scanner.allRangeMultiplier", op: "multiply", value: 1.20 },
    ],
    unlocks: {
      items: ["module_integrated_sensor_suite", "consumable_deep_scan_probe"],
    },
  },

  // ── Branch B: Extraction Engineering ──────────────────────────────────────
  {
    id: "b1_laser_optics",
    name: "Laser Optics Calibration",
    desc: "Recalibrate mining laser optics for tighter coherence and faster ablation",
    durationSeconds: 90,
    costs: { assaySamples: 2 },
    prerequisites: ["r0_microlab_boot"],
    researchEffects: [
      { key: "mining.timePerAsteroidMultiplier", op: "multiply", value: 0.95 },
    ],
    unlocks: {
      items: ["module_beam_focuser_mk1", "consumable_overclock_charge"],
      research: ["b2a_beam_optimization", "b2b_thermal_dynamics"],
    },
  },
  {
    id: "b2a_beam_optimization",
    name: "Beam Optimization",
    desc: "Optimize laser pulse shaping for maximum energy-to-ablation efficiency",
    durationSeconds: 200,
    costs: { assaySamples: 6 },
    prerequisites: ["b1_laser_optics"],
    researchEffects: [
      { key: "mining.timePerAsteroidMultiplier", op: "multiply", value: 0.92 },
    ],
    unlocks: {
      items: ["module_beam_focuser_mk2", "module_yield_extractor_mk1", "consumable_precision_charge"],
      research: ["b3_pulse_extraction"],
    },
  },
  {
    id: "b2b_thermal_dynamics",
    name: "Thermal Dynamics",
    desc: "Develop thermal routing and emergency heat-dump procedures for sustained extraction",
    durationSeconds: 220,
    costs: { assaySamples: 7 },
    prerequisites: ["b1_laser_optics"],
    researchEffects: [
      { key: "mining.heatBuildUpRateMultiplier", op: "multiply", value: 0.90 },
    ],
    unlocks: {
      items: ["module_radiator_strips_mk1", "module_coolant_circulator_mk1", "consumable_heat_sink_cartridge"],
      research: ["b3_pulse_extraction"],
    },
  },
  {
    id: "b3_pulse_extraction",
    name: "Pulse Extraction Firmware",
    desc: "Develop pulsed extraction firmware for thermally stable, continuous mining",
    durationSeconds: 400,
    costs: { assaySamples: 14 },
    prerequisites: ["b2a_beam_optimization", "b2b_thermal_dynamics"],
    researchEffects: [
      { key: "mining.overallEfficiencyMultiplier", op: "multiply", value: 1.10 },
    ],
    unlocks: {
      items: ["module_pulse_modulator_mk1", "module_radiator_strips_mk2", "consumable_thermal_purge"],
    },
  },

  // ── Branch C: Ship Systems ────────────────────────────────────────────────
  {
    id: "c1_structural_engineering",
    name: "Structural Engineering",
    desc: "Analyze hull stress patterns for field-fabricated structural integration",
    durationSeconds: 90,
    costs: { assaySamples: 2 },
    prerequisites: ["r0_microlab_boot"],
    researchEffects: [
      { key: "ship.cargoCapacity", op: "add", value: 100 },
    ],
    unlocks: {
      items: ["module_cargo_rack_mk1", "consumable_hull_patch_kit"],
      research: ["c2a_hull_reinforcement", "c2b_propulsion_systems"],
    },
  },
  {
    id: "c2a_hull_reinforcement",
    name: "Hull Reinforcement",
    desc: "Engineer composite plating and damage absorption systems for collision survivability",
    durationSeconds: 210,
    costs: { assaySamples: 6 },
    prerequisites: ["c1_structural_engineering"],
    researchEffects: [
      { key: "ship.maxHealthMultiplier", op: "multiply", value: 1.05 },
    ],
    unlocks: {
      items: ["module_ablative_plating_mk1", "module_cargo_rack_mk2", "consumable_emergency_repair_kit"],
      research: ["c3_integrated_platform"],
    },
  },
  {
    id: "c2b_propulsion_systems",
    name: "Propulsion Systems",
    desc: "Optimize RCS authority and main nozzle efficiency for improved flight handling",
    durationSeconds: 240,
    costs: { assaySamples: 7 },
    prerequisites: ["c1_structural_engineering"],
    researchEffects: [
      { key: "ship.maxSpeedMultiplier", op: "multiply", value: 1.10 },
    ],
    unlocks: {
      items: ["module_reaction_wheels_mk1", "module_thruster_nozzles_mk1", "consumable_afterburner_charge"],
      research: ["c3_integrated_platform"],
    },
  },
  {
    id: "c3_integrated_platform",
    name: "Integrated Ship Platform",
    desc: "Full platform integration: structural, propulsion, and autonomous repair systems",
    durationSeconds: 420,
    costs: { assaySamples: 14 },
    prerequisites: ["c2a_hull_reinforcement", "c2b_propulsion_systems"],
    researchEffects: [
      { key: "ship.maxHealthMultiplier", op: "multiply", value: 1.05 },
      { key: "ship.maxSpeedMultiplier", op: "multiply", value: 1.05 },
      { key: "ship.accelerationMultiplier", op: "multiply", value: 1.05 },
      { key: "ship.decelerationMultiplier", op: "multiply", value: 1.05 },
    ],
    unlocks: {
      items: ["module_ablative_plating_mk2", "module_thruster_nozzles_mk2", "module_nanite_repair_mk1"],
    },
  },

  // ── Milestone ─────────────────────────────────────────────────────────────
  {
    id: "m1_transit_drive",
    name: "Transit Drive Calibration",
    desc: "Calibrate interplanetary transit drive parameters for sustained high-delta-v burns",
    durationSeconds: 300,
    costs: { assaySamples: 10 },
    prerequisites: [],
    prerequisiteRule: {
      type: "anyN",
      nodes: [...TIER_2_NODE_IDS],
      count: 3,
    },
    unlocks: {
      items: ["special_transit_drive"],
    },
  },
];

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

export function getResearchNode(id: string): ResearchNodeDef | undefined {
  return _nodeMap.get(id);
}

/** All items grouped by slot. */
export function getItemsBySlot(slot: ItemSlot): ItemDef[] {
  return ITEMS.filter((i) => i.slot === slot);
}

/**
 * Returns the icon image URL for an item, derived from its type and id.
 * Modules live in /assets/modules/, consumables in /assets/consumables/.
 */
export function getItemIconUrl(item: Pick<ItemDef, "id" | "type">): string {
  if (item.type === "special") return `/assets/modules/${item.id}.png`;
  const folder = item.type === "consumable" ? "consumables" : "modules";
  return `/assets/${folder}/${item.id}.png`;
}

/** All slots that have at least one item defined. */
export const ALL_ITEM_SLOTS: ItemSlot[] = [
  "scanner",
  "mining",
  "cooling",
  "cargo",
  "hull",
  "propulsion",
  "utility",
];

/** Readable slot labels for UI. */
export const SLOT_LABELS: Record<ItemSlot, string> = {
  scanner: "Scanner",
  mining: "Mining",
  cooling: "Cooling",
  cargo: "Cargo",
  hull: "Hull",
  propulsion: "Propulsion",
  utility: "Utility",
};

// ---------------------------------------------------------------------------
// Human-readable effect descriptions
// ---------------------------------------------------------------------------

const EFFECT_DESCRIPTIONS: Record<string, (value: number | boolean, op: string) => string> = {
  "scanner.lockShowsAsteroidType": () => "Target lock reveals asteroid type (S/C/X)",
  "scanner.pingHighlightEnabled": () => "Active ping highlights nearby asteroids",
  "scanner.pingHighlightRangeMultiplier": (v, op) =>
    op === "multiply" ? `Ping range ${fmtPct(v as number)}` : `Ping range +${v}`,
  "scanner.lockShowsCompositionBands": () => "Target lock shows composition bands",
  "scanner.lockShowsYieldEstimate": () => "Target lock shows yield estimate",
  "scanner.lockSpeedMultiplier": (v) => `Target lock speed ${fmtPct(v as number)}`,
  "scanner.allRangeMultiplier": (v) => `All sensor ranges ${fmtPct(v as number)}`,
  "ship.cargoCapacity": (v) => `Cargo capacity +${v} units`,
  "mining.timePerAsteroidMultiplier": (v) =>
    `Mining time ${fmtPct(v as number)}`,
  "mining.heatBuildUpRateMultiplier": (v) =>
    `Heat buildup ${fmtPct(v as number)}`,
  "mining.yieldMultiplier": (v) => `Mining yield ${fmtPct(v as number)}`,
  "mining.assaySampleBonusChance": (v, op) =>
    op === "add" ? `Assay sample bonus +${Math.round((v as number) * 100)}%` : `Assay bonus ${fmtPct(v as number)}`,
  "mining.cooldownSpeedMultiplier": (v) =>
    `Cooldown recovery ${fmtPct(v as number)}`,
  "mining.overallEfficiencyMultiplier": (v) =>
    `Overall mining efficiency ${fmtPct(v as number)}`,
  "ship.maxHealthMultiplier": (v) => `Max hull HP ${fmtPct(v as number)}`,
  "ship.collisionDamageMultiplier": (v) =>
    `Collision damage ${fmtPct(v as number)}`,
  "ship.hullRegenPerSecond": (v) => `Hull regen +${v} HP/s`,
  "ship.decelerationMultiplier": (v) =>
    `Braking power ${fmtPct(v as number)}`,
  "ship.accelerationMultiplier": (v) =>
    `Acceleration ${fmtPct(v as number)}`,
  "ship.maxSpeedMultiplier": (v) => `Top speed ${fmtPct(v as number)}`,
  "ability.pulseMiningEnabled": () => "Unlocks Pulse Mining mode",
  "mining.currentHeat": (v, op) =>
    op === "add"
      ? `Heat ${(v as number) > 0 ? "+" : ""}${Math.round((v as number) * 100)}%`
      : op === "set"
        ? v === 0 ? "Full heat reset" : `Set heat to ${Math.round((v as number) * 100)}%`
        : op === "multiply"
          ? `Heat ×${v} (${Math.round((1 - (v as number)) * 100)}% reduction)`
          : `Set heat to ${v}`,
  "ship.currentHealth": (v, op) =>
    op === "add"
      ? `Restore ${v} hull HP`
      : `Set hull HP to ${v}`,
};

function fmtPct(multiplier: number): string {
  const pct = Math.round((multiplier - 1) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

/**
 * Returns a human-readable description of an item effect.
 */
export function describeEffect(eff: { key: string; op: string; value: number | boolean }): string {
  const fn = EFFECT_DESCRIPTIONS[eff.key];
  if (fn) return fn(eff.value, eff.op);

  // Fallback: auto-format from key
  const label = eff.key.split(".").pop() ?? eff.key;
  if (eff.op === "set") return `${label}: ${eff.value ? "ON" : "OFF"}`;
  if (eff.op === "multiply") return `${label} ${fmtPct(eff.value as number)}`;
  if (eff.op === "add") return `${label} +${eff.value}`;
  return `${label}: ${eff.value}`;
}

/**
 * Check if a research node's prerequisites are satisfied.
 * Handles both standard prerequisites and special prerequisiteRule.
 */
export function arePrerequisitesMet(node: ResearchNodeDef, completedNodes: Set<string>): boolean {
  // Check standard prerequisites
  if (!node.prerequisites.every((p) => completedNodes.has(p))) return false;

  // Check special prerequisite rule
  if (node.prerequisiteRule) {
    const { type, nodes, count } = node.prerequisiteRule;
    if (type === "anyN") {
      const completed = nodes.filter((n) => completedNodes.has(n)).length;
      if (completed < count) return false;
    }
  }

  return true;
}
