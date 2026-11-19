/**
 * Operation reducers: validate every affected slice, then return a commit that only assigns.
 * Nothing is written before validation finishes, so a rejection changes nothing.
 */
import { ALL_ITEM_SLOTS, MATERIAL_NAMES, REPAIR_MATERIAL_ID, getItemDef, getProcessingRecipe, getResearchNode, getSiteDef, getTrialDef } from "@/data/content";
import { hullRepairable } from "@/sim/ship/hull";
import { MAX_BOOKMARKS } from "@/save/defaults";
import type { PlayerId, PlayerState, QuatTuple, Vec3Tuple, WorldState, WreckRecord } from "@/save/types";
import { isFrameId } from "@/sim/frames";
import { planExtraction, planInspection, planStamp, sourceIdOf } from "@/sim/research/discoveries";
import { evaluateNode, missingAnalysis, unlockedItemIds } from "@/sim/research/requirements";
import { cargoUsedUnits, equipTuning, persistentShipConfig } from "@/sim/ship/loadout";
import { unconvertedUnits } from "@/sim/ship/resourceStep";
import { DEFAULT_RESOURCE_TUNING, getEffectiveTuning, type ResourceTuning } from "@/sim/ship/resourceTuning";
import type { AsteroidDeltaIndex } from "./asteroidDeltas";
import { checkPlacement, poseDistanceKm, resolveRecovery, validPose, type PlacementCheck } from "@/sim/replication/placement";
import { MAX_POINTS, REPLICATION_KIT_ID, REPLICATION_TUNING, STARTER_POINT_ID, cleanPointName } from "@/sim/replication/points";
import type { MineResolver } from "@/sim/asteroids/mineResolve";
import type { OperationResult, RejectReason, Transfer, WorldEvent, WorldOperation } from "./commands";

export interface ReduceCtx {
  world: WorldState;
  /** null when `by` is not a player of this world. */
  player: PlayerState | null;
  by: PlayerId;
  asteroids: AsteroidDeltaIndex;
  /** Wall clock, ms, supplied by the authority so the reducer stays pure. */
  now: number;
  /** Source ids any player has bookmarked (eviction protection). */
  bookmarked: () => ReadonlySet<string>;
  /** Re-derives a mined rock's yield; when present the op's `yield` claim is ignored. */
  resolveMine?: MineResolver;
}

export interface Commit {
  result: OperationResult;
  /** Assignments only; must not throw. */
  apply: () => void;
  events: WorldEvent[];
  playerKeys: (keyof PlayerState)[];
}

export interface Rejection {
  reason: RejectReason;
  missing?: Record<string, number>;
  evidence?: string[];
}

export type Reduction = Commit | Rejection;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isCount = (v: unknown): v is number => isNum(v) && v >= 0 && Number.isInteger(v);
const reject = (reason: RejectReason, missing?: Record<string, number>): Rejection => (missing ? { reason, missing } : { reason });
const DEFAULT_STACK_MAX = 99;
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function validAsteroid(op: { fieldId: string; chunkKey: string; instanceId: number }): boolean {
  const id = op.instanceId;
  return !!op.fieldId && !!op.chunkKey && isNum(id) && id >= 0 && id <= 0xffffffff && Number.isInteger(id);
}

function completedSet(world: WorldState): Set<string> {
  return new Set(world.research.completedNodes);
}

const _tuning: ResourceTuning = { ...DEFAULT_RESOURCE_TUNING };
const _placement: PlacementCheck = { refusal: null, bodyAltKm: 0, bodyId: null, rockClearM: 0 };
/** The live resource table with this player's equipment applied (tank, reactor, rates). */
function shipTuning(player: PlayerState, world: WorldState): Readonly<ResourceTuning> {
  return equipTuning(getEffectiveTuning(), persistentShipConfig(player, completedSet(world)), _tuning);
}

/** This player's tank capacity with equipment and research applied (kg). */
export function tankCapacityKg(player: PlayerState, world: WorldState): number {
  return shipTuning(player, world).tankKg;
}

const discoveriesEvent = (by: PlayerId): WorldEvent => ({ type: "discoveries.changed", by });

function cargoRemaining(player: PlayerState, world: WorldState): number {
  const cap = player.cargo.capacityUnits + persistentShipConfig(player, completedSet(world)).bonusCargoCapacity;
  return Math.max(0, Math.floor(cap) - cargoUsedUnits(player.cargo.items));
}

