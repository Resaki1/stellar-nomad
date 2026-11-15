/**
 * Ordered save migrations: MIGRATIONS[i] upgrades schemaVersion i+1 → i+2 and must set the
 * new `schemaVersion`. Append only; never edit a shipped entry. `parseSaveData` applies them.
 */
export type SaveMigration = (data: Record<string, unknown>) => Record<string, unknown>;

export const MIGRATIONS: readonly SaveMigration[] = [];
