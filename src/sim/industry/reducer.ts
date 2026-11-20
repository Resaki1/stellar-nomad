import { getItemDef, industryResearchNode, MATERIAL_NAMES } from "@/data/content";
import type { PlayerState, WorldState } from "@/save/types";
import { isFrameId } from "@/sim/frames";
import { cleanPointName, emergencePose } from "@/sim/replication/points";
import type { RejectReason } from "@/sim/world/commands";
import type { Commit, ReduceCtx, Reduction } from "@/sim/world/reducers";
import { DEPOT_KIT_ID, DEPOT_RECIPES, DRONE_FUEL_ID, getIndustrySource, INDUSTRY_TUNING as T, POINT_TANK_CAPACITY_KG, POINT_TANK_RECIPE } from "./catalog";
import { planFabricationMaterials } from "./fabrication";
import { checkDepotPlacement, depotDistanceKm } from "./placement";
import { canMineField, decodeMineFilter } from "./mining";
import { estimateDroneExtractionRoute, estimateDroneRoute } from "./route";
import { applyIndustryDelta, changedCount, payloadMassKg, storageUnits } from "./simulation";
import { beginMiningReturn } from "./sortie";
import { emptyStorage, sameDroneAssignment, type DepotRecord, type DroneJob, type DroneRecord, type IndustryDelta, type IndustryOperation, type IndustryResult } from "./types";

type IndustryContext = ReduceCtx & { player: PlayerState };
interface ShipLimits {
  cargoRoom: () => number;
  fuelRoomKg: () => number;
}

export function isMaterial(id: string): boolean {
  return Object.hasOwn(MATERIAL_NAMES, id);
}

export function decodeDroneJob(v: unknown): DroneJob | null {
  if (!v || typeof v !== "object") return null;
  const { kind, targetId, targetKind, priorities, mineFilter, keepResourceIds, reserveKg, stopAt, enabled } = v as Partial<DroneJob>;
  if ((kind !== "extract" && kind !== "haul" && kind !== "mine") ||
      typeof targetId !== "string" || targetId.length > 160 || !targetId ||
      typeof enabled !== "boolean" || typeof reserveKg !== "number" || !Number.isFinite(reserveKg) || reserveKg < 0 || reserveKg > T.fuelCapacityKg ||
      typeof stopAt !== "number" || !Number.isSafeInteger(stopAt) || stopAt < 1 || stopAt > Math.max(T.cargoCapacity, T.fuelCapacityKg) ||
      !Array.isArray(priorities) || priorities.length > Object.keys(MATERIAL_NAMES).length + 1 ||
      !priorities.every(id => typeof id === "string" && (isMaterial(id) || id === DRONE_FUEL_ID)) ||
      new Set(priorities).size !== priorities.length) return null;
  if (kind === "mine") {
    const filter = decodeMineFilter(targetId, mineFilter);
    const kept = keepResourceIds === undefined ? undefined : decodeMineFilter(targetId, { mode: "resource", ids: keepResourceIds });
    if (keepResourceIds !== undefined && kept?.mode !== "resource") return null;
    return filter && priorities.length === 0 && targetKind === undefined
      ? { kind, targetId, priorities: [], mineFilter: filter, ...(kept?.mode === "resource" && { keepResourceIds: kept.ids }),
        reserveKg, stopAt, enabled } : null;
  }
  if (priorities.length === 0 || mineFilter !== undefined || keepResourceIds !== undefined) return null;
  if (targetKind !== undefined && (targetKind !== "point" || kind !== "haul" ||
      priorities.length !== 1 || priorities[0] !== DRONE_FUEL_ID || stopAt > POINT_TANK_CAPACITY_KG)) return null;
  const source = kind === "extract" ? getIndustrySource(targetId) : undefined;
  if (kind === "extract" && (!source || priorities.length !== 1 || priorities[0] !== source.materialId)) return null;
  return { kind, targetId, ...(targetKind && { targetKind }), priorities: [...priorities], reserveKg, stopAt, enabled };
}

function canAccessStorage(player: PlayerState, site: Pick<DepotRecord, "frameId" | "positionKm">): boolean {
  return !!player.ship && isFrameId(player.ship.frameId) && depotDistanceKm(player.ship, site) <= T.interactRangeKm;
}

function commit(
  ctx: IndustryContext, result: IndustryResult, depots: DepotRecord[], drones: DroneRecord[],
  playerKeys: Commit["playerKeys"] = [], updatePlayer?: () => void,
): Commit {
  const delta: IndustryDelta = { depots, drones, sources: {} };
  const next = applyIndustryDelta(ctx.world.industry, delta);
  return {
    result,
    events: [{ type: "industry.changed", by: ctx.by, delta },
      ...(result.type === "depot.transfer" && result.kind === "fuel" ? [{
        type: "industry.fuelTransferred" as const, by: ctx.by, deltaKg: result.direction === "deposit" ? -result.amount : result.amount,
      }] : [])],
    playerKeys,
    apply: () => {
      ctx.world.industry = next;
      updatePlayer?.();
    },
  };
}

