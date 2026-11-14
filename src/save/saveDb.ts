/**
 * IndexedDB persistence for worlds. Meta and data live in separate object stores so the
 * world list never loads full saves; `putWorld` writes both in ONE transaction.
 */
import { SCHEMA_VERSION } from "./defaults";
import { parseSaveData, parseSaveMeta } from "./validate";
import type { SaveData, SaveMeta, SaveRecord, WorldId } from "./types";

export const DB_NAME = "stellar-nomad";
const DB_VERSION = 1;
const META = "worldMeta";
const DATA = "worldData";
const EXPORT_FORMAT = "stellar-nomad-save";

let dbPromise: Promise<IDBDatabase> | null = null;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA);
    };
    r.onsuccess = () => {
      const db = r.result;
      // Another tab deleting/upgrading the DB: drop our handle so the next call reopens.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    r.onerror = () => {
      dbPromise = null;
      reject(r.error);
    };
  });
  return dbPromise;
}

/** Newest-played first. */
export async function listWorlds(): Promise<SaveMeta[]> {
  const db = await openDb();
  const all = await req(db.transaction(META).objectStore(META).getAll() as IDBRequest<unknown[]>);
  return all
    .map((m) => parseSaveMeta(m, ""))
    .filter((m) => m.id !== "")
    .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
}

export async function loadWorld(id: WorldId): Promise<SaveRecord | null> {
  const db = await openDb();
  const tx = db.transaction([META, DATA]);
  const [meta, data] = await Promise.all([
    req(tx.objectStore(META).get(id) as IDBRequest<unknown>),
    req(tx.objectStore(DATA).get(id) as IDBRequest<unknown>),
  ]);
  if (meta === undefined || data === undefined) return null;
  return { meta: parseSaveMeta(meta, id), data: parseSaveData(data) };
}

export async function putWorld(meta: SaveMeta, data: SaveData): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, DATA], "readwrite");
  tx.objectStore(META).put(meta);
  tx.objectStore(DATA).put(data, meta.id);
  await done(tx);
}

export async function deleteWorld(id: WorldId): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, DATA], "readwrite");
  tx.objectStore(META).delete(id);
  tx.objectStore(DATA).delete(id);
  await done(tx);
}

export async function exportWorld(id: WorldId): Promise<string> {
  const rec = await loadWorld(id);
  if (!rec) throw new Error(`no world ${id}`);
  return JSON.stringify({ format: EXPORT_FORMAT, meta: rec.meta, data: rec.data });
}

export function newWorldId(): WorldId {
  return crypto.randomUUID();
}

/**
 * Validates untrusted JSON and stores it as a NEW world (fresh id). A single-player save is
 * re-keyed to `localPlayerId`, so a save carried to another device keeps its progress.
 */
export async function importWorld(json: string, localPlayerId: string): Promise<SaveMeta> {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || (parsed as { format?: unknown }).format !== EXPORT_FORMAT) {
    throw new Error("not a Stellar Nomad save file");
  }
  const p = parsed as { meta?: unknown; data?: unknown };
  const data = parseSaveData(p.data);
  const ids = Object.keys(data.players);
  if (ids.length === 1 && ids[0] !== localPlayerId) {
    data.players = { [localPlayerId]: data.players[ids[0]] };
  }
  const meta = { ...parseSaveMeta(p.meta, ""), id: newWorldId(), schemaVersion: SCHEMA_VERSION };
  await putWorld(meta, data);
  return meta;
}

/** Ask the browser not to evict our storage. Best effort. */
export function requestPersistentStorage(): void {
  void navigator.storage?.persist?.().catch(() => false);
}
