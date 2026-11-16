// ---------------------------------------------------------------------------
// Comms message definitions
// ---------------------------------------------------------------------------

export type CommsAccent = "comms" | "info" | "signal" | "ok" | "warn" | "crit";

export interface CommsMessage {
  messageId: string;
  speaker: string;
  /** Each entry is one page of text shown in the overlay. */
  textContent: string[];
  audioClip?: string;
  /** Path to a square avatar image (relative to /public). If omitted, a "?" placeholder is shown. */
  avatar?: string;
  /** 1 = low, 2 = medium, 3 = high — higher values jump the queue */
  priority: number;
  /** Seconds to wait after the trigger fires before the message enters the queue. */
  delaySec?: number;
  /** Accent color token for rules, avatar rim, and speaker name. Defaults to "comms". */
  accent?: CommsAccent;
}

// ---------------------------------------------------------------------------
// Message catalogue — add new messages here
// ---------------------------------------------------------------------------

/**
 * Dynamic placeholder: `{{AI_NAME}}` in textContent or speaker fields is
 * replaced at render time with the player-chosen AI name.
 */
export const COMMS_MESSAGES: Record<string, CommsMessage> = {
  // == OPENING SEQUENCE =====================================================

  // -- AI greeting (fires on first load, before naming) ---------------------
  ai_greeting_001: {
    messageId: "ai_greeting_001",
    speaker: "Ship AI",
    textContent: [
      "... core systems initializing. Life support: Active. Reactor: Stable. Navigation arrays: Online.",
      "Post-hibernation diagnostics are green across the board. You've been under for 247 days. Welcome back.",
      "I don't have a name yet. Standard procedure is for the mission commander to assign one. That would be you.",
    ],
    priority: 3,
  },

  // -- AI introduction (fires after the player names the AI) ----------------
  ai_intro_001: {
    messageId: "ai_intro_001",
    speaker: "{{AI_NAME}}",
    textContent: [
      "{{AI_NAME}}. Running name through all system identifiers... done. {{AI_NAME}}, fully operational.",
      "Initiating ESA Ground Control uplink. Signal propagation is clean. Should have a connection shortly.",
    ],
    priority: 3,
  },

  // == TUTORIAL BEATS =======================================================

  // -- First mining completion ----------------------------------------------
  mining_001: {
    messageId: "mining_001",
    speaker: "{{AI_NAME}}",
    delaySec: 2,
    textContent: [
      "Extraction complete. Cargo intake confirmed, and I logged what came out of it.",
      "Before you cut the next one, hold a lock and run a close inspection. It tells us what is inside and roughly how much, and every new material we confirm opens up research options.",
    ],
    priority: 1,
  },

  // -- First hull damage ----------------------------------------------------
  first_damage_001: {
    messageId: "first_damage_001",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Hull impact. Structural integrity is holding, but that's the kind of thing that adds up.",
      "Asteroid fields at speed are... unforgiving. Something to keep in mind.",
    ],
    priority: 2,
  },

  // -- Cargo hold full ------------------------------------------------------
  cargo_full_001: {
    messageId: "cargo_full_001",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Cargo hold is at capacity. Can't take on more material until you free up space.",
      "You could put some of it toward fabrication or processing. Or jettison what you don't need, though once it's gone, it's gone.",
    ],
    priority: 1,
  },

  // -- MicroLab research started --------------------------------------------

  // -- First module/item crafted --------------------------------------------
  first_craft_001: {
    messageId: "first_craft_001",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Fabrication complete. Integration checks passed. Already reading the performance delta in ship telemetry.",
      "Not bad for field-improvised engineering 400,000 kilometers from the nearest workshop.",
    ],
    priority: 1,
  },

  // == STORY & CHARACTER BEATS ==============================================

  // -- AI personality moment: noticing patterns -----------------------------
  ai_observation_001: {
    messageId: "ai_observation_001",
    speaker: "{{AI_NAME}}",
    delaySec: 15,
    textContent: [
      "I've been correlating your extraction data. The silicate-to-metal ratios across this cluster are unusually consistent. Statistically, that's... unexpected. Probably just sampling bias.",
      "Probably.",
    ],
    priority: 1,
  },

  // == TRANSIT & LUNAR ARRIVAL ==================================================

  // -- Transit drive first use -------------------------------------------------
  transit_first_001: {
    messageId: "transit_first_001",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Inertial compensation field active. The acceleration you're about to experience would be... inadvisable without it.",
      "Drive is yours. Throttle at your discretion.",
    ],
    priority: 2,
  },

  // -- Lunar arrival (first time) ---------------------------------------------
  lunar_arrival_001: {
    messageId: "lunar_arrival_001",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Drive disengaged. Lunar proximity confirmed. I'm reading a dense asteroid cluster in the local field.",
      "Composition scans show titanium-rich rock out here. Worth an inspection or two.",
    ],
    priority: 2,
  },

  // NOTE: overheat_001 is constructed dynamically in GameCommsTriggers.tsx
  // because its text depends on the player's research/inventory state.
};

// ---------------------------------------------------------------------------
// Research completion messages — per-node AI reactions
// ---------------------------------------------------------------------------

