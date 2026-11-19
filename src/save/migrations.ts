/**
 * Ordered save migrations: MIGRATIONS[i] upgrades schemaVersion i+1 → i+2 and must set the
 * new `schemaVersion`. Append only; never edit a shipped entry. `parseSaveData` applies them.
 * They run on untrusted JSON: shape-check what they read and leave cleaning to the sanitisers.
 */
import { PROPELLANT_TANK_KG, RECOVERY_ALLOWANCE_KG } from "@/sim/ship/shipResources";
import { STARTER_POINT_ID, starterPoint } from "@/sim/replication/points";
import { LEGACY_CONSUMABLE_MAP, LEGACY_ITEM_MAP, LEGACY_RESEARCH_MAP, V3_ITEM_SLOTS, V3_NODE_IDS, V3_STACK_MAX } from "./legacyMap3";

export type SaveMigration = (data: Record<string, unknown>) => Record<string, unknown>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 1 → 2 (M3.1): completed research moves from every player into one world record (union, first
 * completion order, players in key order); wrecks gain empty fuel/consumable stores; players
 * gain full tanks, a charged capacitor, no heat and no batch; the world gains a receipt log.
 */
function v1ToV2(data: Obj): Obj {
  const world: Obj = isObj(data.world) ? { ...data.world } : {};
  const playersIn: Obj = isObj(data.players) ? data.players : {};
  const completed: string[] = [];
  const seen = new Set<string>();
  const players: Obj = {};
  for (const id of Object.keys(playersIn)) {
    const p = playersIn[id];
    if (!isObj(p)) {
      players[id] = p;
      continue;
    }
    const research: Obj = isObj(p.research) ? { ...p.research } : {};
    if (Array.isArray(research.completedNodes)) {
      for (const n of research.completedNodes) {
        if (typeof n === "string" && !seen.has(n)) {
          seen.add(n);
          completed.push(n);
        }
      }
    }
    delete research.completedNodes;
    players[id] = {
      ...p,
      research,
      propellant: { ordinaryKg: PROPELLANT_TANK_KG, protectedKg: RECOVERY_ALLOWANCE_KG },
      power: { capacitor01: 1, heat01: 0 },
      processing: null,
    };
  }
  if (Array.isArray(world.wrecks)) {
    world.wrecks = world.wrecks.map((w) => (isObj(w) ? { ...w, fuelKg: 0, consumables: {} } : w));
  }
  world.research = { completedNodes: completed };
  world.receipts = [];
  return { ...data, schemaVersion: 2, world, players };
}

const has = (o: Readonly<Record<string, unknown>>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : 0);

/** Old research ids → schema-3 options (appended to `into`), or the unmapped id. */
function mapNodes(ids: unknown, into: string[], seen: Set<string>, legacy: string[]): void {
  if (!Array.isArray(ids)) return;
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const mapped = V3_NODE_IDS.includes(id) ? [id] : has(LEGACY_RESEARCH_MAP, id) ? LEGACY_RESEARCH_MAP[id] : null;
    if (!mapped) {
      if (!legacy.includes(id)) legacy.push(id);
      continue;
    }
    for (const n of mapped) {
      if (seen.has(n)) continue;
      seen.add(n);
      into.push(n);
    }
  }
}

/**
 * 2 → 3 (M3.3/M3.4): the discovery catalogue (tables in legacyMap3.ts). Completed research
 * maps to new options; a paid active timer completes its mapped options once; assay samples,
 * retired items and unknown ids move to an inert per-player `legacy` record; owned/equipped
 * modules, consumables and hotbar entries map; the world gains empty discoveries.
 */
