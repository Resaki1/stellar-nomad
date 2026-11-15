import { savedAtom } from "@/store/savedAtom";

/** The player-chosen name for the ship AI. `null` means not yet named. */
export const aiNameAtom = savedAtom("player", "aiName", null);
