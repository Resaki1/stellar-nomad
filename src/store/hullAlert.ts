/**
 * Hull alert state for the HUD (FIRST_EXPEDITION_PLAN WP4). The sound, tiers, hysteresis, backed-off
 * reminders and re-arming live in the A12 alert ("hull", src/audio/alerts.ts); this mirrors its tier and
 * acknowledgement into jotai so a muted pilot still sees it, and gives the HUD its acknowledge action.
 */
import { atom, type createStore } from "jotai";
import { acknowledgeAlert, onAlertChange } from "@/audio/alerts";
import type { AlarmTier } from "@/audio/alarms";

type Store = ReturnType<typeof createStore>;

export interface HullAlert {
  /** "advisory" ≤45 % hull, "caution" ≤25 %, "critical" ≤10 % (DEFAULT_TIERS, with hysteresis). */
  tier: AlarmTier | "none";
  /** Reminders silenced; the alert sounds again on escalation or 5 % more hull lost. */
  acknowledged: boolean;
}

export const hullAlertAtom = atom<HullAlert>({ tier: "none", acknowledged: false });

/** Quiet the hull reminders; the state stays visible and a repair action stays available. */
export const acknowledgeHullAlertAtom = atom(null, () => acknowledgeAlert("hull"));

export function installHullAlert(store: Store): () => void {
  store.set(hullAlertAtom, { tier: "none", acknowledged: false });
  return onAlertChange((s) => {
    if (s.id === "hull") store.set(hullAlertAtom, { tier: s.tier, acknowledged: s.acknowledged });
  });
}