function placeDepot(op: Extract<IndustryOperation, { type: "depot.place" }>, ctx: IndustryContext): Reduction {
  const { player, world, by } = ctx;
  const id = `depot:${op.opId}`;
  if (op.opId.length > 128 || typeof op.name !== "string") return { reason: "invalid" };
  if (world.industry.depots.some(d => d.id === id)) return { reason: "already_done" };
  const kits = player.modules.consumables[DEPOT_KIT_ID] ?? 0;
  const occupied = world.replication.points.flatMap(p => [
    p, { frameId: p.frameId, positionKm: emergencePose(p, 0).positionKm },
  ]);
  for (const peer of ctx.players?.() ?? []) if (peer !== player && !peer.isDead && peer.ship) occupied.push(peer.ship);
  const reason = checkDepotPlacement(op, player.ship, kits, ctx.asteroids, world.industry.depots, occupied);
  if (reason) return { reason };
  const depot: DepotRecord = {
    id, by, name: cleanPointName(op.name, "Depot"), frameId: op.frameId, positionKm: [...op.positionKm], quaternion: [...op.quaternion],
    refinery: false, storage: emptyStorage(), refineProgressS: 0,
  };
  const consumables = changedCount(player.modules.consumables, DEPOT_KIT_ID, -1);
  return commit(ctx, { type: op.type, depotId: id }, [depot], [], ["modules"], () => {
    player.modules = { ...player.modules, consumables };
  });
}

function transfer(
  op: Extract<IndustryOperation, { type: "depot.transfer" }>, ctx: IndustryContext, depot: DepotRecord, limits: ShipLimits,
): Reduction {
  const { itemId, amount, direction, kind, depotId } = op;
  const player = ctx.player;
  if (typeof itemId !== "string" || (direction !== "deposit" && direction !== "withdraw") ||
      (kind !== "fuel" && kind !== "cargo" && kind !== "consumable") ||
      !Number.isSafeInteger(amount) || amount <= 0) return { reason: "invalid" };
  const deposit = direction === "deposit";
  const next = { ...depot, storage: { ...depot.storage } };
  const result = { type: op.type, depotId, direction, kind, itemId, amount };
  const missing = (available: number): Reduction => ({ reason: "materials", missing: { [itemId]: amount - available } });
  if (kind === "fuel") {
    if (itemId !== "fuel") return { reason: "invalid" };
    const available = deposit ? Math.max(0, player.propellant.ordinaryKg - (ctx.reservedFuel?.(ctx.by) ?? 0)) : depot.storage.fuelKg;
    if (available < amount) return missing(available);
    if (deposit && depot.storage.fuelKg + amount > T.fuelCapacityKg) return { reason: "depot_full" };
    if (!deposit && amount > limits.fuelRoomKg()) return { reason: "tank_full" };
    const deltaKg = deposit ? -amount : amount;
    next.storage.fuelKg -= deltaKg;
    return commit(ctx, result, [next], [], ["propellant", deposit ? "depositedFuelKg" : "receivedFuelKg"], () => {
      player.propellant = { ...player.propellant, ordinaryKg: player.propellant.ordinaryKg + deltaKg };
      if (deposit) player.depositedFuelKg += amount;
      else player.receivedFuelKg += amount;
    });
  }

  const material = kind === "cargo";
  const def = material ? undefined : getItemDef(itemId);
  if (material ? !isMaterial(itemId) : def?.type !== "consumable") return { reason: "unknown_item" };
  const field = material ? "items" : "consumables";
  const aboard = material ? player.cargo.items : player.modules.consumables;
  const atDepot = depot.storage[field];
  const available = (deposit ? aboard : atDepot)[itemId] ?? 0;
  if (available < amount) return missing(available);
  if (deposit && storageUnits(depot.storage) + amount > T.cargoCapacity) {
    return { reason: "depot_full" };
  }
  if (!deposit && (material ? limits.cargoRoom() : (def?.stackMax ?? 99) - (aboard[itemId] ?? 0)) < amount) {
    return { reason: material ? "no_capacity" : "stack_full" };
  }
  const delta = deposit ? -amount : amount;
  next.storage[field] = changedCount(atDepot, itemId, -delta);
  return commit(ctx, result, [next], [], [material ? "cargo" : "modules"], () => {
    const inventory = changedCount(aboard, itemId, delta);
    if (material) player.cargo = { ...player.cargo, items: inventory };
    else player.modules = { ...player.modules, consumables: inventory };
  });
}

