// ---------------------------------------------------------------------------
// Ship AI name — persisted to localStorage
// ---------------------------------------------------------------------------
import { atomWithStorage } from "jotai/utils";

const AI_NAME_STORAGE_KEY = "ai-name-v1";

/** The player-chosen name for the ship AI. `null` means not yet named. */
export const aiNameAtom = atomWithStorage<string | null>(
  AI_NAME_STORAGE_KEY,
  null,
);

/**
 * Read the AI name directly from localStorage.
 * Avoids the hydration race where atomWithStorage returns the default (null)
 * before it has read the persisted value.
 */
export function readAiNameFromStorage(): string | null {
  try {
    const raw = localStorage.getItem(AI_NAME_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}
