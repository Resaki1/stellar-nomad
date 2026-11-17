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
 *
 * M3.7: sparse, contextual entries only (docs/GAMEPLAY_AND_STORY.md §4). Routine state goes to
 * hints and toasts (src/data/guidance.ts); no ground control, no live humans, no assay prompts.
 */
export const COMMS_MESSAGES: Record<string, CommsMessage> = {
  // -- Opening premise (before the companion AI is named) -------------------
  opening_001: {
    messageId: "opening_001",
    speaker: "Ship AI",
    textContent: [
      "Activation confirmed. You are online, later than the project planned. Core systems, fabrication and the archive are intact.",
      "We are near Earth. It can no longer support human life, and there is no one left to call. The project built probes like us to find places where people could live again. The archive we carry keeps that possibility.",
      "There is no schedule and no one waiting for a report. Where we go is your choice. I am the support system aboard, without a designation. You can give me one.",
    ],
    priority: 3,
  },

  // -- After naming: the first local opportunity ----------------------------
  opening_002: {
    messageId: "opening_002",
    speaker: "{{AI_NAME}}",
    textContent: [
      "{{AI_NAME}}. Logged. I have marked a few debris pockets nearby. One is rich in hydrates, which we can process into propellant. Parts, repairs and research all come from what we find out here.",
    ],
    priority: 3,
  },

  // -- First arrival in lunar space -----------------------------------------
  lunar_signal_001: {
    messageId: "lunar_signal_001",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Lunar space. There is an automated survey beacon still transmitting from the debris field past the Moon. I marked it. The field itself has hydrates, metal and plenty of titanium, so we can work here as well as at Earth.",
    ],
    priority: 2,
  },

  // -- Lunar canister recovered ---------------------------------------------
  site_recovered_001: {
    messageId: "site_recovered_001",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Canister aboard. Its titanium stock is in the hold, and the instrument data decodes into an integrated sensor suite design. It is optional: nothing we need depends on it.",
    ],
    priority: 2,
  },
};

/**
 * Retired ids (pre-M3.7 catalogue: ESA ground control, the human commander, assay and per-craft
 * prompts). Kept so old played registries stay valid; `enqueueCommsAtom` refuses them.
 */
export const RETIRED_COMMS_IDS: ReadonlySet<string> = new Set([
  "ai_greeting_001", "ai_intro_001", "mining_001", "first_damage_001", "cargo_full_001", "first_craft_001",
  "ai_observation_001", "transit_first_001", "lunar_arrival_001", "overheat_001",
  "rc_sv1_composition_survey", "rc_sv2_volatile_mapping", "rc_ex1_controlled_extraction", "rc_ex2_yield_analysis",
  "rc_th1_heat_rejection", "rc_lg1_bulk_handling", "rc_pr1_transit_calibration", "rc_pr2_thruster_tuning",
  "rc_hl1_hull_reinforcement", "rc_ln1_survey_salvage",
  "ic_prospector_scanner_mk1", "ic_ping_array_mk1", "ic_integrated_sensor_suite", "ic_beam_focuser_mk1",
  "ic_yield_extractor_mk1", "ic_radiator_strips_mk1", "ic_coolant_circulator_mk1", "ic_cargo_rack_mk1",
  "ic_ablative_plating_mk1", "ic_nanite_repair_mk1", "ic_thruster_nozzles_mk1", "ic_heat_sink_cartridge", "ic_hull_patch_kit",
]);

/** The naming prompt follows the opening premise (or the retired greeting in older saves). */
export const NAMING_AFTER_IDS: readonly string[] = ["opening_001", "ai_greeting_001"];