function fabricate(
  op: Extract<IndustryOperation, { type: "depot.fabricate" }>, ctx: IndustryContext, depot: DepotRecord,
): Reduction {
  const recipe = DEPOT_RECIPES.find(r => r.id === op.recipeId);
  if (!recipe) return { reason: "not_found" };
  if (recipe.blueprint && !ctx.world.research.completedNodes.includes(industryResearchNode(recipe.blueprint).id)) return { reason: "locked" };
  if (recipe.output === "refinery" && depot.refinery) return { reason: "owned" };
  const drones = ctx.world.industry.drones.filter(d => d.homeId === depot.id);
  if (recipe.output === "drone" && drones.length >= T.dronesPerDepot) return { reason: "drone_limit" };
  const droneId = `drone:${op.opId}`;
  if (op.opId.length > 128) return { reason: "invalid" };
  if (recipe.output === "drone" && ctx.world.industry.drones.some(d => d.id === droneId)) return { reason: "already_done" };

  const player = ctx.player;
  const shipCargo = recipe.output === "drone" && canAccessStorage(player, depot) ? player.cargo.items : undefined;
  const plan = planFabricationMaterials(recipe.recipe, depot.storage.items, shipCargo);
  if (Object.keys(plan.missing).length) return { reason: "materials", missing: plan.missing };
  const items = { ...depot.storage.items };
  for (const [id, amount] of Object.entries(plan.depot)) {
    items[id] -= amount;
    if (items[id] === 0) delete items[id];
  }
  const storage = { ...depot.storage, items };
  if (recipe.itemId) {
    if (storageUnits(storage) + 1 > T.cargoCapacity) return { reason: "depot_full" };
    storage.consumables = changedCount(storage.consumables, recipe.itemId, 1);
  }

  const next = { ...depot, storage, refinery: depot.refinery || recipe.output === "refinery" };
  if (recipe.output === "drone") {
    const drone: DroneRecord = { id: droneId, homeId: depot.id, job: null, phase: "idle", status: "unassigned",
      remainingS: 0, durationS: 0, returnS: 0, via: null, fuelKg: 0, cargo: emptyStorage() };
    const shipCosts = Object.entries(plan.ship);
    const result = { type: op.type, depotId: depot.id, recipeId: recipe.id, droneId };
    if (!shipCosts.length) return commit(ctx, result, [next], [drone]);
    const cargo = shipCosts.reduce((aboard, [id, amount]) => changedCount(aboard, id, -amount), player.cargo.items);
    return commit(ctx, result, [next], [drone], ["cargo"], () => {
      player.cargo = { ...player.cargo, items: cargo };
    });
  }
  return commit(ctx, { type: op.type, depotId: depot.id, recipeId: recipe.id }, [next], []);
}

function validateTarget(job: DroneJob, home: DepotRecord, world: WorldState): RejectReason | null {
  const { depots, pointTanks } = world.industry;
  if (job.kind === "mine") return canMineField(home, job.targetId) ? null : "source_out_of_range";
  if (job.kind === "extract") {
    const source = getIndustrySource(job.targetId);
    return source && estimateDroneExtractionRoute(home, source, depots) ? null : "source_out_of_range";
  }
  if (job.targetKind === "point") {
    const target = Object.hasOwn(pointTanks, job.targetId) && world.replication.points.find(p => p.id === job.targetId && !p.starter && isFrameId(p.frameId));
    return !target ? "not_found" : estimateDroneRoute(home, target) ? null : "route_out_of_range";
  }
  const target = depots.find(d => d.id === job.targetId && d.id !== home.id);
  if (!target) return "not_found";
  return estimateDroneRoute(home, target) ? null : "route_out_of_range";
}

