/**
 * Operation reducers: validate every affected slice, then return a commit that only assigns.
 * Nothing is written before validation finishes, so a rejection changes nothing.
 */
import { REPAIR_MATERIAL_ID, getItemDef, getProcessingRecipe, getResearchNode, arePrerequisitesMet } from "@/data/content";
import type { PlayerId, PlayerState, QuatTuple, Vec3Tuple, WorldState, WreckRecord } from "@/save/types";
import { isFrameId } from "@/sim/frames";
import { cargoUsedUnits, persistentShipConfig, unlockedItemIds } from "@/sim/ship/loadout";
import { unconvertedUnits } from "@/sim/ship/resourceStep";
import { getResourceTuning } from "@/sim/ship/resourceTuning";
import type { AsteroidDeltaIndex } from "./asteroidDeltas";
import type { OperationResult, RejectReason, Transfer, WorldEvent, WorldOperation } from "./commands";

export interface ReduceCtx {
  world: WorldState;
  /** null when `by` is not a player of this world. */
  player: PlayerState | null;
  by: PlayerId;
  asteroids: AsteroidDeltaIndex;
  /** Wall clock, ms, supplied by the authority so the reducer stays pure. */
  now: number;
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
}

export type Reduction = Commit | Rejection;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isCount = (v: unknown): v is number => isNum(v) && v >= 0 && Number.isInteger(v);
const reject = (reason: RejectReason, missing?: Record<string, number>): Rejection => (missing ? { reason, missing } : { reason });
const DEFAULT_STACK_MAX = 99;
const MAX_ASSAY_PER_ROCK = 100;

function validAsteroid(op: { fieldId: string; chunkKey: string; instanceId: number }): boolean {
  const id = op.instanceId;
  return !!op.fieldId && !!op.chunkKey && isNum(id) && id >= 0 && id <= 0xffffffff && Number.isInteger(id);
}

function completedSet(world: WorldState): Set<string> {
  return new Set(world.research.completedNodes);
}

