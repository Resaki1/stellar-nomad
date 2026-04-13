"use client";

import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { enqueueCommsAtom } from "@/store/comms";
import { aiNameAtom } from "@/store/aiName";
import { COMMS_MESSAGES } from "@/data/commsMessages";

/**
 * Two-phase welcome sequence:
 * 1. AI greeting fires immediately (asks the player to name the AI).
 * 2. Once the player has named the AI, the AI intro + Dr. Stern welcome fire.
 *
 * The played-registry prevents replaying on reload.
 */
export function CommsWelcomeTrigger() {
  const enqueue = useSetAtom(enqueueCommsAtom);
  const aiName = useAtomValue(aiNameAtom);

  // Phase 1: AI greeting — fires on mount, before naming
  useEffect(() => {
    const greeting = COMMS_MESSAGES.ai_greeting_001;
    if (greeting) enqueue(greeting);
  }, [enqueue]);

  // Phase 2: After AI is named, fire intro + welcome
  useEffect(() => {
    if (!aiName) return;

    const intro = COMMS_MESSAGES.ai_intro_001;
    if (intro) enqueue(intro);

    const welcome = COMMS_MESSAGES.welcome_001;
    if (welcome) enqueue(welcome);
  }, [aiName, enqueue]);

  return null;
}