function changePointTank(
  op: Extract<IndustryOperation, { type: "replication.tank.install" | "replication.tank.transfer" }>,
  ctx: IndustryContext, limits: ShipLimits,
): Reduction {
  const { pointId } = op;
  const { player, world, by } = ctx;
  if (typeof pointId !== "string" || !pointId || pointId.length > 160 || Object.hasOwn(Object.prototype, pointId)) return { reason: "invalid" };
  const point = world.replication.points.find(p => p.id === pointId && !p.starter && isFrameId(p.frameId));
  if (!point) return { reason: "not_found" };
  if (!canAccessStorage(player, point)) return { reason: "too_far" };
  const installed = Object.hasOwn(world.industry.pointTanks, pointId);
  const stock = installed ? world.industry.pointTanks[pointId] : 0;
  const tankDelta = (fuelKg: number): IndustryDelta => ({ depots: [], drones: [], sources: {}, pointTanks: { [pointId]: fuelKg } });

  if (op.type === "replication.tank.install") {
    if (installed) return { reason: "already_done" };
    if (!world.research.completedNodes.includes(industryResearchNode("point_tank").id)) return { reason: "locked" };
    const missing: Record<string, number> = {};
    let items = player.cargo.items;
    for (const [id, count] of Object.entries(POINT_TANK_RECIPE)) {
      const have = items[id] ?? 0;
      if (have < count) missing[id] = count - have;
      else items = changedCount(items, id, -count);
    }
    if (Object.keys(missing).length) return { reason: "materials", missing };
    const delta = tankDelta(0);
    return {
      result: { type: op.type, pointId }, events: [{ type: "industry.changed", by, delta }], playerKeys: ["cargo"],
      apply: () => {
        world.industry = applyIndustryDelta(world.industry, delta);
        player.cargo = { ...player.cargo, items };
      },
    };
  }

  const { amount, direction } = op;
  if ((direction !== "deposit" && direction !== "withdraw") || !Number.isSafeInteger(amount) || amount <= 0) return { reason: "invalid" };
  if (!installed) return { reason: "not_found" };
  const deposit = direction === "deposit";
  const available = deposit ? Math.max(0, player.propellant.ordinaryKg - (ctx.reservedFuel?.(by) ?? 0)) : stock;
  if (amount > available) return { reason: "materials", missing: { fuel: amount - available } };
  if (deposit && amount > POINT_TANK_CAPACITY_KG - stock) return { reason: "point_tank_full" };
  if (!deposit && amount > limits.fuelRoomKg()) return { reason: "tank_full" };

  const deltaKg = deposit ? -amount : amount;
  const delta = tankDelta(stock - deltaKg);
  return {
    result: { type: op.type, pointId, direction, amount },
    events: [{ type: "industry.changed", by, delta }, { type: "industry.fuelTransferred", by, deltaKg }],
    playerKeys: ["propellant", deposit ? "depositedFuelKg" : "receivedFuelKg"],
    apply: () => {
      world.industry = applyIndustryDelta(world.industry, delta);
      player.propellant = { ...player.propellant, ordinaryKg: player.propellant.ordinaryKg + deltaKg };
      if (deposit) player.depositedFuelKg += amount;
      else player.receivedFuelKg += amount;
    },
  };
}

export function reduceIndustry(op: IndustryOperation, ctx: IndustryContext, limits: ShipLimits): Reduction {
  const { player, world } = ctx;
  if (player.isDead) return { reason: "dead" };
  if (op.type === "depot.place") return placeDepot(op, ctx);
  if (op.type === "replication.tank.install" || op.type === "replication.tank.transfer") return changePointTank(op, ctx, limits);
  const { depots, drones } = world.industry;
  if (op.type === "drone.configure") {
    const drone = drones.find(d => d.id === op.droneId);
    const home = drone && depots.find(d => d.id === drone.homeId);
    if (!home || !drone) return { reason: "not_found" };
    if (op.onlyIfUnassigned && (drone.job || drone.phase !== "idle")) return { reason: "drone_assigned" };
    const job = decodeDroneJob(op.job);
    if (!job) return { reason: "invalid" };
    const sameAssignment = sameDroneAssignment(drone.job, job);
    if (drone.phase !== "idle" && !sameAssignment) return { reason: "busy" };
    if (job.kind === "extract" && !sameAssignment) return { reason: "locked" };
    if (job.kind === "mine" && !sameAssignment && !world.research.completedNodes.includes(industryResearchNode("mining").id)) return { reason: "locked" };
    // A crew can stop an existing assignment even if it can no longer dispatch.
    const stopping = sameAssignment && !job.enabled;
    const reason = drone.phase === "idle" && !stopping ? validateTarget(job, home, world) : null;
    if (reason) return { reason };
    const status = drone.phase === "idle" ? (job.enabled ? "departing" : "paused") : drone.status;
    const next = { ...drone, job, status };
    const lane = drone.sortie?.lane ?? (drones.indexOf(drone) % 2 === 0 ? 1 : -1);
    const updated = stopping && job.kind === "mine"
      ? beginMiningReturn(next, home, lane, payloadMassKg(drone.cargo), world.industry.remainderS) : next;
    return commit(ctx, { type: op.type, droneId: drone.id }, [], [updated]);
  }
  const depot = depots.find(d => d.id === op.depotId);
  if (!depot) return { reason: "not_found" };
  if (op.type === "depot.rename") {
    const name = cleanPointName(op.name, "");
    if (!name) return { reason: "invalid" };
    if (name === depot.name) return { reason: "already_done" };
    return commit(ctx, { type: op.type, depotId: depot.id, name }, [{ ...depot, name }], []);
  }
  if (op.type === "depot.transfer") {
    if (!canAccessStorage(player, depot)) return { reason: "too_far" };
    return transfer(op, ctx, depot, limits);
  }
  return fabricate(op, ctx, depot);
}
