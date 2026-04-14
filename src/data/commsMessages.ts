// ---------------------------------------------------------------------------
// Comms message definitions
// ---------------------------------------------------------------------------

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
      "There's an asteroid cluster in your sensor range. We need raw materials and assay data. Everything you collect feeds directly into our atmospheric models. Get to it. And Nomad... stay safe out there.",
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
    delaySec: 2,
    avatar: "/assets/avatars/stern.jpeg",
    textContent: [
      "Nomad, we're receiving your MicroLab telemetry. Analysis framework is live. This is what we needed.",
      "From here, your assay data opens up real research paths. Better extraction methods, sensor capability, ship hardening. Prioritize what keeps you operational out there. Stern out.",
    ],
    priority: 2,
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

  // NOTE: overheat_001 is constructed dynamically in GameCommsTriggers.tsx
  // because its text depends on the player's research/inventory state.
};