function v2ToV3(data: Obj): Obj {
  const world: Obj = isObj(data.world) ? { ...data.world } : {};
  const research: Obj = isObj(world.research) ? world.research : {};
  const completed: string[] = [];
  const seen = new Set<string>();
  const legacyNodes: string[] = [];
  mapNodes(research.completedNodes, completed, seen, legacyNodes);
  if (Array.isArray(research.legacy)) for (const id of research.legacy) if (typeof id === "string" && !legacyNodes.includes(id)) legacyNodes.push(id);

  const playersIn: Obj = isObj(data.players) ? data.players : {};
  const players: Obj = {};
  for (const pid of Object.keys(playersIn)) {
    const p = playersIn[pid];
    if (!isObj(p)) {
      players[pid] = p;
      continue;
    }
    const notes: string[] = [];
    const legacyItems: string[] = [];
    const legacyCons: Record<string, number> = {};
    const r: Obj = isObj(p.research) ? p.research : {};
    const assay = count(r.assaySamples);
    if (assay > 0) notes.push(`${assay} assay samples retired`);
    let legacyActive: { nodeId: string; elapsedS: number } | null = null;
    const active = isObj(r.activeResearch) ? r.activeResearch : null;
    if (active && typeof active.nodeId === "string") {
      const before = completed.length;
      const unmapped: string[] = [];
      mapNodes([active.nodeId], completed, seen, unmapped);
      if (unmapped.length > 0) {
        const elapsed = typeof active.elapsedS === "number" && Number.isFinite(active.elapsedS) ? Math.max(0, active.elapsedS) : 0;
        legacyActive = { nodeId: active.nodeId, elapsedS: elapsed };
        notes.push(`active research ${active.nodeId} kept inert`);
      } else {
        notes.push(`paid research ${active.nodeId} completed as ${completed.slice(before).join(", ") || "nothing new"}`);
      }
    }

    const m: Obj = isObj(p.modules) ? p.modules : {};
    const owned: string[] = [];
    for (const id of Array.isArray(m.ownedModules) ? m.ownedModules : []) {
      if (typeof id !== "string") continue;
      const to = has(V3_ITEM_SLOTS, id) ? id : has(LEGACY_ITEM_MAP, id) ? LEGACY_ITEM_MAP[id] : null;
      if (to) {
        if (!owned.includes(to)) owned.push(to);
      } else if (!legacyItems.includes(id)) legacyItems.push(id);
    }
    const equippedIn: Obj = isObj(m.equippedModules) ? m.equippedModules : {};
    const equipped: Record<string, string> = {};
    for (const slot of Object.keys(equippedIn)) {
      const id = equippedIn[slot];
      if (typeof id !== "string") continue;
      const to = has(V3_ITEM_SLOTS, id) ? id : has(LEGACY_ITEM_MAP, id) ? LEGACY_ITEM_MAP[id] : null;
      if (!to || !owned.includes(to)) continue;
      const toSlot = V3_ITEM_SLOTS[to];
      if (toSlot === "utility" && to === "special_transit_drive") continue;
      if (!has(equipped, toSlot) && !Object.values(equipped).includes(to)) equipped[toSlot] = to;
    }
    const consIn: Obj = isObj(m.consumables) ? m.consumables : {};
    const cons: Record<string, number> = {};
    for (const id of Object.keys(consIn)) {
      const n = count(consIn[id]);
      if (n === 0) continue;
      const rule = has(V3_STACK_MAX, id) && !has(LEGACY_CONSUMABLE_MAP, id) ? { to: id, per: 1 } : has(LEGACY_CONSUMABLE_MAP, id) ? LEGACY_CONSUMABLE_MAP[id] : null;
      if (!rule) {
        legacyCons[id] = (legacyCons[id] ?? 0) + n;
        continue;
      }
      const max = V3_STACK_MAX[rule.to] ?? 99;
      const room = Math.max(0, max - (cons[rule.to] ?? 0));
      const take = Math.min(n, Math.floor(room / rule.per));
      if (take > 0) cons[rule.to] = (cons[rule.to] ?? 0) + take * rule.per;
      if (n > take) legacyCons[id] = (legacyCons[id] ?? 0) + (n - take);
    }
    const hotbarIn = Array.isArray(m.hotbar) ? m.hotbar : [];
    const hotbar: (string | null)[] = [];
    for (const x of hotbarIn) {
      const rule = typeof x === "string" ? (has(LEGACY_CONSUMABLE_MAP, x) ? LEGACY_CONSUMABLE_MAP[x] : has(V3_STACK_MAX, x) ? { to: x, per: 1 } : null) : null;
      const to = rule && !hotbar.includes(rule.to) ? rule.to : null;
      hotbar.push(to);
    }
    if (legacyItems.length > 0) notes.push(`retired items kept inert: ${legacyItems.join(", ")}`);
    const anyLegacy = assay > 0 || legacyActive !== null || legacyItems.length > 0 || Object.keys(legacyCons).length > 0;
    const next: Obj = {
      ...p,
      modules: { ...m, ownedModules: owned, equippedModules: equipped, consumables: cons, hotbar },
      bookmarks: [],
      legacy: anyLegacy ? { assaySamples: assay, activeResearch: legacyActive, items: legacyItems, consumables: legacyCons, notes } : null,
    };
    delete next.research;
    players[pid] = next;
  }
  world.research = { completedNodes: completed, legacy: legacyNodes };
  world.discoveries = { families: {}, sources: [], sites: {}, trials: {} };
  return { ...data, schemaVersion: 3, world, players };
}

