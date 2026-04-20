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

  // -- Ground Control welcome (follows AI intro) ----------------------------
  welcome_001: {
    messageId: "welcome_001",
    speaker: "Dr. Stern",
    avatar: "/assets/avatars/stern.jpeg",
    delaySec: 5,
    textContent: [
      "Nomad, this is Flight Director Stern. We have your signal. Good to hear from you. We were starting to worry about the hibernation lag.",
      "I'll keep this brief. The situation on the ground has deteriorated since your launch. Methane readings from the Siberian shelf are accelerating. The timeline is tighter than anyone hoped.",
      "There's an asteroid cluster in your sensor range. Start there. Mine what you can, get your lab running, feed the data back to us.",
      "The long game is lunar orbit. The Moon carries concentrations of helium-3 and rare elements we can't get from asteroids. It's beyond your conventional thruster range, but you'll build up to it. Stay safe out there.",
    ],
    priority: 2,
  },

  // == TUTORIAL BEATS =======================================================

  // -- First mining completion ----------------------------------------------
  mining_001: {
    messageId: "mining_001",
    speaker: "{{AI_NAME}}",
    delaySec: 2,
    textContent: [
      "Extraction complete. Cargo intake confirmed, and I'm reading a clean assay sample in the collection buffer. That's useful.",
      "The MicroLab hasn't been calibrated since launch. One sample is all it needs to bootstrap the analysis framework. Might be worth getting that running.",
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
      "You could put some of it toward fabrication or research. Or jettison what you don't need, though once it's gone, it's gone.",
    ],
    priority: 1,
  },

  // -- MicroLab research started --------------------------------------------
  research_start_001: {
    messageId: "research_start_001",
    speaker: "{{AI_NAME}}",
    textContent: [
      "MicroLab calibration running. Integrating your assay data into the analysis framework now.",
      "Should be operational shortly. I'll let you know.",
    ],
    priority: 1,
  },

  // -- MicroLab research complete -------------------------------------------
  research_complete_001: {
    messageId: "research_complete_001",
    speaker: "Dr. Stern",
    delaySec: 5,
    avatar: "/assets/avatars/stern.jpeg",
    textContent: [
      "Nomad, we're receiving your MicroLab telemetry. Analysis framework is live. This is what we needed.",
      "From here, your assay data opens up real research paths. Better extraction methods, sensor capability, ship hardening. Prioritize what keeps you operational out there. Stern out.",
    ],
    priority: 1,
  },

  // -- Stern reinforces the lunar goal (follows MicroLab completion) --------
  stern_lunar_goal_001: {
    messageId: "stern_lunar_goal_001",
    speaker: "Dr. Stern",
    avatar: "/assets/avatars/stern.jpeg",
    delaySec: 60,
    textContent: [
      "Nomad, we're tracking steady returns from your research framework. The engineering models you're feeding us are clarifying options we didn't have before.",
      "The Moon is still the target. Helium-3, rare regolith elements — the serious material is concentrated there. Keep working. You'll know when you're ready to make the crossing.",
    ],
    priority: 1,
  },

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

  // -- Elara's first message ------------------------------------------------
  elara_001: {
    messageId: "elara_001",
    speaker: "Elara",
    avatar: "/assets/avatars/elara.jpeg",
    delaySec: 60,
    textContent: [
      "Hey. It's me. I don't really know how these things work. They said I could send messages through the ESA relay, but I'm probably just talking to dead air.",
      "They won't tell me much about your mission. 'Classified operational parameters.' Very helpful. But I saw the launch. Everyone did.",
      "I don't know. Be careful, I guess. Come back.",
    ],
    priority: 1,
  },

  // -- Stern foreshadowing: ship is overbuilt -------------------------------
  stern_overbuilt_001: {
    messageId: "stern_overbuilt_001",
    speaker: "Dr. Stern",
    avatar: "/assets/avatars/stern.jpeg",
    textContent: [
      "Nomad, your research throughput is ahead of schedule. The engineering team is impressed.",
      "Between you and me, that ship of yours was overbuilt for a mining vessel. But I'm not complaining. It means you can push further and harder than the original mission profile assumed. Keep it up.",
    ],
    priority: 1,
  },

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

  // -- Elara's second message (with foreshadowing) --------------------------
  elara_002: {
    messageId: "elara_002",
    speaker: "Elara",
    avatar: "/assets/avatars/elara.jpeg",
    delaySec: 45,
    textContent: [
      "Me again. Water rations got cut this week. Everyone's pretending it's fine. It's not fine.",
      "The university's been weird. ESA requisitioned half the bioengineering department's equipment last month. 'For the Mars program.' Nobody I've talked to knows anything about a Mars program.",
      "Sorry, I shouldn't dump this on you. You've got enough to worry about up there. Just... yeah.",
    ],
    priority: 1,
  },

  // -- Stern earth deterioration update -------------------------------------
  stern_earth_update_001: {
    messageId: "stern_earth_update_001",
    speaker: "Dr. Stern",
    avatar: "/assets/avatars/stern.jpeg",
    delaySec: 30,
    textContent: [
      "Nomad, mission update. The North Atlantic fisheries have collapsed. Faster than the models predicted. Oxygen generation from marine algae is now measurably declining.",
      "I'm telling you this because you deserve to know what your work means. Every sample, every extraction. It all feeds models that could give us a fighting chance. Don't let up.",
    ],
    priority: 1,
  },

  // -- ESA automated bulletin -----------------------------------------------
  esa_bulletin_001: {
    messageId: "esa_bulletin_001",
    speaker: "ESA Comms",
    delaySec: 60,
    textContent: [
      "[AUTOMATED BULLETIN: ESA RELAY] International resource-sharing agreements between ESA and CNSA have been suspended following the Jakarta incident. ISRO has formally withdrawn from the Proxima Compact. Mission support from non-ESA partners is no longer guaranteed.",
      "[END BULLETIN]",
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
      "Composition scans show unfamiliar signatures. Titanium. And something else. Helium-3, if the spectral data is right. That's... significant.",
    ],
    priority: 2,
  },

  // -- Stern reacts to lunar arrival ------------------------------------------
  lunar_stern_001: {
    messageId: "lunar_stern_001",
    speaker: "Dr. Stern",
    avatar: "/assets/avatars/stern.jpeg",
    delaySec: 10,
    textContent: [
      "Nomad, we're tracking your position update. You made it to lunar orbit. That drive performed well.",
      "The helium-3 readings alone justify the trip. Get samples. Everything you pull from that field opens engineering options we didn't have before.",
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
  a1_sensor_calibration: {
    messageId: "rc_a1_sensor_calibration",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Sensor calibration locked in. Return signals are reading cleaner already — I can pull more detail from the raw data now.",
    ],
    priority: 1,
  },
  a2a_active_scanning: {
    messageId: "rc_a2a_active_scanning",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Active ping subroutines loaded. Sensor sweep is available — should make prospecting considerably less manual.",
    ],
    priority: 1,
  },
  a2b_spectral_analysis: {
    messageId: "rc_a2b_spectral_analysis",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Spectral analysis framework online. I can break reflected light into composition bands now. No more mining blind.",
    ],
    priority: 1,
  },
  a3_integrated_survey: {
    messageId: "rc_a3_integrated_survey",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Full sensor integration complete. Every system feeding into one survey model. I'll admit — this is satisfying to see come together.",
    ],
    priority: 1,
  },
  b1_laser_optics: {
    messageId: "rc_b1_laser_optics",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Optics recalibrated. Beam coherence is tighter. You should notice the difference on the next pass.",
    ],
    priority: 1,
  },
  b2a_beam_optimization: {
    messageId: "rc_b2a_beam_optimization",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Beam pulse shaping optimized. Energy-to-ablation efficiency is significantly better. More rock per joule.",
    ],
    priority: 1,
  },
  b2b_thermal_dynamics: {
    messageId: "rc_b2b_thermal_dynamics",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Thermal dynamics models integrated. I've mapped every heat pathway in the laser assembly — sustained fire is much more manageable.",
    ],
    priority: 1,
  },
  b3_pulse_extraction: {
    messageId: "rc_b3_pulse_extraction",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Pulse extraction firmware loaded. The laser can sustain fire indefinitely with the right rhythm. This changes things.",
    ],
    priority: 1,
  },
  c1_structural_engineering: {
    messageId: "rc_c1_structural_engineering",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Structural analysis complete. Load-bearing patterns mapped across the hull. Field fabrication should be straightforward from here.",
    ],
    priority: 1,
  },
  c2a_hull_reinforcement: {
    messageId: "rc_c2a_hull_reinforcement",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Composite plating specs validated. The simulations show significant improvement in collision survivability.",
    ],
    priority: 1,
  },
  c2b_propulsion_systems: {
    messageId: "rc_c2b_propulsion_systems",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Propulsion optimization complete. RCS authority and nozzle efficiency both improved. The ship should feel more responsive.",
    ],
    priority: 1,
  },
  c3_integrated_platform: {
    messageId: "rc_c3_integrated_platform",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Full platform integration done. Structural, propulsion, and autonomous systems all linked. This ship is... considerably more than what left Earth orbit.",
    ],
    priority: 1,
  },
  m1_transit_drive: {
    messageId: "rc_m1_transit_drive",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Transit drive calibration complete. Interplanetary burn parameters validated. You've been building toward this since hibernation woke you — the Moon is finally in range. Fabricate the drive and we can make the crossing.",
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
      "Prospector Scanner online. Target lock will now identify asteroid classification — S-type, C-type, or X-type.",
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
  module_spectral_mapper_mk1: {
    messageId: "ic_spectral_mapper_mk1",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Spectral Mapper integrated. Composition band analysis now available on target lock.",
    ],
    priority: 1,
  },
  module_assay_enhancer_mk1: {
    messageId: "ic_assay_enhancer_mk1",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Assay Enhancer calibrated. Sample recovery should improve — the collection system is wasting less material.",
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
  module_beam_focuser_mk2: {
    messageId: "ic_beam_focuser_mk2",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Beam Focuser Mk2 online. Significant refinement over the first iteration — the energy profile is more aggressive.",
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
  module_pulse_modulator_mk1: {
    messageId: "ic_pulse_modulator_mk1",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Pulse Modulator installed. New mining mode available — pulsed extraction. Slower peak rate, but sustainable on large targets.",
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
  module_radiator_strips_mk2: {
    messageId: "ic_radiator_strips_mk2",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Radiator Strips Mk2 installed. Thermal rejection is substantially better. The originals look primitive by comparison.",
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
  module_cargo_rack_mk2: {
    messageId: "ic_cargo_rack_mk2",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Cargo Rack Mk2 installed. That's a significant hold expansion. We can stockpile properly now.",
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
  module_ablative_plating_mk2: {
    messageId: "ic_ablative_plating_mk2",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Ablative Plating Mk2 in place. The composite layering is more sophisticated. This hull can handle real punishment.",
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
  module_reaction_wheels_mk1: {
    messageId: "ic_reaction_wheels_mk1",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Reaction Wheels installed. Attitude control authority improved — braking should feel tighter.",
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
  module_thruster_nozzles_mk2: {
    messageId: "ic_thruster_nozzles_mk2",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Thruster Nozzles Mk2 online. The acceleration curve is aggressive. This ship moves like something considerably smaller.",
    ],
    priority: 1,
  },

  // ── Consumables (first craft only — played registry handles dedup) ──
  consumable_assay_probe: {
    messageId: "ic_assay_probe",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Assay Probes ready. Deploy on a locked target for a resource breakdown before committing to a mining pass.",
    ],
    priority: 1,
  },
  consumable_scanner_pulse: {
    messageId: "ic_scanner_pulse",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Scanner Pulse charges fabricated. Temporary enhanced sweep — useful for quick field assessment.",
    ],
    priority: 1,
  },
  consumable_composition_scan: {
    messageId: "ic_composition_scan",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Composition Scan Charges ready. Activate one and every asteroid in range reveals its type briefly.",
    ],
    priority: 1,
  },
  consumable_deep_scan_probe: {
    messageId: "ic_deep_scan_probe",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Deep Scan Probes fabricated. Full-spectrum burst — complete data on everything in range. Temporary, but thorough.",
    ],
    priority: 1,
  },
  consumable_overclock_charge: {
    messageId: "ic_overclock_charge",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Overclock Charges fabricated. Temporary mining speed boost. Pushes the laser past safe parameters for a short burst.",
    ],
    priority: 1,
  },
  consumable_precision_charge: {
    messageId: "ic_precision_charge",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Precision Charges ready. Use during mining for a guaranteed bonus yield from the current target.",
    ],
    priority: 1,
  },
  consumable_heat_sink_cartridge: {
    messageId: "ic_heat_sink_cartridge",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Heat Sink Cartridges fabricated. Emergency thermal dump — vents significant laser heat instantly.",
    ],
    priority: 1,
  },
  consumable_thermal_purge: {
    messageId: "ic_thermal_purge",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Thermal Purge Charges ready. Complete heat reset. More potent than a standard heat sink — save these for critical moments.",
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
  consumable_emergency_repair_kit: {
    messageId: "ic_emergency_repair_kit",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Emergency Repair Kits ready. Substantial hull restoration — more effective than basic patches.",
    ],
    priority: 1,
  },
  consumable_afterburner_charge: {
    messageId: "ic_afterburner_charge",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Afterburner Charges fabricated. Temporary thrust override. Significant speed burst for a few seconds.",
    ],
    priority: 1,
  },
};
