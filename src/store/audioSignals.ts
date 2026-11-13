import { atom } from "jotai";
import type { AudioEventId } from "@/data/audioEvents";

// Action counters avoid treating persisted inventory hydration as player input.
// Separate counters retain distinct actions that React batches into one render.
export type AudioAction = Extract<AudioEventId,
  "loot.acquire" | "module.equip" | "module.unequip" | "ui.reject" | "click.soft" |
  "comms.chirp.advance" | "comms.chirp.dismiss" | "cargo.jettison" |
  "mining.heatsink.vent" | "mining.purge.vent" | "ship.hull.repair">;
export const audioActionCountsAtom = atom<Partial<Record<AudioAction, number>>>({});
export const signalAudioActionAtom = atom(null, (get, set, event: AudioAction): void => {
  const counts = get(audioActionCountsAtom);
  set(audioActionCountsAtom, { ...counts, [event]: (counts[event] ?? 0) + 1 });
});

export function isShipAISpeaker(speaker: string): boolean {
  return speaker === "Ship AI" || speaker === "{{AI_NAME}}";
}
