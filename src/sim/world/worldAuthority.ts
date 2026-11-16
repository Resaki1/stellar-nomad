import { getPlayerState, getPlayerStates, getWorldState, markDirty } from "@/save/activeSave";
import { LocalAuthority } from "./authority";

/** Solo play: the in-process authority over the active save's WorldState. */
export const worldAuthority = new LocalAuthority({ getWorld: getWorldState, getPlayer: getPlayerState, getPlayers: getPlayerStates, markDirty });

let opSeq = 0;
/** Fresh id for a new intent; reuse it to retry the same intent. */
export function newOpId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `op-${Date.now()}-${++opSeq}`;
}
