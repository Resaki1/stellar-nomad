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

export const COMMS_MESSAGES: Record<string, CommsMessage> = {
  welcome_001: {
    messageId: "welcome_001",
    speaker: "Dr. Stern",
    avatar: "/assets/avatars/stern.jpeg",
    textContent: [
      "Nomad, this is Flight Director Stern. Signal check... okay, we have you. Systems check shows your hull integrity is nominal.",
      "Remember, your mission is to aid us in research and to collect rare resources. If all goes well, this might help us save Earth before it's too late.",
      "You should see an asteroid field nearby. Try mining one of the asteroids to get familiar with your scanner and mining laser. Good luck out there, Nomad! We are counting on you.",
    ],
    priority: 2,
  },

  mining_001: {
    messageId: "mining_001",
    speaker: "Dr. Stern",
    avatar: "/assets/avatars/stern.jpeg",
    textContent: [
      "Great job, Nomad! Along with some resources, you just collected your first assay sample. That was the last piece of data we needed to start researching your MicroLab.",
      "This onboard lab will allow you to analyze samples and conduct experiments while you're out in space. It's a crucial tool for your mission, so make sure to use it often.",
      "To access the MicroLab, open the research panel and click the start button right next to the MicroLab. Once the research is complete, you'll be able to research new technologies and upgrades that will help you on your journey.",
      "Keep up the good work, Nomad! We're here to support you every step of the way.",
    ],
    priority: 1,
  },
};
