"use client";

import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { enqueueCommsAtom } from "@/store/comms";
import { COMMS_MESSAGES } from "@/data/commsMessages";

/**
 * Fires the welcome message once on first mount.
 * The played-registry in the store prevents it from replaying on reload.
 */
export function CommsWelcomeTrigger() {
  const enqueue = useSetAtom(enqueueCommsAtom);

  useEffect(() => {
    const msg = COMMS_MESSAGES.welcome_001;
    if (msg) enqueue(msg);
  }, [enqueue]);

  return null;
}
