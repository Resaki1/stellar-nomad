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

export type ItemType = "module" | "consumable";

/**
 * A passive effect applied while a module is equipped.
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
  /** Cooldown between uses in seconds (consumables only). */
  cooldownS?: number;
  /** Max stack size (consumables only). */
  stackMax?: number;
  /** Crafting recipe: resourceId → amount required. */
  recipe: Record<string, number>;
};

export type ResearchNodeDef = {
  id: string;
  name: string;
  desc: string;
  durationSeconds: number;
  costs: { assaySamples: number };
  prerequisites: string[];
  unlocks: {
    items?: string[];
    research?: string[];
  };
};

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const ITEMS: ItemDef[] = [
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
    uiDesc: "Active ping highlights nearby targetable asteroids (no type info)",
    slot: "scanner",
    type: "module",
    effects: [
      { key: "scanner.pingHighlightEnabled", op: "set", value: true },
      { key: "scanner.pingHighlightRangeMultiplier", op: "multiply", value: 1.15 },
    ],
    recipe: { silicates: 260, fe_ni_metal: 90, carbon: 25, sulfur: 15 },
  },
  {
    id: "module_cargo_rack_mk1",
    name: "Cargo Rack Mk1",
    uiDesc: "More cargo space!",
    slot: "cargo",
    type: "module",
    effects: [{ key: "ship.cargoCapacity", op: "add", value: 400 }],
    recipe: { silicates: 300, fe_ni_metal: 100, sulfur: 10 },
  },
  {
    id: "module_beam_focuser_mk1",
    name: "Beam Focuser Mk1",
    uiDesc: "Faster mining per asteroid",
    slot: "mining",
    type: "module",
    effects: [
      { key: "mining.timePerAsteroidMultiplier", op: "multiply", value: 0.85 },
    ],
    recipe: { silicates: 380, fe_ni_metal: 70, carbon: 20, sulfur: 8 },
  },
  {
    id: "module_radiator_strips_mk1",
    name: "Radiator Strips Mk1",
    uiDesc: "Mine longer before overheating",
    slot: "cooling",
    type: "module",
    effects: [
      { key: "mining.heatBuildUpRateMultiplier", op: "multiply", value: 0.8 },
    ],
    recipe: { silicates: 420, fe_ni_metal: 60, carbon: 20, sulfur: 12 },
  },
  {
    id: "consumable_heat_sink_cartridge",
    name: "Heat Sink Cartridge",
    uiDesc: "Emergency heat dump — consumes one cartridge",
    slot: "utility",
    type: "consumable",
    useEffects: [
      { key: "mining.currentHeat", op: "add", value: -0.5 },
    ],
    stackMax: 10,
    recipe: { silicates: 90, carbon: 30, sulfur: 8 },
  },
  {
    id: "module_ablative_plating_mk1",
    name: "Ablative Hull Plating Mk1",
    uiDesc: "More hull HP, collisions hurt less",
    slot: "hull",
    type: "module",
    effects: [
      { key: "ship.maxHealthMultiplier", op: "multiply", value: 1.25 },
      { key: "ship.collisionDamageMultiplier", op: "multiply", value: 0.9 },
    ],
    recipe: { silicates: 350, fe_ni_metal: 140, carbon: 25, sulfur: 10 },
  },
  {
    id: "module_reaction_wheels_mk1",
    name: "Reaction Wheel Array Mk1",
    uiDesc: "Better control + stronger braking feel",
    slot: "propulsion",
    type: "module",
    effects: [
      { key: "ship.decelerationMultiplier", op: "multiply", value: 1.15 },
    ],
    recipe: { silicates: 180, fe_ni_metal: 150, carbon: 10, sulfur: 12 },
  },
  {
    id: "module_thruster_nozzles_mk1",
    name: "Thruster Nozzles Mk1",
    uiDesc: "Faster acceleration + slightly higher top speed",
    slot: "propulsion",
    type: "module",
    effects: [
      { key: "ship.accelerationMultiplier", op: "multiply", value: 1.12 },
      { key: "ship.maxSpeedMultiplier", op: "multiply", value: 2.0 },
    ],
    recipe: { silicates: 260, fe_ni_metal: 190, carbon: 15, sulfur: 18 },
  },
  {
    id: "module_pulse_modulator_mk1",
    name: "Pulse Modulator Mk1",
    uiDesc: "Unlock Pulse Mining mode (safer thermals, slower peak rate)",
    slot: "mining",
    type: "module",
    effects: [
      { key: "ability.pulseMiningEnabled", op: "set", value: true },
    ],
    recipe: { silicates: 210, fe_ni_metal: 55, carbon: 15, sulfur: 15 },
  },
  {
    id: "module_spectral_mapper_mk1",
    name: "Spectral Mapper Mk1",
    uiDesc: "Target lock shows rough composition bands (metal / hydrate / carbon rich)",
    slot: "scanner",
    type: "module",
    effects: [
      { key: "scanner.lockShowsCompositionBands", op: "set", value: true },
    ],
    recipe: { silicates: 420, fe_ni_metal: 110, carbon: 55, sulfur: 18, hydrates: 20 },
  },
];

// ---------------------------------------------------------------------------
// Research nodes
// ---------------------------------------------------------------------------

