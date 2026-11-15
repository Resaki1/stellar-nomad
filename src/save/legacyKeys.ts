/** Pre-M0.3 localStorage keys. Split from legacyImport so the title can check without loading it. */
export const LEGACY_KEYS = [
  "cargo",
  "research-v1",
  "modules-v2",
  "modules-v1",
  "ship-config-v1",
  "ship-state-v1",
  "death-v1",
  "asteroid-deltas-v1",
  "asteroids-mined-lifetime-v1",
  "comms-played-v1",
  "star-markers-v1",
  "ai-name-v1",
] as const;

export function hasLegacyKeys(): boolean {
  try {
    return LEGACY_KEYS.some((k) => localStorage.getItem(k) !== null);
  } catch {
    return false;
  }
}
