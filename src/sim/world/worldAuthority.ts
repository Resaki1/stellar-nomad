import { getWorldState, markDirty } from "@/save/activeSave";
import { LocalAuthority } from "./authority";

/** Solo play: the in-process authority over the active save's WorldState. */
export const worldAuthority = new LocalAuthority({ getWorld: getWorldState, markDirty });