export const RESEARCH_NODES: ResearchNodeDef[] = [
  {
    id: "r0_microlab_boot",
    name: "MicroLab Boot Sequence",
    desc: "Onboard lab online, ESA uplink handshake, blueprint validation pipeline",
    durationSeconds: 45,
    costs: { assaySamples: 1 },
    prerequisites: [],
    unlocks: {
      research: [
        "r1_prospector_algorithms",
        "r1_modular_hardpoints",
        "r1_laser_optics",
      ],
    },
  },
  {
    id: "r1_prospector_algorithms",
    name: "Prospector Algorithms",
    desc: "Classify asteroid type from sensor returns (S/C/X)",
    durationSeconds: 90,
    costs: { assaySamples: 2 },
    prerequisites: ["r0_microlab_boot"],
    unlocks: {
      items: ["module_prospector_scanner_mk1"],
      research: ["r2_wide_angle_ping", "r3_spectral_mapping"],
    },
  },
  {
    id: "r1_modular_hardpoints",
    name: "Modular Hardpoints",
    desc: "Standardized mounts + power/data bus, quick module integration",
    durationSeconds: 90,
    costs: { assaySamples: 2 },
    prerequisites: ["r0_microlab_boot"],
    unlocks: {
      items: ["module_cargo_rack_mk1"],
      research: ["r2_ablative_plating", "r2_attitude_thrust"],
    },
  },
  {
    id: "r1_laser_optics",
    name: "Laser Optics Calibration",
    desc: "Improved coherence/focus, faster ablation stability",
    durationSeconds: 120,
    costs: { assaySamples: 3 },
    prerequisites: ["r0_microlab_boot"],
    unlocks: {
      items: ["module_beam_focuser_mk1"],
      research: ["r2_thermal_management"],
    },
  },
  {
    id: "r2_wide_angle_ping",
    name: "Wide-Angle Targeting Ping",
    desc: "Active ping, highlight nearby targetable asteroids",
    durationSeconds: 180,
    costs: { assaySamples: 6 },
    prerequisites: ["r1_prospector_algorithms"],
    unlocks: {
      items: ["module_ping_array_mk1"],
    },
  },
  {
    id: "r2_thermal_management",
    name: "Thermal Management Basics",
    desc: "Radiator routing + emergency dump procedures for sustained mining",
    durationSeconds: 240,
    costs: { assaySamples: 7 },
    prerequisites: ["r1_laser_optics"],
    unlocks: {
      items: ["module_radiator_strips_mk1", "consumable_heat_sink_cartridge"],
      research: ["r3_pulse_extraction_firmware"],
    },
  },
  {
    id: "r2_ablative_plating",
    name: "Ablative Composite Plating",
    desc: "Sacrificial outer layer, collision survivability",
    durationSeconds: 210,
    costs: { assaySamples: 6 },
    prerequisites: ["r1_modular_hardpoints"],
    unlocks: {
      items: ["module_ablative_plating_mk1"],
    },
  },
  {
    id: "r2_attitude_thrust",
    name: "Attitude & Thrust Control",
    desc: "Improved control authority, nozzle efficiency, flight handling",
    durationSeconds: 300,
    costs: { assaySamples: 8 },
    prerequisites: ["r1_modular_hardpoints"],
    unlocks: {
      items: ["module_reaction_wheels_mk1", "module_thruster_nozzles_mk1"],
    },
  },
  {
    id: "r3_pulse_extraction_firmware",
    name: "Pulse Extraction Firmware",
    desc: "Pulse mode parameters, thermal stability, controlled extraction",
    durationSeconds: 360,
    costs: { assaySamples: 10 },
    prerequisites: ["r2_thermal_management"],
    unlocks: {
      items: ["module_pulse_modulator_mk1"],
    },
  },
  {
    id: "r3_spectral_mapping",
    name: "Spectral Mapping",
    desc: "Rough composition bands on target lock (metal/hydrate/carbon rich)",
    durationSeconds: 360,
    costs: { assaySamples: 10 },
    prerequisites: ["r1_prospector_algorithms"],
    unlocks: {
      items: ["module_spectral_mapper_mk1"],
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
  "ship.cargoCapacity": (v) => `Cargo capacity +${v} units`,
  "mining.timePerAsteroidMultiplier": (v) =>
    `Mining time ${fmtPct(v as number)}`,
  "mining.heatBuildUpRateMultiplier": (v) =>
    `Heat buildup ${fmtPct(v as number)}`,
  "ship.maxHealthMultiplier": (v) => `Max hull HP ${fmtPct(v as number)}`,
  "ship.collisionDamageMultiplier": (v) =>
    `Collision damage ${fmtPct(v as number)}`,
  "ship.decelerationMultiplier": (v) =>
    `Braking power ${fmtPct(v as number)}`,
  "ship.accelerationMultiplier": (v) =>
    `Acceleration ${fmtPct(v as number)}`,
  "ship.maxSpeedMultiplier": (v) => `Top speed ${fmtPct(v as number)}`,
  "ability.pulseMiningEnabled": () => "Unlocks Pulse Mining mode",
  "mining.currentHeat": (v, op) =>
    op === "add"
      ? `Heat ${(v as number) > 0 ? "+" : ""}${Math.round((v as number) * 100)}%`
      : op === "multiply"
        ? `Heat ×${v} (${Math.round((1 - (v as number)) * 100)}% reduction)`
        : `Set heat to ${v}`,
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
