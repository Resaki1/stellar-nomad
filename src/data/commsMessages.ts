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
      "Here's where things stand. Earth's atmosphere is deteriorating faster than projected. Your mission is critical: Mine raw materials and conduct lab assays. The research data you send back could help us turn this around.",
      "You should see an asteroid field nearby. Try mining one of the asteroids to get familiar with your scanner and mining laser. Good luck out there, Nomad. We're counting on you.",
    ],
    priority: 2,
  },

  // -- First mining completion ----------------------------------------------
  mining_001: {
    messageId: "mining_001",
    speaker: "Dr. Stern",
    avatar: "/assets/avatars/stern.jpeg",
    textContent: [
      "Good work, Nomad. Along with those resources, you've collected your first assay sample. That's the last piece of data we needed to begin researching your MicroLab.",
      "This onboard lab will allow you to analyze samples and conduct experiments while you're out in space. It's a crucial tool — make sure to use it.",
      "To access the MicroLab, open the research panel and start the research. Once complete, you'll be able to research new technologies and upgrades for your journey.",
      "Keep it up, Nomad. Ground Control out.",
    ],
    priority: 1,
  },
};