function cargoRemaining(player: PlayerState, world: WorldState): number {
  const cap = player.cargo.capacityUnits + persistentShipConfig(player, completedSet(world)).bonusCargoCapacity;
  return Math.max(0, Math.floor(cap) - cargoUsedUnits(player.cargo.items));
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
      return {
        result: { type: "asteroid.destroy" },
        apply: () => asteroids.add(op.fieldId, op.chunkKey, op.instanceId),
        events: [{ type: "asteroid.destroyed", by, fieldId: op.fieldId, chunkKey: op.chunkKey, instanceId: op.instanceId, cause: op.cause }],
        playerKeys: [],
      };
    }

    case "research.devSet": {
      if (!Array.isArray(op.nodeIds) || !op.nodeIds.every((x) => typeof x === "string")) return reject("invalid");
      const completedNodes = Array.from(new Set(op.nodeIds));
      return {
        result: { type: "research.devSet", count: completedNodes.length },
        apply: () => {
          world.research = { completedNodes };
        },
        events: [{ type: "research.changed", by, completedNodes }],
        playerKeys: [],
      };
    }

    case "wreck.collect":
    case "asteroid.mine":
    case "item.craft":
    case "research.start":
    case "research.complete":
    case "ship.destroy":
    case "ship.respawn":
    case "processing.start":
    case "processing.cancel":
    case "ship.repair":
      break;
  }

  if (!player) return reject("unknown_player");
  const p = player;

  switch (op.type) {
    case "asteroid.mine": {
      if (!validAsteroid(op) || !isCount(op.assaySamples) || op.assaySamples > MAX_ASSAY_PER_ROCK) return reject("invalid");
      if (typeof op.yield !== "object" || op.yield === null) return reject("invalid");
      for (const k of Object.keys(op.yield)) if (!isCount(op.yield[k])) return reject("invalid");
      if (p.isDead) return reject("dead");
      if (asteroids.has(op.fieldId, op.chunkKey, op.instanceId)) return reject("already_done");
      let room = cargoRemaining(p, world);
      const granted: Record<string, number> = {};
      const overflow: Record<string, number> = {};
      const items = { ...p.cargo.items };
      for (const k of Object.keys(op.yield)) {
        const want = op.yield[k];
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
      const research = { ...p.research, assaySamples: p.research.assaySamples + op.assaySamples };
      const minedLifetime = p.minedLifetime + 1;
      return {
        result: { type: "asteroid.mine", granted, overflow, assaySamples: op.assaySamples },
        apply: () => {
          asteroids.add(op.fieldId, op.chunkKey, op.instanceId);
          p.cargo = cargo;
          p.research = research;
          p.minedLifetime = minedLifetime;
        },
        events: [{ type: "asteroid.destroyed", by, fieldId: op.fieldId, chunkKey: op.chunkKey, instanceId: op.instanceId, cause: "mined" }],
        playerKeys: ["cargo", "research", "minedLifetime"],
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
        autoEquipped = !m.equippedModules[def.slot];
        modules = {
          ...m,
          ownedModules: [...m.ownedModules, def.id],
          equippedModules: autoEquipped ? { ...m.equippedModules, [def.slot]: def.id } : m.equippedModules,
        };
      } else {
        modules = { ...m, ownedModules: [...m.ownedModules, def.id] };
      }
      const cargo = { ...p.cargo, items };
      return {
        result: { type: "item.craft", itemId: def.id, spent: { ...def.recipe }, autoEquipped, hotbarIndex },
        apply: () => {
          p.cargo = cargo;
          p.modules = modules;
        },
        events: [],
        playerKeys: ["cargo", "modules"],
      };
    }

    case "research.start": {
      const node = typeof op.nodeId === "string" ? getResearchNode(op.nodeId) : undefined;
      if (!node) return reject("not_found");
      if (p.research.activeResearch) return reject("busy");
      const completed = completedSet(world);
      if (completed.has(node.id)) return reject("already_done");
      if (!arePrerequisitesMet(node, completed)) return reject("prerequisites");
      const cost = node.costs.assaySamples;
      if (p.research.assaySamples < cost) return reject("assay", { assaySamples: cost - p.research.assaySamples });
      const research = { assaySamples: p.research.assaySamples - cost, activeResearch: { nodeId: node.id, elapsedS: 0 } };
      return {
        result: { type: "research.start", nodeId: node.id, spentAssay: cost },
        apply: () => {
          p.research = research;
        },
        events: [],
        playerKeys: ["research"],
      };
    }

    case "research.complete": {
      const active = p.research.activeResearch;
      if (!active || active.nodeId !== op.nodeId) return reject("not_active");
      const node = getResearchNode(op.nodeId);
      if (!node) return reject("not_found");
      if (!isNum(op.elapsedS) || op.elapsedS + 1e-6 < node.durationSeconds) return reject("incomplete");
      const known = world.research.completedNodes.includes(node.id);
      const completedNodes = known ? world.research.completedNodes : [...world.research.completedNodes, node.id];
      // Already completed by another player: refund the paid samples instead of losing them.
      const refund = known ? node.costs.assaySamples : 0;
      const research = { assaySamples: p.research.assaySamples + refund, activeResearch: null };
      return {
        result: { type: "research.complete", nodeId: node.id, unlockedItems: known ? [] : [...(node.unlocks.items ?? [])], refundedAssay: refund },
        apply: () => {
          if (!known) world.research = { completedNodes };
          p.research = research;
        },
        events: known ? [] : [{ type: "research.changed", by, completedNodes }],
        playerKeys: ["research"],
      };
    }

    case "ship.destroy": {
      const pos = op.positionKm;
      if (!isFrameId(op.frameId) || !Array.isArray(pos) || pos.length !== 3 || !pos.every(isNum)) return reject("invalid");
      if (op.cause !== undefined && op.cause !== "impact" && op.cause !== "abandon") return reject("invalid");
      if (p.isDead) return reject("already_done");
      const dropped: Transfer = { items: {}, consumables: {}, fuelKg: 0 };
      // Same rule as the save sanitiser (whole units), so the wreck holds exactly what a reload would.
      for (const [k, v] of Object.entries(p.cargo.items)) if (isNum(v) && v >= 1) dropped.items[k] = Math.floor(v);
      // Unconverted feedstock leaves with the cargo; committed output is already in the ordinary tank.
      const batch = p.processing;
      if (batch) {
        const recipe = getProcessingRecipe(batch.recipeId);
        const reserved = recipe ? Math.floor(batch.reserved[recipe.inputId] ?? 0) : 0;
        const back = recipe ? unconvertedUnits(reserved, batch.committedKg, getResourceTuning().processingKgPerUnit) : 0;
        if (recipe && back > 0) dropped.items[recipe.inputId] = (dropped.items[recipe.inputId] ?? 0) + back;
      }
      // Ordinary fuel only: the protected allowance never reaches a wreck.
      dropped.fuelKg = isNum(p.propellant.ordinaryKg) ? Math.max(0, p.propellant.ordinaryKg) : 0;
      const hasDrop = Object.keys(dropped.items).length > 0 || dropped.fuelKg > 0;
      const wreck: WreckRecord | null = hasDrop
        ? {
            id: `wreck-${op.opId}`,
            frameId: op.frameId,
            positionKm: [pos[0], pos[1], pos[2]],
            items: dropped.items,
            fuelKg: dropped.fuelKg,
            consumables: {},
            createdAt: now,
          }
        : null;
      const cargo = { ...p.cargo, items: {} };
      const propellant = { ...p.propellant, ordinaryKg: 0 };
      return {
        result: { type: "ship.destroy", wreckId: wreck?.id ?? null, dropped, cause: op.cause ?? "impact" },
        apply: () => {
          if (wreck) world.wrecks = [...world.wrecks, wreck];
          p.isDead = true;
          p.health = 0;
          p.cargo = cargo;
          p.propellant = propellant;
          p.processing = null;
        },
        events: wreck ? [{ type: "wreck.created", by, wreck }] : [],
        playerKeys: ["isDead", "health", "cargo", "propellant", "processing"],
      };
    }

    case "ship.respawn": {
      const pos = op.positionKm;
      if (!isFrameId(op.frameId) || !Array.isArray(pos) || pos.length !== 3 || !pos.every(isNum)) return reject("invalid");
      if (!p.isDead) return reject("not_dead");
      const health = persistentShipConfig(p, completedSet(world)).maxHealth;
      const q = p.ship?.quaternion;
      const ship = { frameId: op.frameId, positionKm: [pos[0], pos[1], pos[2]] as Vec3Tuple, quaternion: q ? ([q[0], q[1], q[2], q[3]] as QuatTuple) : ([0, 0, 0, 1] as QuatTuple) };
      // Recovery: full hull, empty ordinary tank, the configured protected allowance, a cold ship.
      const propellant = { ordinaryKg: 0, protectedKg: getResourceTuning().recoveryAllowanceKg };
      const power = { capacitor01: 1, heat01: 0 };
      return {
        result: { type: "ship.respawn", health },
        apply: () => {
          p.isDead = false;
          p.health = health;
          p.ship = ship;
          p.propellant = propellant;
          p.power = power;
          p.processing = null;
        },
        events: [],
        playerKeys: ["isDead", "health", "ship", "propellant", "power", "processing"],
      };
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
      const fuel = Math.min(wreck.fuelKg, Math.max(0, getResourceTuning().tankKg - p.propellant.ordinaryKg));
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
      const t = getResourceTuning();
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
      const back = inputId ? unconvertedUnits(reserved, batch.committedKg, getResourceTuning().processingKgPerUnit) : 0;
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
      if (!(p.health < max)) return reject("full_hull");
      const per = getResourceTuning().repairUnitsPerPct;
      const have = Math.floor(p.cargo.items[REPAIR_MATERIAL_ID] ?? 0);
      const missingPct = Math.ceil(((max - p.health) / max) * 100 - 1e-9);
      const pct = Math.min(op.pct, missingPct, Math.floor(have / per));
      if (pct < 1) return reject("materials", { [REPAIR_MATERIAL_ID]: per - have });
      const spentUnits = pct * per;
      const health = Math.min(max, p.health + (pct / 100) * max);
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
