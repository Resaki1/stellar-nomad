/**
 * The in-memory active world. Slices are mutated in place and marked dirty; a debounced
 * flush writes the whole record to IndexedDB. Per-frame values (ship pose, sim epoch, play
 * time) are SAMPLED by collectors at flush time instead of dirtying the save every frame.
 * ⚠ Never rely on beforeunload: an async IndexedDB write cannot be awaited there, so we
 * flush on visibilitychange(hidden) and pagehide.
 */
import { SCHEMA_VERSION, defaultPlayerState, defaultSaveData } from "./defaults";
import { listWorlds, loadWorld, newWorldId, putWorld, requestPersistentStorage } from "./saveDb";
import { getLocalPlayerId, setLastWorldId } from "./playerId";
import { isSimPaused } from "@/sim/simPause";
import type { Difficulty, PlayerId, PlayerState, SaveData, SaveMeta, SaveRecord, WorldId, WorldState } from "./types";

const FLUSH_DEBOUNCE_MS = 1000;
const PLAY_TICK_MS = 2000;
/** A longer gap between collects (tab hidden, debugger) is not play time. */
const MAX_PLAY_STEP_S = 6;
const WRITER_LOCK_WAIT_MS = 3000;

let active: SaveRecord | null = null;
let dirty = false;
/** Reasons writes are suspended (bench and test isolation overlap). */
const suspendedBy = new Set<string>();
let lastFlushedAt = 0;
let lastCollectMs = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushChain: Promise<boolean> = Promise.resolve(false);
let lifecycleInstalled = false;
const collectors = new Set<() => void>();

export function getActiveSave(): SaveRecord | null {
  return active;
}

function requireActive(): SaveRecord {
  if (!active) throw new Error("[save] no active world");
  return active;
}

export function getWorldState(): WorldState {
  return requireActive().data.world;
}

export function getLocalPlayerState(): PlayerState {
  const players = requireActive().data.players;
  const id = getLocalPlayerId();
  return (players[id] ??= defaultPlayerState());
}

/** Any saved player's state; the local player is created on demand, others must exist. */
export function getPlayerState(id: PlayerId): PlayerState | null {
  if (!active) return null;
  return id === getLocalPlayerId() ? getLocalPlayerState() : (active.data.players[id] ?? null);
}

/** Every saved player (bookmark protection when the source list evicts). */
export function getPlayerStates(): PlayerState[] {
  return active ? Object.values(active.data.players) : [];
}

export function readPlayerSlice<K extends keyof PlayerState>(key: K): PlayerState[K] | undefined {
  return active ? getLocalPlayerState()[key] : undefined;
}

export function writePlayerSlice<K extends keyof PlayerState>(key: K, value: PlayerState[K]): void {
  if (!active) return;
  getLocalPlayerState()[key] = value;
  markDirty();
}

/** Collector-only write: stores a sampled value without dirtying the save. */
export function samplePlayerSlice<K extends keyof PlayerState>(key: K, value: PlayerState[K]): void {
  if (active) getLocalPlayerState()[key] = value;
}

export function readWorldSlice<K extends keyof WorldState>(key: K): WorldState[K] | undefined {
  return active ? active.data.world[key] : undefined;
}

export function writeWorldSlice<K extends keyof WorldState>(key: K, value: WorldState[K]): void {
  if (!active) return;
  active.data.world[key] = value;
  markDirty();
}

/**
 * `urgent`: flush on the next task, not after the debounce. MEASURED: a reload within the 1 s
 * debounce lost committed operations; the pagehide flush's IndexedDB write is aborted by unload.
 */
export function markDirty(urgent = false): void {
  if (!active) return;
  dirty = true;
  if (flushTimer !== null) {
    if (!urgent) return;
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(
    () => {
      flushTimer = null;
      void flush();
    },
    urgent ? 0 : FLUSH_DEBOUNCE_MS,
  );
}

/** Runs right before every flush; writes sampled values into the save without dirtying it. */
export function registerCollector(fn: () => void): () => void {
  collectors.add(fn);
  return () => collectors.delete(fn);
}

/** Sample live values into the in-memory record now (before an operation reads it). No write. */
export function sampleCollectors(): void {
  if (!active) return;
  collectors.forEach((fn) => {
    try {
      fn();
    } catch (e) {
      console.error("[save] collector failed", e);
    }
  });
}

/** Benchmarks / test isolation: no IndexedDB write happens while any reason holds. */
export function suspendSaveWrites(on: boolean, reason = "manual"): void {
  if (on) suspendedBy.add(reason);
  else suspendedBy.delete(reason);
  lastCollectMs = 0;
}

const isSuspended = (): boolean => suspendedBy.size > 0;

function runCollectors(rec: SaveRecord, skip: boolean): void {
  const now = performance.now();
  if (lastCollectMs > 0 && !isSimPaused()) rec.meta.playTimeS += Math.min((now - lastCollectMs) / 1000, MAX_PLAY_STEP_S);
  lastCollectMs = now;
  if (skip) return;
  collectors.forEach((fn) => {
    try {
      fn();
    } catch (e) {
      console.error("[save] collector failed", e);
    }
  });
}

async function doFlush(force: boolean, skipCollectors = false): Promise<boolean> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const rec = active;
  if (!rec || (isSuspended() && !force)) return false;
  runCollectors(rec, skipCollectors);
  if (!dirty && !force) return false;
  dirty = false;
  rec.meta.lastPlayedAt = Date.now();
  try {
    await putWorld(rec.meta, rec.data);
    lastFlushedAt = Date.now();
    return true;
  } catch (e) {
    dirty = true;
    console.error("[save] flush failed", e);
    return false;
  }
}