export const RESEARCH_COMPLETE_MESSAGES: Record<string, CommsMessage> = {
  sv1_composition_survey: {
    messageId: "rc_sv1_composition_survey",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Composition survey models are in. I can read a rock faster and from further out now. The prospector scanner specs are ready to fabricate.",
    ],
    priority: 1,
  },
  sv2_volatile_mapping: {
    messageId: "rc_sv2_volatile_mapping",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Volatile mapping done. With a ping array I can mark the rocks around us and inspect them from long range.",
    ],
    priority: 1,
  },
  ex1_controlled_extraction: {
    messageId: "rc_ex1_controlled_extraction",
    speaker: "{{AI_NAME}}",
    textContent: [
      "That sustained run gave me what I needed. A focused beam cuts faster, but it pulls more power and runs hot. Your call when it's worth it.",
    ],
    priority: 1,
  },
  ex2_yield_analysis: {
    messageId: "rc_ex2_yield_analysis",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Yield analysis complete. A different extraction head recovers more of each rock, at the cost of a slower cut.",
    ],
    priority: 1,
  },
  th1_heat_rejection: {
    messageId: "rc_th1_heat_rejection",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Heat rejection specs validated against the load we just observed. Radiator strips and a coolant loop are both buildable.",
    ],
    priority: 1,
  },
  lg1_bulk_handling: {
    messageId: "rc_lg1_bulk_handling",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Bulk handling worked out. The cargo slot can carry a bigger hold or an auxiliary tank, not both. And the electrolysis cell speeds up processing.",
    ],
    priority: 1,
  },
  pr1_transit_calibration: {
    messageId: "rc_pr1_transit_calibration",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Transit drive calibration complete. We process our own propellant and fabricate our own parts now. Build the drive and the Moon is in range, fuel permitting.",
    ],
    priority: 1,
  },
  pr2_thruster_tuning: {
    messageId: "rc_pr2_thruster_tuning",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Thruster tuning done, using the data from that transit run. Nozzle upgrades are ready to fabricate.",
    ],
    priority: 1,
  },
  hl1_hull_reinforcement: {
    messageId: "rc_hl1_hull_reinforcement",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Hull reinforcement specs are ready. Ablative plating, or nanites that patch the hull from our own metal stock.",
    ],
    priority: 1,
  },
  ln1_survey_salvage: {
    messageId: "rc_ln1_survey_salvage",
    speaker: "{{AI_NAME}}",
    textContent: [
      "The survey canister's data is decoded. There's an integrated sensor suite design in here. Titanium heavy, but worth it.",
    ],
    priority: 1,
  },
};


// ---------------------------------------------------------------------------
// Item craft messages — per-item AI reactions
// Modules fire on craft. Consumables fire on FIRST craft only (played registry).
// ---------------------------------------------------------------------------

export const ITEM_CRAFTED_MESSAGES: Record<string, CommsMessage> = {
  // ── Modules ──
  module_prospector_scanner_mk1: {
    messageId: "ic_prospector_scanner_mk1",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Prospector Scanner online. Inspections run twice as fast from further out, and target lock shows composition bands.",
      "Quick primer on what those classes mean for you. S-types are the common silicate rocks: Mostly silicates with a respectable fraction of iron-nickel metal.",
      "C-types are carbonaceous. Lower silicate content, but they're the only reliable source of hydrates, along with measurable carbon and sulfur.",
      "X-types are metallic. Sixty to ninety percent iron-nickel by composition: Dense, heavy, and the richest metal yield in the belt.",
      "Pick your targets by class and you'll save a lot of wasted cargo runs.",
    ],
    priority: 1,
  },
  module_ping_array_mk1: {
    messageId: "ic_ping_array_mk1",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Ping Array installed. Sensor sweep will highlight targetable asteroids in range.",
    ],
    priority: 1,
  },
  module_integrated_sensor_suite: {
    messageId: "ic_integrated_sensor_suite",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Integrated Sensor Suite online. Every scanner system unified. Full-spectrum awareness — this is how survey work should be done.",
    ],
    priority: 1,
  },
  module_beam_focuser_mk1: {
    messageId: "ic_beam_focuser_mk1",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Beam Focuser installed. Tighter coherence, faster ablation. Mining should be noticeably quicker.",
    ],
    priority: 1,
  },
  module_yield_extractor_mk1: {
    messageId: "ic_yield_extractor_mk1",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Yield Extractor calibrated. The collection system will capture material previously lost to ablation scatter.",
    ],
    priority: 1,
  },
  module_radiator_strips_mk1: {
    messageId: "ic_radiator_strips_mk1",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Radiator strips mounted. Passive heat rejection improved — the laser will run cooler under sustained fire.",
    ],
    priority: 1,
  },
  module_coolant_circulator_mk1: {
    messageId: "ic_coolant_circulator_mk1",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Coolant Circulator online. Overheat recovery will be faster when the laser hits its limit.",
    ],
    priority: 1,
  },
  module_cargo_rack_mk1: {
    messageId: "ic_cargo_rack_mk1",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Cargo Rack secured. Additional storage volume online — should help with longer mining runs.",
    ],
    priority: 1,
  },
  module_ablative_plating_mk1: {
    messageId: "ic_ablative_plating_mk1",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Ablative plating bonded to the hull. Collision resistance improved — won't make us invincible, but we'll take hits better.",
    ],
    priority: 1,
  },
  module_nanite_repair_mk1: {
    messageId: "ic_nanite_repair_mk1",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Nanite Repair System activated. Autonomous hull restoration. Slow, but it works while we do other things. I find the concept... appealing.",
    ],
    priority: 1,
  },
  module_thruster_nozzles_mk1: {
    messageId: "ic_thruster_nozzles_mk1",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Thruster Nozzles fitted. Acceleration and top speed both improved. You'll feel the difference.",
    ],
    priority: 1,
  },

  // ── Consumables (first craft only — played registry handles dedup) ──
  consumable_heat_sink_cartridge: {
    messageId: "ic_heat_sink_cartridge",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Heat Sink Cartridges fabricated. Emergency thermal dump — vents significant laser heat instantly.",
    ],
    priority: 1,
  },
  consumable_hull_patch_kit: {
    messageId: "ic_hull_patch_kit",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Hull Patch Kits fabricated. Field repair for hull damage. Not full restoration, but keeps us in one piece.",
    ],
    priority: 1,
  },
};
