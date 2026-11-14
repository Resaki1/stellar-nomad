/** Boot steps, UI-free so the M0.4 title/loading screen can drive them. */
import { activateWorld, createWorld } from "./activeSave";
import { hasLegacyKeys } from "./legacyKeys";
import { getLastWorldId } from "./playerId";
import { listWorlds } from "./saveDb";
import type { Difficulty, SaveMeta, WorldId } from "./types";

/** Worlds to try, best first: `?world=<id>`, the last played world, then newest-played. */
export async function candidateWorldIds(urlWorldId: string | null): Promise<WorldId[]> {
  const ids = (await listWorlds()).map((w) => w.id);
  const first = [urlWorldId, getLastWorldId()].filter((id): id is string => !!id && ids.includes(id));
  return Array.from(new Set(first.concat(ids)));
}

let booting: Promise<SaveMeta> | null = null;

/** Legacy import → choose → activate (or create "World 1"). Memoised: StrictMode runs effects twice. */
export function bootActiveWorld(urlWorldId: string | null): Promise<SaveMeta> {
  booting ??= withBootLock(() => boot(urlWorldId)).catch((e: unknown) => {
    booting = null;
    throw e;
  });
  return booting;
}

/** The importer pulls in the ephemeris and three.js: load it only when there is something to import. */
async function importLegacyIfNeeded(): Promise<void> {
  if (!hasLegacyKeys()) return;
  const m = await import("./legacyImport");
  await m.importLegacyIfNeeded();
}

/** World list for the title screen, after any one-time legacy import. Metadata only. */
export function listWorldsForTitle(): Promise<SaveMeta[]> {
  return withBootLock(() => importLegacyIfNeeded().then(() => listWorlds()));
}

/** Create and activate a new world. Shares the memo with bootActiveWorld: one world per page. */
export function bootNewWorld(opts: { name: string; seed: number; difficulty: Difficulty }): Promise<SaveMeta> {
  booting ??= withBootLock(() => importLegacyIfNeeded().then(() => createWorld(opts))).catch((e: unknown) => {
    booting = null;
    throw e;
  });
  return booting;
}

/** Serialises boot across tabs, so two first boots cannot both import or create "World 1". */
function withBootLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return locks ? (locks.request("stellar-nomad-boot", fn) as Promise<T>) : fn();
}

async function boot(urlWorldId: string | null): Promise<SaveMeta> {
  await importLegacyIfNeeded();
  const ids = await candidateWorldIds(urlWorldId);
  let firstError: unknown = null;
  for (const id of ids) {
    try {
      return await activateWorld(id);
    } catch (e) {
      console.error(`[save] world ${id} could not be loaded`, e);
      firstError ??= e;
    }
  }
  if (firstError !== null) throw firstError;
  return createWorld({ name: "World 1", seed: (Math.random() * 2 ** 32) >>> 0, difficulty: "standard" });
}
