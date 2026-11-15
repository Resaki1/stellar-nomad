/**
 * Import of the pre-M0.3 localStorage gameplay keys: into "World 1" on a first boot, else into
 * an extra, non-activated "Legacy import" world. Keys are removed only after an equal read-back.
 */
import { Vector3 } from "three";
import { getItemDef, type ItemSlot } from "@/data/content";
import { updateEphemerisPositions } from "@/sim/celestialConstants";
import { DEFAULT_SIM_EPOCH_MS, jdFromUnixMs } from "@/sim/ephemeris";
import { SYSTEM_FRAME_ID, frameOriginKm, isFrameId, selectFrame } from "@/sim/frames";
import { SCHEMA_VERSION, defaultPlayerState, defaultWorldState } from "./defaults";
import { getLocalPlayerId, setLastWorldId } from "./playerId";
import { deleteWorld, listWorlds, loadWorld, newWorldId, putWorld, requestPersistentStorage } from "./saveDb";
import { sanitizePlayer, sanitizePose, sanitizeWreck } from "./validate";
import { LEGACY_KEYS, hasLegacyKeys } from "./legacyKeys";

export { LEGACY_KEYS, hasLegacyKeys };
import { UNCHUNKED, type SaveData, type SaveMeta, type ShipPose, type WreckRecord } from "./types";


function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const _o = new Vector3();

/** System-frame km → frame-relative, resolved at the default epoch the legacy save was recorded at. */
function toFrameRelative(p: [number, number, number]): { frameId: string; positionKm: [number, number, number] } {
  const frameId = selectFrame({ x: p[0], y: p[1], z: p[2] }, SYSTEM_FRAME_ID);
  frameOriginKm(frameId, _o);
  return { frameId, positionKm: [p[0] - _o.x, p[1] - _o.y, p[2] - _o.z] };
}

function legacyShip(v: unknown): ShipPose | null {
  if (!isObj(v)) return null;
  if (v.version === 2) {
    const pose = sanitizePose(v);
    return pose && isFrameId(pose.frameId) ? pose : null;
  }
  if (v.version !== 1) return null;
  const pose = sanitizePose({ ...v, frameId: SYSTEM_FRAME_ID });
  return pose ? { ...toFrameRelative(pose.positionKm), quaternion: pose.quaternion } : null;
}

function legacyWreck(v: unknown): WreckRecord | null {
  if (isObj(v) && v.frameId === undefined) {
    const w = sanitizeWreck({ ...v, frameId: SYSTEM_FRAME_ID });
    return w ? { ...w, ...toFrameRelative(w.positionKm) } : null;
  }
  const w = sanitizeWreck(v);
  return w && isFrameId(w.frameId) ? w : null;
}

/** v1 modules had no equippedModules: auto-equip every owned module (last wins per slot). */
function legacyModules(): unknown {
  const v2 = readJson("modules-v2");
  const v1 = v2 === undefined ? readJson("modules-v1") : v2;
  if (!isObj(v1) || isObj(v1.equippedModules)) return v1;
  const equipped: Partial<Record<ItemSlot, string>> = {};
  const owned = Array.isArray(v1.ownedModules) ? v1.ownedModules : [];
  for (const id of owned) {
    const def = typeof id === "string" ? getItemDef(id) : undefined;
    if (def && def.type === "module") equipped[def.slot] = def.id;
  }
  return { ...v1, equippedModules: equipped };
}


export function buildLegacySave(playerId: string): SaveData {
  updateEphemerisPositions(jdFromUnixMs(DEFAULT_SIM_EPOCH_MS));
  const death = readJson("death-v1");
  const research = readJson("research-v1");
  const player = sanitizePlayer({
    ...defaultPlayerState(),
    ship: legacyShip(readJson("ship-state-v1")),
    isDead: isObj(death) && death.isDead === true,
    cargo: readJson("cargo"),
    research,
    modules: legacyModules(),
    shipConfig: readJson("ship-config-v1"),
    aiName: readJson("ai-name-v1") ?? null,
    commsPlayed: readJson("comms-played-v1"),
    starMarkers: readJson("star-markers-v1"),
    minedLifetime: readJson("asteroids-mined-lifetime-v1"),
  });

  const world = defaultWorldState();
  const wrecks = isObj(death) && Array.isArray(death.wrecks) ? death.wrecks : [];
  world.wrecks = wrecks.map(legacyWreck).filter((w): w is WreckRecord => w !== null);
  const deltas = readJson("asteroid-deltas-v1");
  if (isObj(deltas) && deltas.version === 1 && isObj(deltas.fields)) {
    for (const [fieldId, f] of Object.entries(deltas.fields)) {
      const ids = isObj(f) && Array.isArray(f.destroyed) ? f.destroyed : [];
      const clean = ids.filter((id): id is number => typeof id === "number" && Number.isFinite(id)).map((id) => id >>> 0);
      if (clean.length > 0) world.asteroidDeltas[fieldId] = { [UNCHUNKED]: clean };
    }
  }
  return { schemaVersion: SCHEMA_VERSION, world, players: { [playerId]: player } };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const rb = b as Record<string, unknown>;
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => k in rb && deepEqual((a as Record<string, unknown>)[k], rb[k]));
}

/** Returns the new world's meta, or null when nothing was imported. */
export async function importLegacyIfNeeded(): Promise<SaveMeta | null> {
  if (!hasLegacyKeys()) return null;
  const firstWorld = (await listWorlds()).length === 0;
  const data = buildLegacySave(getLocalPlayerId());
  const now = Date.now();
  const meta: SaveMeta = {
    id: newWorldId(),
    name: firstWorld ? "World 1" : "Legacy import",
    seed: (Math.random() * 2 ** 32) >>> 0,
    difficulty: "standard",
    createdAt: now,
    lastPlayedAt: now,
    playTimeS: 0,
    schemaVersion: SCHEMA_VERSION,
  };
  await putWorld(meta, data);
  requestPersistentStorage();
  const back = await loadWorld(meta.id);
  if (!back || !deepEqual(back.data, data)) {
    // Drop the copy so the retry on the next boot cannot leave duplicates behind.
    await deleteWorld(meta.id);
    console.error("[save] legacy import did not read back equal; legacy keys kept");
    return null;
  }
  for (const k of LEGACY_KEYS) localStorage.removeItem(k);
  if (firstWorld) setLastWorldId(meta.id);
  return meta;
}
