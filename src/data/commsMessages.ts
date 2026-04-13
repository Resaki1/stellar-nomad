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
  // -- AI greeting (fires on first load, before naming) ---------------------
  ai_greeting_001: {
    messageId: "ai_greeting_001",
    speaker: "Ship AI",
    textContent: [
      "Ship AI module online. Post-hibernation diagnostics complete. Hull integrity nominal, life support cycling, navigation arrays online.",
      "AI designation has not been configured. Please assign a designation to proceed with system initialization.",
    ],
    priority: 3,
  },

  // -- AI introduction (fires after the player names the AI) ----------------
  ai_intro_001: {
    messageId: "ai_intro_001",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Designation confirmed. {{AI_NAME}}, online. All primary systems nominal.",
      "I will be monitoring ship systems and providing mission support. Establishing uplink with ESA Ground Control now.",
      "...",
    ],
    priority: 3,
  },

  // -- Ground Control welcome (follows AI intro) ----------------------------
  welcome_001: {
    messageId: "welcome_001",
    speaker: "Dr. Stern",
    avatar: "/assets/avatars/stern.jpeg",
    textContent: [
      "Nomad, this is Flight Director Stern. We have your signal. I see you've already given your onboard AI a name. {{AI_NAME}}, is it? Good. You'll want the company out there.",
      "Here's the situation. The methane cascade from the northern permafrost is accelerating. Crop yields are collapsing across the northern hemisphere. Your mission is to mine raw materials and conduct lab assays. Every sample you send back feeds directly into our atmospheric restoration models.",
      "There's an asteroid field in your vicinity. Start there. Get familiar with your scanner and mining laser. Good luck, Nomad. Stern out.",
    ],
    priority: 2,
  },

  // -- First mining completion ----------------------------------------------
  mining_001: {
    messageId: "mining_001",
    speaker: "Dr. Stern",
    avatar: "/assets/avatars/stern.jpeg",
    delaySec: 5,
    textContent: [
      "Good work, Nomad. Along with those resources, you collected your first assay sample. That's exactly what we need to start calibrating your MicroLab.",
      "The MicroLab is your onboard analysis station. Once it's operational, it opens up the full research tree. Better mining equipment, ship systems, sensor upgrades.",
      "Open the research panel and start the MicroLab calibration. It won't take long. Once it's online, the real work begins.",
      "Keep those samples coming. Stern out.",
    ],
    priority: 1,
  },

  // -- First hull damage ----------------------------------------------------
  first_damage_001: {
    messageId: "first_damage_001",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Hull impact detected. Structural integrity is holding, but I wouldn't make a habit of this.",
      "Asteroid collisions cause cumulative damage. I'd suggest reducing speed when navigating dense clusters.",
    ],
    priority: 2,
  },

  // -- Cargo hold full ------------------------------------------------------
  cargo_full_001: {
    messageId: "cargo_full_001",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Cargo hold at maximum capacity. Mining is locked until you free up space.",
      "You can put materials to use in the research panel or crafting system. If you need to make room quickly, individual resources can be jettisoned from the cargo screen. Permanently, though. So think twice.",
    ],
    priority: 1,
  },

  // -- MicroLab research started --------------------------------------------
  research_start_001: {
    messageId: "research_start_001",
    speaker: "{{AI_NAME}}",
    textContent: [
      "MicroLab initialization sequence started. Calibration should take a few minutes.",
      "Once it's online, you'll have access to the full research tree. I'll let you know when it's ready.",
    ],
    priority: 1,
  },

  // -- MicroLab research complete -------------------------------------------
  research_complete_001: {
    messageId: "research_complete_001",
    speaker: "Dr. Stern",
    avatar: "/assets/avatars/stern.jpeg",
    textContent: [
      "Nomad, we're receiving MicroLab telemetry. Analysis framework is online. Good work.",
      "Every assay sample you collect now feeds into a broader set of research paths. Ship upgrades, better mining tools, sensor arrays. Prioritize what you need most out there.",
      "This is real progress. Stern out.",
    ],
    priority: 2,
  },

  // -- First module/item crafted --------------------------------------------
  first_craft_001: {
    messageId: "first_craft_001",
    speaker: "{{AI_NAME}}",
    textContent: [
      "Fabrication complete. Diagnostics look good. I've integrated it into the ship's systems.",
      "More blueprints become available as your research progresses. Worth checking the crafting panel after each breakthrough.",
    ],
    priority: 1,
  },

  // NOTE: overheat_001 is constructed dynamically in GameCommsTriggers.tsx
  // because its text depends on the player's research/inventory state.
};
