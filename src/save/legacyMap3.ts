/**
 * Frozen legacy-id tables for the schema 2 → 3 migration (M3.3/M3.4). Part of a shipped
 * migration: never edit; a later catalogue change appends its own table and migration.
 */

/** Research option ids of the schema-3 catalogue (a v2 save never holds these). */
export const V3_NODE_IDS: readonly string[] = [
  "sv1_composition_survey", "sv2_volatile_mapping", "ex1_controlled_extraction", "ex2_yield_analysis", "th1_heat_rejection",
  "lg1_bulk_handling", "pr1_transit_calibration", "pr2_thruster_tuning", "hl1_hull_reinforcement", "ln1_survey_salvage",
];

/** Old node → new options it grants. `[]` = retired with nothing to map (basic analysis is free). */
export const LEGACY_RESEARCH_MAP: Readonly<Record<string, readonly string[]>> = {
  r0_microlab_boot: [],
  a1_sensor_calibration: ["sv1_composition_survey"],
  a2a_active_scanning: ["sv2_volatile_mapping"],
  a2b_spectral_analysis: ["sv1_composition_survey"],
  a3_integrated_survey: ["sv2_volatile_mapping"],
  b1_laser_optics: ["ex1_controlled_extraction"],
  b2a_beam_optimization: ["ex2_yield_analysis"],
  b2b_thermal_dynamics: ["th1_heat_rejection"],
  b3_pulse_extraction: ["th1_heat_rejection", "ex2_yield_analysis"],
  c1_structural_engineering: ["lg1_bulk_handling"],
  c2a_hull_reinforcement: ["hl1_hull_reinforcement"],
  c2b_propulsion_systems: ["pr2_thruster_tuning"],
  c3_integrated_platform: ["hl1_hull_reinforcement", "pr2_thruster_tuning"],
  m1_transit_drive: ["pr1_transit_calibration"],
};

/** Slot of every schema-3 module/special (equip remapping). */
export const V3_ITEM_SLOTS: Readonly<Record<string, string>> = {
  module_prospector_scanner_mk1: "scanner",
  module_ping_array_mk1: "scanner",
  module_integrated_sensor_suite: "scanner",
  module_beam_focuser_mk1: "mining",
  module_yield_extractor_mk1: "mining",
  module_radiator_strips_mk1: "cooling",
  module_coolant_circulator_mk1: "cooling",
  module_cargo_rack_mk1: "cargo",
  module_aux_tank_mk1: "cargo",
  module_electrolysis_cell_mk1: "utility",
  module_thruster_nozzles_mk1: "propulsion",
  module_ablative_plating_mk1: "hull",
  module_nanite_repair_mk1: "hull",
  special_transit_drive: "utility",
};

/** Old owned module/special → schema-3 id, or null = retired (kept as an inert legacy record). */
export const LEGACY_ITEM_MAP: Readonly<Record<string, string | null>> = {
  module_prospector_scanner_mk1: "module_prospector_scanner_mk1",
  module_ping_array_mk1: "module_ping_array_mk1",
  module_spectral_mapper_mk1: "module_prospector_scanner_mk1",
  module_integrated_sensor_suite: "module_integrated_sensor_suite",
  module_beam_focuser_mk1: "module_beam_focuser_mk1",
  module_beam_focuser_mk2: "module_beam_focuser_mk1",
  module_yield_extractor_mk1: "module_yield_extractor_mk1",
  module_pulse_modulator_mk1: "module_coolant_circulator_mk1",
  module_radiator_strips_mk1: "module_radiator_strips_mk1",
  module_radiator_strips_mk2: "module_radiator_strips_mk1",
  module_coolant_circulator_mk1: "module_coolant_circulator_mk1",
  module_cargo_rack_mk1: "module_cargo_rack_mk1",
  module_cargo_rack_mk2: "module_cargo_rack_mk1",
  module_ablative_plating_mk1: "module_ablative_plating_mk1",
  module_ablative_plating_mk2: "module_ablative_plating_mk1",
  module_nanite_repair_mk1: "module_nanite_repair_mk1",
  module_reaction_wheels_mk1: "module_thruster_nozzles_mk1",
  module_thruster_nozzles_mk1: "module_thruster_nozzles_mk1",
  module_thruster_nozzles_mk2: "module_thruster_nozzles_mk1",
  module_assay_enhancer_mk1: null,
  special_transit_drive: "special_transit_drive",
};

/** Old consumable → schema-3 consumable and units per old unit, or null = retired (count kept inert). */
export const LEGACY_CONSUMABLE_MAP: Readonly<Record<string, { to: string; per: number } | null>> = {
  consumable_assay_probe: null,
  consumable_scanner_pulse: null,
  consumable_composition_scan: null,
  consumable_deep_scan_probe: null,
  consumable_overclock_charge: null,
  consumable_precision_charge: null,
  consumable_afterburner_charge: null,
  consumable_heat_sink_cartridge: { to: "consumable_heat_sink_cartridge", per: 1 },
  consumable_thermal_purge: { to: "consumable_heat_sink_cartridge", per: 1 },
  consumable_hull_patch_kit: { to: "consumable_hull_patch_kit", per: 1 },
  consumable_emergency_repair_kit: { to: "consumable_hull_patch_kit", per: 2 },
};

/** Stack limit of the schema-3 consumables; mapped counts above it stay inert in legacy. */
export const V3_STACK_MAX: Readonly<Record<string, number>> = {
  consumable_heat_sink_cartridge: 10,
  consumable_hull_patch_kit: 10,
};