/** Write now if dirty (after sampling collectors). Resolves true when a write happened. */
export function flush(force = false): Promise<boolean> {
  const run = () => doFlush(force);
  flushChain = flushChain.then(run, run);
  return flushChain;
}

function installLifecycle(): void {
  if (lifecycleInstalled || typeof window === "undefined") return;
  lifecycleInstalled = true;
  const flushNow = () => {
    if (!active || isSuspended()) return;
    dirty = true;
    void flush();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushNow();
  });
  window.addEventListener("pagehide", flushNow);
  setInterval(() => {
    if (!isSuspended() && document.visibilityState === "visible") markDirty();
  }, PLAY_TICK_MS);
}

/**
 * One writer per world across tabs: each tab holds a whole-record snapshot, so a second
 * tab's flush would overwrite the first one's progress. The wait covers a reload's old page.
 */
function acquireWriterLock(id: WorldId): Promise<boolean> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    locks
      .request(`stellar-nomad-world:${id}`, { signal: AbortSignal.timeout(WRITER_LOCK_WAIT_MS) }, () => {
        resolve(true);
        return new Promise<never>(() => {});
      })
      .catch(() => resolve(false));
  });
}

async function setActive(rec: SaveRecord): Promise<SaveMeta> {
  if (!(await acquireWriterLock(rec.meta.id))) {
    suspendSaveWrites(true, "other-tab");
    console.warn("[save] this world is open in another tab: this tab will not save");
  }
  active = rec;
  dirty = false;
  lastCollectMs = 0;
  rec.meta.schemaVersion = SCHEMA_VERSION;
  // localStorage (and with it the device id) can be cleared independently of IndexedDB.
  const ids = Object.keys(rec.data.players);
  const local = getLocalPlayerId();
  if (ids.length === 1 && ids[0] !== local) {
    rec.data.players = { [local]: rec.data.players[ids[0]] };
    markDirty();
  }
  getLocalPlayerState();
  setLastWorldId(rec.meta.id);
  installLifecycle();
  return rec.meta;
}

export async function createWorld(opts: { name: string; seed: number; difficulty: Difficulty }): Promise<SaveMeta> {
  const first = (await listWorlds()).length === 0;
  const now = Date.now();
  const meta: SaveMeta = {
    id: newWorldId(),
    name: opts.name,
    seed: opts.seed >>> 0,
    difficulty: opts.difficulty,
    createdAt: now,
    lastPlayedAt: now,
    playTimeS: 0,
    schemaVersion: SCHEMA_VERSION,
  };
  const data = defaultSaveData(getLocalPlayerId());
  await putWorld(meta, data);
  if (first) requestPersistentStorage();
  return setActive({ meta, data });
}

export async function activateWorld(id: WorldId): Promise<SaveMeta> {
  const rec = await loadWorld(id);
  if (!rec) throw new Error(`[save] world ${id} not found`);
  return setActive(rec);
}

/**
 * Same meta, fresh data, written immediately even while suspended. The caller MUST reload:
 * live atoms and collectors still hold pre-reset values, so writes stay suspended until then.
 */
export async function resetActiveWorld(): Promise<void> {
  const rec = requireActive();
  rec.data = defaultSaveData(getLocalPlayerId());
  rec.meta.playTimeS = 0;
  dirty = true;
  const run = () => doFlush(true, true);
  flushChain = flushChain.then(run, run);
  await flushChain;
  suspendSaveWrites(true, "reset-pending-reload");
}

/** Store `id` as the world to boot and reload: module-level singletons make an in-place switch unsafe. */
export function switchWorld(id: WorldId): void {
  setLastWorldId(id);
  const url = new URL(window.location.href);
  url.searchParams.delete("world");
  window.location.replace(url.toString());
}

export function saveInfo(): {
  id: WorldId | null;
  name: string | null;
  schemaVersion: number;
  dirty: boolean;
  suspended: boolean;
  lastFlushedAt: number;
  playTimeS: number;
} {
  return {
    id: active?.meta.id ?? null,
    name: active?.meta.name ?? null,
    schemaVersion: active?.data.schemaVersion ?? SCHEMA_VERSION,
    dirty,
    suspended: isSuspended(),
    lastFlushedAt,
    playTimeS: active ? Math.round(active.meta.playTimeS * 10) / 10 : 0,
  };
}

/** Deep copy of the in-memory data (tests). */
export function snapshotActiveData(): SaveData | null {
  return active ? structuredClone(active.data) : null;
}