/**
 * 3 → 4 (M3.6): the world gains the protected starter replication point; every player (dead
 * ones included) selects it. Poses are untouched, so a live remote ship is not relocated.
 */
function v3ToV4(data: Obj): Obj {
  const world: Obj = isObj(data.world) ? { ...data.world } : {};
  world.replication = { points: [starterPoint()] };
  const playersIn: Obj = isObj(data.players) ? data.players : {};
  const players: Obj = {};
  for (const pid of Object.keys(playersIn)) {
    const p = playersIn[pid];
    players[pid] = isObj(p) ? { ...p, replication: { activeId: STARTER_POINT_ID } } : p;
  }
  return { ...data, schemaVersion: 4, world, players };
}

/**
 * 4 → 5 (M3.7): site inspections (a recovered site counts as inspected), no tracked project.
 * Difficulty lives in the meta, already defaulted to "standard" by `parseSaveMeta`.
 */
function v4ToV5(data: Obj): Obj {
  const world: Obj = isObj(data.world) ? { ...data.world } : {};
  const disc: Obj = isObj(world.discoveries) ? { ...world.discoveries } : {};
  disc.inspectedSites = isObj(disc.sites) ? { ...disc.sites } : {};
  world.discoveries = disc;
  const playersIn: Obj = isObj(data.players) ? data.players : {};
  const players: Obj = {};
  for (const pid of Object.keys(playersIn)) {
    const p = playersIn[pid];
    players[pid] = isObj(p) ? { ...p, trackedProject: null } : p;
  }
  return { ...data, schemaVersion: 5, world, players };
}

/**
 * 5 → 6 (M4.0): revision counter, session generation, members (every existing player becomes an
 * owner-style member without a verifier) and an empty command stream per player.
 */
function v5ToV6(data: Obj): Obj {
  const world: Obj = isObj(data.world) ? { ...data.world } : {};
  const playersIn: Obj = isObj(data.players) ? data.players : {};
  const players: Obj = {};
  const members: Obj = {};
  for (const pid of Object.keys(playersIn)) {
    const p = playersIn[pid];
    players[pid] = isObj(p) ? { ...p, stream: { seq: 0, opId: null, outcome: null } } : p;
    members[pid] = { name: "", verifier: null, joinedAt: 0 };
  }
  world.revision = 0;
  world.session = { generation: 0 };
  world.members = members;
  return { ...data, schemaVersion: 6, world, players };
}

export const MIGRATIONS: readonly SaveMigration[] = [v1ToV2, v2ToV3, v3ToV4, v4ToV5, v5ToV6];