/** Why `modules` cannot be fitted with this player's current fuel and cargo, or null. */
function loadoutOverflow(player: PlayerState, world: WorldState, modules: PlayerState["modules"]): RejectReason | null {
  const next = { ...player, modules };
  if (cargoUsedUnits(player.cargo.items) > Math.floor(player.cargo.capacityUnits + persistentShipConfig(next, completedSet(world)).bonusCargoCapacity)) return "cargo_overflow";
  if (player.propellant.ordinaryKg > shipTuning(next, world).tankKg + 1e-6) return "tank_overflow";
  return null;
}

export function reduce(op: WorldOperation, ctx: ReduceCtx): Reduction {
  const { world, player, by, asteroids, now } = ctx;
  switch (op.type) {
    case "time.set": {
      if (op.epochMs === undefined && op.rate === undefined) return reject("invalid");
      if (op.epochMs !== undefined && !isNum(op.epochMs)) return reject("invalid");
      if (op.rate !== undefined && !isNum(op.rate)) return reject("invalid");
      return {
        result: { type: "time.set" },
        apply: () => {
          if (op.epochMs !== undefined) world.simEpochMs = op.epochMs;
          if (op.rate !== undefined) world.simRate = op.rate;
        },
        events: [{ type: "time.changed", by, epochMs: op.epochMs, rate: op.rate }],
        playerKeys: [],
      };
    }

    case "asteroid.destroy": {
      if (!validAsteroid(op)) return reject("invalid");
      if (asteroids.has(op.fieldId, op.chunkKey, op.instanceId)) return reject("already_done");
      const plan = planExtraction(world.discoveries, sourceIdOf(op.fieldId, op.chunkKey, op.instanceId), null, by, now);
      const events: WorldEvent[] = [{ type: "asteroid.destroyed", by, fieldId: op.fieldId, chunkKey: op.chunkKey, instanceId: op.instanceId, cause: op.cause }];
      if (plan) events.push(discoveriesEvent(by));
      return {
        result: { type: "asteroid.destroy" },
        apply: () => {
          asteroids.add(op.fieldId, op.chunkKey, op.instanceId);
          if (plan) world.discoveries = plan.next;
        },
        events,
        playerKeys: [],
      };
    }

    case "research.devSet": {
      if (!Array.isArray(op.nodeIds) || !op.nodeIds.every((x) => typeof x === "string")) return reject("invalid");
      const completedNodes = Array.from(new Set(op.nodeIds));
      return {
        result: { type: "research.devSet", count: completedNodes.length },
        apply: () => {
          world.research = { completedNodes, legacy: world.research.legacy };
        },
        events: [{ type: "research.changed", by, completedNodes }],
        playerKeys: [],
      };
    }

    case "wreck.collect":
    case "asteroid.mine":
    case "item.craft":
    case "survey.inspect":
    case "research.unlock":
    case "trial.record":
    case "site.inspect":
    case "site.recover":
    case "bookmark.set":
    case "module.equip":
    case "ship.destroy":
    case "ship.respawn":
    case "processing.start":
    case "processing.cancel":
    case "ship.repair":
    case "replication.place":
    case "replication.activate":
    case "replication.deactivate":
    case "replication.rename":
      break;
  }

  if (!player) return reject("unknown_player");
  const p = player;

  switch (op.type) {
    case "asteroid.mine": {
      if (!validAsteroid(op)) return reject("invalid");
      if (op.beamS !== undefined && !(isNum(op.beamS) && op.beamS >= 0)) return reject("invalid");
      let yieldUnits: Record<string, number>;
      if (ctx.resolveMine) {
        if (p.isDead) return reject("dead");
        if (asteroids.has(op.fieldId, op.chunkKey, op.instanceId)) return reject("already_done");
        const rock = ctx.resolveMine(op.fieldId, op.chunkKey, op.instanceId, p);
        if (!rock) return reject("not_found");
        yieldUnits = rock.yield;
      } else {
        if (typeof op.yield !== "object" || op.yield === null) return reject("invalid");
        yieldUnits = op.yield;
      }
      for (const k of Object.keys(yieldUnits)) if (!has(MATERIAL_NAMES, k) || !isCount(yieldUnits[k])) return reject("invalid");
      if (p.isDead) return reject("dead");
      if (asteroids.has(op.fieldId, op.chunkKey, op.instanceId)) return reject("already_done");
      let room = cargoRemaining(p, world);
      const granted: Record<string, number> = {};
      const overflow: Record<string, number> = {};
      const items = { ...p.cargo.items };
      for (const k of Object.keys(yieldUnits)) {
        const want = yieldUnits[k];
        if (want <= 0) continue;
        const n = Math.min(want, room);
        room -= n;
        if (n > 0) {
          granted[k] = n;
          items[k] = (items[k] ?? 0) + n;
        }
        if (want > n) overflow[k] = want - n;
      }
      const cargo = { ...p.cargo, items };
      const minedLifetime = p.minedLifetime + 1;
      // Evidence from what was actually extracted (overflow left behind still confirms the rock).
      const sourceId = sourceIdOf(op.fieldId, op.chunkKey, op.instanceId);
      const plan = planExtraction(world.discoveries, sourceId, yieldUnits, by, now);
      // B4: a mined rock is gone; the miner's bookmark of it goes in the same transaction.
      const dropMark = p.bookmarks.some((b) => b.sourceId === sourceId);
      const bookmarks = dropMark ? p.bookmarks.filter((b) => b.sourceId !== sourceId) : p.bookmarks;
      const events: WorldEvent[] = [{ type: "asteroid.destroyed", by, fieldId: op.fieldId, chunkKey: op.chunkKey, instanceId: op.instanceId, cause: "mined" }];
      if (plan) events.push(discoveriesEvent(by));
      return {
        result: { type: "asteroid.mine", granted, overflow, newFamilies: plan?.newFamilies ?? [], depletedSource: plan?.depletedSource ?? null },
        apply: () => {
          asteroids.add(op.fieldId, op.chunkKey, op.instanceId);
          p.cargo = cargo;
          p.minedLifetime = minedLifetime;
          p.bookmarks = bookmarks;
          if (plan) world.discoveries = plan.next;
        },
        events,
        playerKeys: dropMark ? ["cargo", "minedLifetime", "bookmarks"] : ["cargo", "minedLifetime"],
      };
    }

    case "item.craft": {
      const def = typeof op.itemId === "string" ? getItemDef(op.itemId) : undefined;
      if (!def) return reject("unknown_item");
      if (p.isDead) return reject("dead");
      if (!unlockedItemIds(completedSet(world)).has(def.id)) return reject("locked");
      const m = p.modules;
      if (def.type !== "consumable" && m.ownedModules.includes(def.id)) return reject("owned");
      if (def.type === "consumable" && (m.consumables[def.id] ?? 0) >= (def.stackMax ?? DEFAULT_STACK_MAX)) return reject("stack_full");
      const missing: Record<string, number> = {};
      for (const [rid, need] of Object.entries(def.recipe)) {
        const have = Math.floor(p.cargo.items[rid] ?? 0);
        if (have < need) missing[rid] = need - have;
      }
      if (Object.keys(missing).length > 0) return reject("materials", missing);

      const items = { ...p.cargo.items };
      for (const [rid, need] of Object.entries(def.recipe)) {
        items[rid] -= need;
        if (items[rid] <= 0) delete items[rid];
      }
      let autoEquipped = false;
      let hotbarIndex: number | null = null;
      let modules = m;
      if (def.type === "consumable") {
        const hotbar = [...m.hotbar];
        if (!hotbar.includes(def.id)) {
          const i = hotbar.indexOf(null);
          if (i !== -1) {
            hotbar[i] = def.id;
            hotbarIndex = i;
          }
        }
        modules = { ...m, consumables: { ...m.consumables, [def.id]: (m.consumables[def.id] ?? 0) + 1 }, hotbar };
      } else if (def.type === "module") {
        const owned = { ...m, ownedModules: [...m.ownedModules, def.id] };
        const fitted = { ...owned, equippedModules: { ...m.equippedModules, [def.slot]: def.id } };
        autoEquipped = !m.equippedModules[def.slot] && !loadoutOverflow({ ...p, cargo: { ...p.cargo, items } }, world, fitted);
        modules = autoEquipped ? fitted : owned;
      } else {
        modules = { ...m, ownedModules: [...m.ownedModules, def.id] };
      }
      const cargo = { ...p.cargo, items };
      const trial = planStamp(world.discoveries, "trials", "first_fabrication", by, now);
      return {
        result: { type: "item.craft", itemId: def.id, spent: { ...def.recipe }, autoEquipped, hotbarIndex, newTrial: !!trial },
        apply: () => {
          p.cargo = cargo;
          p.modules = modules;
          if (trial) world.discoveries = trial;
        },
        events: trial ? [discoveriesEvent(by)] : [],
        playerKeys: ["cargo", "modules"],
      };
    }

    case "survey.inspect": {
      if (!validAsteroid(op) || typeof op.classId !== "string" || !isNum(op.radiusM) || op.radiusM < 0) return reject("invalid");
      const pos = op.positionKm;
      if (!isFrameId(op.frameId) || !Array.isArray(pos) || pos.length !== 3 || !pos.every(isNum)) return reject("invalid");
      if (typeof op.composition !== "object" || op.composition === null) return reject("invalid");
      const composition: Record<string, number> = {};
      for (const k of Object.keys(op.composition)) {
        if (!has(MATERIAL_NAMES, k) || !isCount(op.composition[k])) return reject("invalid");
        if (op.composition[k] > 0) composition[k] = op.composition[k];
      }
      if (p.isDead) return reject("dead");
      const destroyed = asteroids.has(op.fieldId, op.chunkKey, op.instanceId);
      if (destroyed) return reject("not_found");
      const plan = planInspection(
        world.discoveries,
        { fieldId: op.fieldId, chunkKey: op.chunkKey, asteroidId: op.instanceId >>> 0, classId: op.classId, frameId: op.frameId, positionKm: [pos[0], pos[1], pos[2]], radiusM: op.radiusM, composition },
        false,
        by,
        now,
        ctx.bookmarked(),
      );
      if (!plan) return reject("already_done");
      return {
        result: { type: "survey.inspect", sourceId: sourceIdOf(op.fieldId, op.chunkKey, op.instanceId), newFamilies: plan.newFamilies, upgraded: plan.upgraded, evicted: plan.evicted },
        apply: () => {
          world.discoveries = plan.next;
        },
        events: [discoveriesEvent(by)],
        playerKeys: [],
      };
    }

    case "research.unlock": {
      const node = typeof op.nodeId === "string" ? getResearchNode(op.nodeId) : undefined;
      if (!node) return reject("not_found");
      if (p.isDead) return reject("dead");
      const completed = completedSet(world);
      if (completed.has(node.id)) return reject("already_done");
      const ev = evaluateNode(node, { discoveries: world.discoveries, completed });
      if (!ev.met) return { reason: "evidence", evidence: ev.missing };
      const short = missingAnalysis(node, p.cargo.items);
      if (Object.keys(short).length > 0) return reject("materials", short);
      const items = { ...p.cargo.items };
      for (const [k, n] of Object.entries(node.analysis)) {
        items[k] -= n;
        if (items[k] <= 0) delete items[k];
      }
      const cargo = { ...p.cargo, items };
      const completedNodes = [...world.research.completedNodes, node.id];
      return {
        result: { type: "research.unlock", nodeId: node.id, unlockedItems: [...node.unlocks.items], spent: { ...node.analysis } },
        apply: () => {
          world.research = { completedNodes, legacy: world.research.legacy };
          p.cargo = cargo;
        },
        events: [{ type: "research.changed", by, completedNodes }],
        playerKeys: ["cargo"],
      };
    }

    case "trial.record": {
      if (typeof op.trialId !== "string" || !getTrialDef(op.trialId)) return reject("not_found");
      if (p.isDead) return reject("dead");
      const next = planStamp(world.discoveries, "trials", op.trialId, by, now);
      if (!next) return reject("already_done");
      return { result: { type: "trial.record", trialId: op.trialId }, apply: () => {
          world.discoveries = next;
        }, events: [discoveriesEvent(by)], playerKeys: [] };
    }

    case "site.inspect":
    case "site.recover": {
      const site = typeof op.siteId === "string" ? getSiteDef(op.siteId) : undefined;
      if (!site) return reject("not_found");
      if (p.isDead) return reject("dead");
      const inspect = op.type === "site.inspect";
      if (inspect ? world.discoveries.inspectedSites[site.id] : world.discoveries.sites[site.id]) return reject("already_done");
      if (!inspect && !world.discoveries.inspectedSites[site.id]) return reject("not_inspected");
      const ship = p.ship;
      if (!ship || !isFrameId(ship.frameId) || !(poseDistanceKm(ship.frameId, ship.positionKm, site.frameId, site.positionKm) <= (inspect ? site.inspectRangeKm : site.recoverRangeKm))) return reject("too_far");
      if (inspect) {
        const next = planStamp(world.discoveries, "inspectedSites", site.id, by, now);
        if (!next) return reject("already_done");
        return { result: { type: "site.inspect", siteId: site.id }, apply: () => {
            world.discoveries = next;
          }, events: [discoveriesEvent(by)], playerKeys: [] };
      }
      const need = Object.values(site.reward).reduce((a, v) => a + v, 0);
      if (need > cargoRemaining(p, world)) return reject("no_capacity", { cargo: need - cargoRemaining(p, world) });
      const next = planStamp(world.discoveries, "sites", site.id, by, now);
      if (!next) return reject("already_done");
      const items = { ...p.cargo.items };
      for (const [k, n] of Object.entries(site.reward)) items[k] = (items[k] ?? 0) + n;
      const cargo = { ...p.cargo, items };
      return { result: { type: "site.recover", siteId: site.id, reward: { ...site.reward } }, apply: () => {
          world.discoveries = next;
          p.cargo = cargo;
        }, events: [discoveriesEvent(by)], playerKeys: ["cargo"] };
    }

    case "bookmark.set": {
      if (typeof op.sourceId !== "string" || (op.name !== null && typeof op.name !== "string")) return reject("invalid");
      // Bookmarks of evicted or depleted sources (destroyed, or mined by anyone) are dropped
      // here, so a hidden bookmark never holds capacity.
      const known = new Set(world.discoveries.sources.filter((s) => !s.depleted).map((s) => s.id));
      const rest = p.bookmarks.filter((b) => b.sourceId !== op.sourceId && known.has(b.sourceId));
      let bookmarks = rest;
      if (op.name !== null) {
        if (!known.has(op.sourceId)) return reject("not_found");
        if (rest.length >= MAX_BOOKMARKS && !p.bookmarks.some((b) => b.sourceId === op.sourceId)) return reject("no_capacity");
        const name = op.name.trim().slice(0, 40);
        bookmarks = [...rest, { sourceId: op.sourceId, name }];
      }
      return { result: { type: "bookmark.set", sourceId: op.sourceId, name: op.name }, apply: () => {
          p.bookmarks = bookmarks;
        }, events: [], playerKeys: ["bookmarks"] };
    }

    case "module.equip": {
      const slot = ALL_ITEM_SLOTS.find((s) => s === op.slot);
      if (!slot || (op.itemId !== null && typeof op.itemId !== "string")) return reject("invalid");
      const m = p.modules;
      const equippedModules = { ...m.equippedModules };
      if (op.itemId === null) {
        if (!equippedModules[slot]) return reject("already_done");
        delete equippedModules[slot];
      } else {
        const def = getItemDef(op.itemId);
        if (!def || def.type !== "module" || def.slot !== slot) return reject("unknown_item");
        if (!m.ownedModules.includes(def.id)) return reject("not_found");
        if (equippedModules[def.slot] === def.id) return reject("already_done");
        equippedModules[def.slot] = def.id;
      }
      const modules = { ...m, equippedModules };
      const overflow = loadoutOverflow(p, world, modules);
      if (overflow) return reject(overflow);
      return { result: { type: "module.equip", slot: op.slot, itemId: op.itemId }, apply: () => {
          p.modules = modules;
        }, events: [], playerKeys: ["modules"] };
    }

    case "ship.destroy": {
      const pos = op.positionKm;
      if (!isFrameId(op.frameId) || !Array.isArray(pos) || pos.length !== 3 || !pos.every(isNum)) return reject("invalid");
      if (op.cause !== undefined && op.cause !== "impact" && op.cause !== "abandon") return reject("invalid");
      if (p.isDead) return reject("already_done");
      const dropped: Transfer = { items: {}, consumables: {}, fuelKg: 0 };
      // Same rule as the save sanitiser (whole units), so the wreck holds exactly what a reload would.
      for (const [k, v] of Object.entries(p.cargo.items)) if (isNum(v) && v >= 1) dropped.items[k] = Math.floor(v);
      // Loose consumables (kits included) leave with the cargo; hotbar assignments stay.
      for (const [k, v] of Object.entries(p.modules.consumables)) if (isNum(v) && v >= 1) dropped.consumables[k] = Math.floor(v);
      // Unconverted feedstock leaves with the cargo; committed output is already in the ordinary tank.
      const batch = p.processing;
      if (batch) {
        const recipe = getProcessingRecipe(batch.recipeId);
        const reserved = recipe ? Math.floor(batch.reserved[recipe.inputId] ?? 0) : 0;
        const back = recipe ? unconvertedUnits(reserved, batch.committedKg, getEffectiveTuning().processingKgPerUnit) : 0;
        if (recipe && back > 0) dropped.items[recipe.inputId] = (dropped.items[recipe.inputId] ?? 0) + back;
      }
      // Ordinary fuel only, minus what refills the protected allowance: dying never adds usable fuel
      // (the refill is free only for a ship whose ordinary fuel cannot pay it).
      const ordinary = isNum(p.propellant.ordinaryKg) ? Math.max(0, p.propellant.ordinaryKg) : 0;
      const topUp = Math.min(ordinary, Math.max(0, getEffectiveTuning().recoveryAllowanceKg - p.propellant.protectedKg));
      dropped.fuelKg = ordinary - topUp;
      const hasDrop = Object.keys(dropped.items).length > 0 || Object.keys(dropped.consumables).length > 0 || dropped.fuelKg > 0;
      const wreck: WreckRecord | null = hasDrop
        ? {
            id: `wreck-${op.opId}`,
            frameId: op.frameId,
            positionKm: [pos[0], pos[1], pos[2]],
            items: dropped.items,
            fuelKg: dropped.fuelKg,
            consumables: dropped.consumables,
            createdAt: now,
          }
        : null;
      const cargo = { ...p.cargo, items: {} };
      const propellant = { ordinaryKg: 0, protectedKg: p.propellant.protectedKg + topUp };
      const modules = { ...p.modules, consumables: {}, consumableCooldowns: {} };
      return {
        result: { type: "ship.destroy", wreckId: wreck?.id ?? null, dropped, cause: op.cause ?? "impact" },
        apply: () => {
          if (wreck) world.wrecks = [...world.wrecks, wreck];
          p.isDead = true;
          p.health = 0;
          p.cargo = cargo;
          p.modules = modules;
          p.propellant = propellant;
          p.processing = null;
          p.lastLoss = { items: { ...dropped.items }, consumables: { ...dropped.consumables }, fuelKg: dropped.fuelKg, cause: op.cause ?? "impact" };
        },
        events: [{ type: "ship.destroyed", by, frameId: op.frameId, positionKm: pos, cause: op.cause ?? "impact" },
          ...(wreck ? [{ type: "wreck.created" as const, by, wreck }] : [])],
        playerKeys: ["isDead", "health", "cargo", "modules", "propellant", "processing", "lastLoss"],
      };
    }

    case "ship.respawn": {
      if (op.mode !== "active" && op.mode !== "starter") return reject("invalid");
      if (!p.isDead) return reject("not_dead");
      const health = persistentShipConfig(p, completedSet(world)).maxHealth;
      const dest = resolveRecovery(world.replication.points, p.replication.activeId, op.mode, asteroids);
      const ship = { frameId: dest.frameId, positionKm: dest.positionKm, quaternion: dest.quaternion };
      // Recovery: full hull, empty ordinary tank, exactly the protected allowance, a cold ship.
      const protectedKg = getEffectiveTuning().recoveryAllowanceKg;
      const propellant = { ordinaryKg: 0, protectedKg };
      const power = { capacitor01: 1, heat01: 0 };
      // A vanished point is forgotten; an obstructed or explicitly bypassed one stays selected.
      const replication = dest.fallback === "missing" ? { activeId: STARTER_POINT_ID } : p.replication;
      return {
        result: { type: "ship.respawn", health, destination: dest, protectedKg },
        apply: () => {
          p.isDead = false;
          p.health = health;
          p.ship = ship;
          p.propellant = propellant;
          p.power = power;
          p.processing = null;
          p.replication = replication;
          p.lastLoss = null;
        },
        events: [{ type: "ship.respawned", by }],
        playerKeys: ["isDead", "health", "ship", "propellant", "power", "processing", "replication", "lastLoss"],
      };
    }

    case "replication.place": {
      if (typeof op.name !== "string") return reject("invalid");
      if (p.isDead) return reject("dead");
      const id = `rp-${op.opId}`;
      const points = world.replication.points;
      if (points.some((x) => x.id === id)) return reject("already_done");
      if (points.length >= MAX_POINTS) return reject("no_capacity");
      const kits = Math.floor(p.modules.consumables[REPLICATION_KIT_ID] ?? 0);
      const check = checkPlacement(op, p.ship, kits, asteroids, _placement);
      if (check.refusal) return reject(check.refusal);
      const pos = op.positionKm, q = op.quaternion;
      const point = {
        id,
        name: cleanPointName(op.name, `Point ${points.length}`),
        frameId: op.frameId,
        positionKm: [pos[0], pos[1], pos[2]] as Vec3Tuple,
        quaternion: [q[0], q[1], q[2], q[3]] as QuatTuple,
        by,
        createdAt: now,
        starter: false,
      };
      const consumables: Record<string, number> = { ...p.modules.consumables, [REPLICATION_KIT_ID]: kits - 1 };
      if (consumables[REPLICATION_KIT_ID] <= 0) delete consumables[REPLICATION_KIT_ID];
      const modules = { ...p.modules, consumables };
      return {
        result: { type: "replication.place", point },
        apply: () => {
          world.replication = { points: [...points, point] };
          p.modules = modules;
          p.replication = { activeId: id };
        },
        events: [{ type: "replication.changed", by }],
        playerKeys: ["modules", "replication"],
      };
    }

    case "replication.activate": {
      const point = world.replication.points.find((x) => x.id === op.pointId);
      if (!point) return reject("not_found");
      if (p.isDead) return reject("dead");
      if (p.replication.activeId === point.id) return reject("already_done");
      if (!validPose(point.frameId, point.positionKm, point.quaternion)) return reject("invalid");
      const ship = p.ship;
      if (!ship || !isFrameId(ship.frameId) || !(poseDistanceKm(ship.frameId, ship.positionKm, point.frameId, point.positionKm) <= REPLICATION_TUNING.activateRangeKm)) return reject("too_far");
      return { result: { type: "replication.activate", pointId: point.id }, apply: () => {
          p.replication = { activeId: point.id };
        }, events: [], playerKeys: ["replication"] };
    }

    case "replication.deactivate": {
      if (p.replication.activeId === STARTER_POINT_ID) return reject("already_done");
      const was = p.replication.activeId;
      return { result: { type: "replication.deactivate", pointId: was }, apply: () => {
          p.replication = { activeId: STARTER_POINT_ID };
        }, events: [], playerKeys: ["replication"] };
    }

    case "replication.rename": {
      if (typeof op.name !== "string" || typeof op.pointId !== "string") return reject("invalid");
      const i = world.replication.points.findIndex((x) => x.id === op.pointId);
      if (i < 0) return reject("not_found");
      const point = world.replication.points[i];
      if (point.starter) return reject("invalid");
      const name = cleanPointName(op.name, point.name);
      if (name === point.name) return reject("already_done");
      const points = world.replication.points.map((x, k) => (k === i ? { ...x, name } : x));
      return { result: { type: "replication.rename", pointId: point.id, name }, apply: () => {
          world.replication = { points };
        }, events: [{ type: "replication.changed", by }], playerKeys: [] };
    }

    case "wreck.collect": {
      const idx = world.wrecks.findIndex((w) => w.id === op.wreckId);
      if (idx < 0) return reject("not_found");
      if (p.isDead) return reject("dead");
      const wreck = world.wrecks[idx];
      const taken: Transfer = { items: {}, consumables: {}, fuelKg: 0 };
      const leftItems = { ...wreck.items };
      const items = { ...p.cargo.items };
      let room = cargoRemaining(p, world);
      for (const k of Object.keys(leftItems)) {
        const n = Math.min(leftItems[k], room);
        if (n <= 0) continue;
        room -= n;
        taken.items[k] = n;
        items[k] = (items[k] ?? 0) + n;
        leftItems[k] -= n;
        if (leftItems[k] === 0) delete leftItems[k];
      }
      const leftCons = { ...wreck.consumables };
      const consumables = { ...p.modules.consumables };
      for (const k of Object.keys(leftCons)) {
        const max = getItemDef(k)?.stackMax ?? DEFAULT_STACK_MAX;
        const n = Math.min(leftCons[k], Math.max(0, max - (consumables[k] ?? 0)));
        if (n <= 0) continue;
        taken.consumables[k] = n;
        consumables[k] = (consumables[k] ?? 0) + n;
        leftCons[k] -= n;
        if (leftCons[k] === 0) delete leftCons[k];
      }
      const fuel = Math.min(wreck.fuelKg, Math.max(0, shipTuning(p, world).tankKg - p.propellant.ordinaryKg));
      taken.fuelKg = fuel;
      const anything = Object.keys(taken.items).length > 0 || Object.keys(taken.consumables).length > 0 || fuel > 0;
      const wasEmpty = Object.keys(wreck.items).length === 0 && Object.keys(wreck.consumables).length === 0 && wreck.fuelKg <= 0;
      if (!anything && !wasEmpty) return reject("no_capacity");
      const leftFuel = wreck.fuelKg - fuel;
      const removed = Object.keys(leftItems).length === 0 && Object.keys(leftCons).length === 0 && leftFuel <= 0;
      const next: WreckRecord = { ...wreck, items: leftItems, consumables: leftCons, fuelKg: leftFuel };
      const cargo = { ...p.cargo, items };
      const modules = { ...p.modules, consumables };
      const propellant = { ...p.propellant, ordinaryKg: p.propellant.ordinaryKg + fuel };
      return {
        result: { type: "wreck.collect", wreckId: wreck.id, taken, removed },
        apply: () => {
          world.wrecks = removed ? world.wrecks.filter((w) => w.id !== wreck.id) : world.wrecks.map((w) => (w.id === wreck.id ? next : w));
          p.cargo = cargo;
          p.modules = modules;
          p.propellant = propellant;
        },
        events: [removed ? { type: "wreck.removed", by, wreckId: wreck.id } : { type: "wreck.changed", by, wreck: next }],
        playerKeys: ["cargo", "modules", "propellant"],
      };
    }

    case "processing.start": {
      const recipe = typeof op.recipeId === "string" ? getProcessingRecipe(op.recipeId) : undefined;
      if (!recipe) return reject("not_found");
      const t = shipTuning(p, world);
      if (!isCount(op.units) || op.units < 1 || op.units > t.processingMaxBatchUnits) return reject("invalid");
      if (p.isDead) return reject("dead");
      if (p.processing) return reject("busy");
      if (p.propellant.ordinaryKg >= t.tankKg) return reject("tank_full");
      const have = Math.floor(p.cargo.items[recipe.inputId] ?? 0);
      if (have < op.units) return reject("materials", { [recipe.inputId]: op.units - have });
      const items: Record<string, number> = { ...p.cargo.items, [recipe.inputId]: have - op.units };
      if (items[recipe.inputId] <= 0) delete items[recipe.inputId];
      const cargo = { ...p.cargo, items };
      const processing = { id: op.opId, recipeId: recipe.id, reserved: { [recipe.inputId]: op.units }, elapsedS: 0, committedKg: 0 };
      return {
        result: { type: "processing.start", batchId: op.opId, inputId: recipe.inputId, units: op.units, outputKg: op.units * t.processingKgPerUnit },
        apply: () => {
          p.cargo = cargo;
          p.processing = processing;
        },
        events: [],
        playerKeys: ["cargo", "processing"],
      };
    }

    case "processing.cancel": {
      const batch = p.processing;
      if (!batch || batch.id !== op.batchId) return reject("not_active");
      if (p.isDead) return reject("dead");
      const recipe = getProcessingRecipe(batch.recipeId);
      const inputId = recipe?.inputId ?? Object.keys(batch.reserved)[0];
      const reserved = inputId ? Math.floor(batch.reserved[inputId] ?? 0) : 0;
      const back = inputId ? unconvertedUnits(reserved, batch.committedKg, getEffectiveTuning().processingKgPerUnit) : 0;
      if (back > cargoRemaining(p, world)) return reject("no_capacity");
      const refunded: Record<string, number> = back > 0 && inputId ? { [inputId]: back } : {};
      const items = { ...p.cargo.items };
      if (back > 0 && inputId) items[inputId] = (items[inputId] ?? 0) + back;
      const cargo = { ...p.cargo, items };
      return {
        result: { type: "processing.cancel", batchId: batch.id, refunded, committedKg: batch.committedKg },
        apply: () => {
          p.cargo = cargo;
          p.processing = null;
        },
        events: [],
        playerKeys: ["cargo", "processing"],
      };
    }

    case "ship.repair": {
      if (!isCount(op.pct) || op.pct < 1 || op.pct > 100) return reject("invalid");
      if (p.isDead) return reject("dead");
      const max = persistentShipConfig(p, completedSet(world)).maxHealth;
      if (!hullRepairable(p.health, max)) return reject("full_hull");
      const per = getEffectiveTuning().repairUnitsPerPct;
      const have = Math.floor(p.cargo.items[REPAIR_MATERIAL_ID] ?? 0);
      const missingPct = Math.ceil(((max - p.health) / max) * 100 - 1e-9);
      const pct = Math.min(op.pct, missingPct, Math.floor(have / per));
      if (pct < 1) return reject("materials", { [REPAIR_MATERIAL_ID]: per - have });
      const spentUnits = pct * per;
      const raw = Math.min(max, p.health + (pct / 100) * max);
      const health = hullRepairable(raw, max) ? raw : max;
      const items: Record<string, number> = { ...p.cargo.items, [REPAIR_MATERIAL_ID]: have - spentUnits };
      if (items[REPAIR_MATERIAL_ID] <= 0) delete items[REPAIR_MATERIAL_ID];
      const cargo = { ...p.cargo, items };
      return {
        result: { type: "ship.repair", pct, spent: { [REPAIR_MATERIAL_ID]: spentUnits }, health },
        apply: () => {
          p.cargo = cargo;
          p.health = health;
        },
        events: [],
        playerKeys: ["cargo", "health"],
      };
    }

    default:
      return reject("invalid");
  }
}
