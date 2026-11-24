import type { Difficulty, ReplicationPoint } from "@/save/types";
import type { Transfer } from "@/sim/world/commands";
import { DRONE_FUEL_ID, INDUSTRY_TUNING as T, POINT_TANK_CAPACITY_KG } from "./catalog";
import {
  clearsMiningCorridor, dronePayloadMassKg, estimateDroneRoute, estimateDroneWorkRoute, planDroneLoad, planDroneReturnFuel, type DroneRoute,
} from "./route";
import { canMineField, droneRockKey, resolveDroneLoot, retainedDroneLoot, type MiningCandidate, type DroneMiningSearch } from "./mining";
import { beginMiningReturn, miningApproachPosition, miningBerthPosition, miningReturnFuelAtRestKg, miningTankKg, planMiningHop } from "./sortie";
import { emptyStorage, type DepotRecord, type DroneJob, type DroneRecord, type DroneRockId, type DroneStatus, type IndustryDelta, type IndustryState } from "./types";

const EPSILON_KG = 1e-9;

export interface IndustryMiningContext {
  search: DroneMiningSearch;
  asteroids: { has(fieldId: string, chunkKey: string, instanceId: number): boolean };
  difficulty?: Difficulty;
}

export function storageUnits(storage: Transfer): number {
  return Object.values(storage.items).reduce((a, b) => a + b, 0) + Object.values(storage.consumables).reduce((a, b) => a + b, 0);
}

export function changedCount(items: Record<string, number>, id: string, delta: number): Record<string, number> {
  const next = { ...items, [id]: (items[id] ?? 0) + delta };
  if (!next[id]) delete next[id];
  return next;
}

/** A single material or fuel payload moves without rounding or discarding excess. */
function move(from: Transfer, into: Transfer, id: string, amount: number): void {
  if (id === DRONE_FUEL_ID) {
    from.fuelKg -= amount;
    into.fuelKg += amount;
  } else {
    from.items = changedCount(from.items, id, -amount);
    into.items = changedCount(into.items, id, amount);
  }
}

function stock(storage: Transfer, id: string): number {
  return id === DRONE_FUEL_ID ? storage.fuelKg : storage.items[id] ?? 0;
}

function space(storage: Transfer, id: string, stopAt = Infinity): number {
  const room = id === DRONE_FUEL_ID ? T.fuelCapacityKg - storage.fuelKg : T.cargoCapacity - storageUnits(storage);
  return Math.max(0, Math.min(room, stopAt - stock(storage, id)));
}

function payloadIds(storage: Transfer): string[] {
  return storage.fuelKg > 0 ? [DRONE_FUEL_ID, ...Object.keys(storage.items)] : Object.keys(storage.items);
}

export function payloadMassKg(storage: Transfer): number {
  return Object.entries(storage.items).reduce((kg, [id, amount]) => kg + dronePayloadMassKg(id, amount), storage.fuelKg);
}

type DroneDeparture = { itemId: string; load: ReturnType<typeof planDroneLoad>; status: null } |
  { load: null; status: "destination_full" | "no_cargo" | "needs_fuel" };

export function planDroneHaul(home: DepotRecord, destination: DepotRecord, job: DroneJob, route: DroneRoute): DroneDeparture {
  const availableKg = home.storage.fuelKg - job.reserveKg;
  if (availableKg < route.roundTripFuelKg) return { load: null, status: "needs_fuel" };
  let hasRoom = false, needsFuel = false;
  for (const itemId of job.priorities) {
    const room = space(destination.storage, itemId, job.stopAt);
    if (room <= 0) continue;
    hasRoom = true;
    const request = Math.min(stock(home.storage, itemId), room);
    if (request <= 0) continue;
    const load = planDroneLoad(route, itemId, request, availableKg);
    if (load.amount > EPSILON_KG) return { itemId, load, status: null };
    if (itemId !== DRONE_FUEL_ID) needsFuel = true;
  }
  return { load: null, status: !hasRoom ? "destination_full" : needsFuel ? "needs_fuel" : "no_cargo" };
}

export function planDronePointDelivery(home: DepotRecord, fuelKg: number, job: DroneJob, route: DroneRoute): DroneDeparture {
  const availableKg = home.storage.fuelKg - job.reserveKg;
  if (availableKg < route.roundTripFuelKg) return { load: null, status: "needs_fuel" };
  const room = pointFuelRoom(fuelKg, job.stopAt);
  if (room <= EPSILON_KG) return { load: null, status: "destination_full" };
  const load = planDroneLoad(route, DRONE_FUEL_ID, room, availableKg);
  return load.amount > EPSILON_KG ? { itemId: DRONE_FUEL_ID, load, status: null } : { load: null, status: "no_cargo" };
}

function pointFuelRoom(fuelKg: number, stopAt: number): number {
  return Math.max(0, Math.min(POINT_TANK_CAPACITY_KG, stopAt) - fuelKg);
}

function unload(cargo: Transfer, destination: Transfer, stopAt?: number): boolean {
  for (const id of payloadIds(cargo)) {
    const delivered = Math.min(stock(cargo, id), space(destination, id, stopAt));
    if (delivered > 0) move(cargo, destination, id, delivered);
  }
  return payloadIds(cargo).length === 0;
}

const inPhase = (drone: DroneRecord, phase: DroneRecord["phase"], status: DroneStatus, durationS: number): DroneRecord =>
  ({ ...drone, phase, status, durationS, remainingS: durationS });

function standBy(drone: DroneRecord, status: DroneStatus): DroneRecord {
  return drone.status === status && drone.phase === "idle" ? drone : inPhase(drone, "idle", status, 0);
}

class IndustryStep {
  private readonly depotMap = new Map<string, DepotRecord>();
  private pointTanks: IndustryState["pointTanks"];
  private readonly claimed = new Set<string>();

  constructor(
    private readonly state: IndustryState,
    private readonly points: readonly ReplicationPoint[],
    private readonly mining: IndustryMiningContext | undefined,
    private readonly mined: Map<string, DroneRockId>,
  ) {
    for (const depot of state.depots) this.depotMap.set(depot.id, depot);
    this.pointTanks = state.pointTanks ?? {};
    for (const drone of state.drones) {
      if (drone.flight?.rock && (drone.phase === "outbound" || drone.phase === "working")) this.claimed.add(droneRockKey(drone.flight.rock));
    }
  }

  private destroyed = (rock: DroneRockId): boolean =>
    this.mined.has(droneRockKey(rock)) || !!this.mining?.asteroids.has(rock.fieldId, rock.chunkKey, rock.instanceId);

  private editStorage(depot: DepotRecord): Transfer {
    const storage = { ...depot.storage };
    this.depotMap.set(depot.id, { ...depot, storage });
    return storage;
  }

  private refine(depot: DepotRecord): void {
    if (!depot.refinery || !depot.storage.items.hydrates || space(depot.storage, DRONE_FUEL_ID) < T.refineKgPerHydrate) return;
    const progress = depot.refineProgressS + 1;
    if (progress < T.refineSeconds) {
      this.depotMap.set(depot.id, { ...depot, refineProgressS: progress });
      return;
    }
    const storage = {
      ...depot.storage, items: changedCount(depot.storage.items, "hydrates", -1), fuelKg: depot.storage.fuelKg + T.refineKgPerHydrate,
    };
    this.depotMap.set(depot.id, { ...depot, storage, refineProgressS: 0 });
  }

  private depart(drone: DroneRecord, home: DepotRecord, lane: 1 | -1): DroneRecord {
    const job = drone.job;
    if (!job) return standBy(drone, "unassigned");
    if (!job.enabled) return standBy(drone, "paused");
    if (job.kind === "mine") return this.departMining(drone, home, job, lane);

    const toPoint = job.kind === "haul" && job.targetKind === "point";
    const point = toPoint && Object.hasOwn(this.pointTanks, job.targetId)
      ? this.points.find(p => p.id === job.targetId && !p.starter) : undefined;
    const destination = job.kind === "haul" && !toPoint ? this.depotMap.get(job.targetId) : undefined;
    const target = point ?? destination;
    const route = target && estimateDroneRoute(home, target);
    if (!route) return standBy(drone, "route_out_of_range");
    const plan = point ? planDronePointDelivery(home, this.pointTanks[point.id], job, route)
      : destination && planDroneHaul(home, destination, job, route);
    if (!plan) return standBy(drone, "route_out_of_range");
    if (!plan.load) return standBy(drone, plan.status);
    const cargo = emptyStorage();
    const { load, itemId } = plan;
    const storage = this.editStorage(home);
    storage.fuelKg -= load.roundTripFuelKg;
    move(storage, cargo, itemId, load.amount);
    return { ...inPhase(drone, "outbound", "departing", route.legSeconds), cargo,
      fuelKg: load.returnFuelKg, returnS: route.legSeconds, via: null,
      flight: { profile: route.profile, returnFuelAtDryKg: route.returnFuelAtDryKg } };
  }

  private departMining(drone: DroneRecord, home: DepotRecord, job: DroneJob, lane: 1 | -1): DroneRecord {
    const scouting = drone.phase === "scouting";
    const cargoKg = payloadMassKg(drone.cargo);
    const stop = (status: DroneStatus) => scouting ? beginMiningReturn(drone, home, lane, cargoKg) : standBy(drone, status);
    if (!this.mining || !job.mineFilter || !canMineField(home, job.targetId)) {
      return stop("source_out_of_range");
    }
    const carried = storageUnits(drone.cargo);
    const room = Math.min(T.loadUnits - carried, T.cargoCapacity - storageUnits(home.storage) - carried);
    if (room <= 0) return stop("destination_full");
    if (job.keepResourceIds?.every(id => space(home.storage, id, job.stopAt) <= stock(drone.cargo, id))) {
      return stop("destination_full");
    }
    const fuel = scouting ? drone.fuelKg : Math.min(miningTankKg, home.storage.fuelKg - job.reserveKg);
    if (fuel <= 0) return stop("needs_fuel");
    const berth = drone.sortie?.homeKm ?? miningBerthPosition(home, lane);
    const fromKm = drone.sortie?.leg.toKm ?? berth;
    const from = { frameId: home.frameId, positionKm: fromKm };
    let roomNeeded = false, fuelNeeded = false;
    const flightFor = (candidate: MiningCandidate) => {
      if (this.claimed.has(droneRockKey(candidate.rock))) return null;
      const loot = Object.entries(retainedDroneLoot(candidate.loot, job.keepResourceIds));
      if (!loot.length) return null;
      const eligible = loot.filter(([id]) => space(home.storage, id, job.stopAt) > stock(drone.cargo, id));
      if (!eligible.length) {
        roomNeeded = true;
        return null;
      }
      const toKm = miningApproachPosition(fromKm, candidate.rock, lane);
      if (!clearsMiningCorridor({ frameId: home.frameId, positionKm: berth }, from, { frameId: home.frameId, positionKm: toKm })) return null;
      const plan = planMiningHop(berth, fromKm, toKm, fuel, cargoKg);
      if (!plan.loadUnits) {
        fuelNeeded = true;
        return null;
      }
      const preferred = job.mineFilter?.mode === "resource" ? job.mineFilter.ids : [];
      eligible.sort(([a], [b]) => Number(preferred.includes(b)) - Number(preferred.includes(a)) ||
        (a < b ? -1 : Number(a !== b)));
      const manifest: Record<string, number> = {};
      let left = Math.min(room, plan.loadUnits);
      for (const [id, amount] of eligible) {
        const take = Math.min(left, amount, space(home.storage, id, job.stopAt) - stock(drone.cargo, id));
        if (take > 0) manifest[id] = take;
        left -= take;
        if (!left) break;
      }
      return { ...plan, manifest };
    };
    const { candidate, searching } = this.mining.search.find(home, job.targetId, job.mineFilter,
      this.mining.difficulty, this.destroyed, candidate => !!flightFor(candidate), fromKm);
    if (searching) return scouting ? drone : standBy(drone, "searching");
    const hop = candidate && flightFor(candidate);
    if (!candidate || !hop) return stop(fuelNeeded ? "needs_fuel" : roomNeeded ? "destination_full" : "no_matching_rock");
    this.claimed.add(droneRockKey(candidate.rock));
    if (!scouting) this.editStorage(home).fuelKg -= fuel;
    return { ...inPhase(drone, "outbound", "departing", hop.durationS), fuelKg: fuel - hop.leg.burnKg, returnS: hop.returnS, via: null,
      flight: { profile: "local", returnFuelAtDryKg: candidate.route.returnFuelAtDryKg, rock: candidate.rock },
      sortie: { homeKm: berth, lane, leg: hop.leg, manifest: hop.manifest } };
  }

  private completeWork(drone: DroneRecord, home: DepotRecord, lane: 1 | -1): DroneRecord {
    const job = drone.job;
    const cargo = { ...drone.cargo };
    if (job?.kind === "mine" && job.mineFilter && drone.flight?.rock && this.mining) {
      const rock = drone.flight.rock;
      const fullLoot = job.targetId === rock.fieldId && !this.destroyed(rock) && estimateDroneWorkRoute(home, rock) &&
        resolveDroneLoot(rock, this.mining.difficulty, job.mineFilter);
      const allowed = fullLoot && retainedDroneLoot(fullLoot, job.keepResourceIds);
      const loot = drone.sortie ? drone.sortie.manifest : allowed;
      if (allowed && loot && Object.keys(loot).length && Object.entries(loot).every(([id, count]) => count <= (allowed[id] ?? 0))) {
        const items = { ...cargo.items };
        for (const [id, amount] of Object.entries(loot)) items[id] = (items[id] ?? 0) + amount;
        const manifest = { ...cargo, items };
        const cargoKg = payloadMassKg(manifest);
        const cost = drone.sortie ? miningReturnFuelAtRestKg(drone.sortie.homeKm, drone.sortie.leg.toKm, cargoKg, drone.fuelKg)
          : planDroneReturnFuel(drone.flight.returnFuelAtDryKg, cargoKg);
        if (storageUnits(manifest) <= T.loadUnits && cost <= drone.fuelKg + EPSILON_KG) {
          cargo.items = items;
          this.mined.set(droneRockKey(rock), { fieldId: rock.fieldId, chunkKey: rock.chunkKey, instanceId: rock.instanceId });
        }
      }
      this.claimed.delete(droneRockKey(rock));
      if (drone.sortie) {
        const { homeKm, leg } = drone.sortie;
        const next = { ...inPhase(drone, "scouting", "searching", 0), cargo, sortie: { homeKm, lane, leg },
          flight: { profile: "local" as const, returnFuelAtDryKg: 0 } };
        return storageUnits(cargo) >= T.loadUnits || !job.enabled ? beginMiningReturn(next, home, lane, payloadMassKg(cargo)) : next;
      }
    } else if (job?.kind === "haul" && job.targetKind === "point") {
      if (Object.hasOwn(this.pointTanks, job.targetId)) {
        const fuelKg = this.pointTanks[job.targetId];
        const delivered = Math.min(cargo.fuelKg, pointFuelRoom(fuelKg, job.stopAt));
        if (delivered > 0) {
          cargo.fuelKg -= delivered;
          this.pointTanks = { ...this.pointTanks, [job.targetId]: fuelKg + delivered };
        }
      }
    } else if (job?.kind === "haul") {
      const destination = this.depotMap.get(job.targetId);
      if (destination && payloadIds(cargo).some(id => space(destination.storage, id, job.stopAt) > 0)) {
        unload(cargo, this.editStorage(destination), job.stopAt);
      }
    }

    // Older flights already reserved a fixed burn. New flights use their funded base rate and the actual return load.
    const unusedKg = drone.flight ? drone.fuelKg - planDroneReturnFuel(drone.flight.returnFuelAtDryKg, payloadMassKg(cargo)) : 0;
    return { ...inPhase(drone, "returning", "returning", drone.returnS), cargo, fuelKg: unusedKg > EPSILON_KG ? unusedKg : 0 };
  }

  private finishReturn(drone: DroneRecord, home: DepotRecord): DroneRecord {
    const pendingKg = drone.flight ? drone.fuelKg : 0;
    const ids = payloadIds(drone.cargo);
    const refund = Math.min(pendingKg, space(home.storage, DRONE_FUEL_ID));
    const canUnload = ids.some(id => space(home.storage, id) > 0);
    if (!canUnload && refund <= 0 && (ids.length > 0 || pendingKg > 0)) {
      return drone.status === "unload_blocked" ? drone : { ...drone, status: "unload_blocked", remainingS: 0 };
    }
    const cargo = { ...drone.cargo };
    const fuelKg = pendingKg - refund;
    if (canUnload || refund > 0) {
      const storage = this.editStorage(home);
      storage.fuelKg += refund;
      if (!unload(cargo, storage) || fuelKg > 0) return { ...drone, status: "unload_blocked", remainingS: 0, cargo, fuelKg };
    }
    return { ...standBy(drone, drone.job?.enabled ? "departing" : "paused"),
      cargo, fuelKg: 0, returnS: 0, via: null, flight: null,
      ...(drone.sortie && { sortie: null }) };
  }

  private stepDrone(drone: DroneRecord, index: number): DroneRecord {
    const home = this.depotMap.get(drone.homeId);
    if (!home) return drone;
    const lane = drone.sortie?.lane ?? (index % 2 === 0 ? 1 : -1);
    if (drone.phase === "idle") {
      if (payloadIds(drone.cargo).length > 0 || (drone.flight && drone.fuelKg > 0)) return this.finishReturn(drone, home);
      return this.depart(drone, home, lane);
    }
    if (drone.sortie && drone.job?.kind === "mine" && !drone.job.enabled && drone.phase !== "returning") {
      const returning = beginMiningReturn(drone, home, lane, payloadMassKg(drone.cargo));
      if (returning !== drone) return returning;
    }
    if (drone.phase === "scouting") return drone.job?.kind === "mine" && drone.job.enabled
      ? this.departMining(drone, home, drone.job, lane) : beginMiningReturn(drone, home, lane, payloadMassKg(drone.cargo));
    if (drone.remainingS > 1) return { ...drone, remainingS: drone.remainingS - 1 };
    if (drone.phase === "returning") return this.finishReturn(drone, home);
    if (drone.phase === "working") return this.completeWork(drone, home, lane);
    if (drone.job?.kind === "mine" && drone.flight?.rock) return inPhase(drone, "working", "mining", drone.flight.rock.workSeconds);
    return inPhase(drone, "working", "delivering", T.deliverySeconds);
  }

  step(): IndustryState {
    this.mining?.search.beginTick();
    for (const depot of this.state.depots) this.refine(depot);
    const scouts: number[] = [];
    const drones = this.state.drones.map((drone, i) => {
      if (this.mining && (drone.phase === "idle" || drone.phase === "scouting") && drone.job?.enabled &&
          drone.job.kind === "mine") {
        scouts.push(i);
        return drone;
      }
      return this.stepDrone(drone, i);
    });
    for (const i of this.mining?.search.orderScouts(scouts) ?? []) drones[i] = this.stepDrone(drones[i], i);
    return { ...this.state, drones, depots: Array.from(this.depotMap.values()), pointTanks: this.pointTanks };
  }
}

export interface IndustryAdvance {
  state: IndustryState;
  delta: IndustryDelta;
  economic: boolean;
}

/** Deterministic one-second substeps, driven by live active time from the owning runtime. */
export function advanceIndustry(
  state: IndustryState, elapsedS: number, points: readonly ReplicationPoint[] = [], mining?: IndustryMiningContext,
): IndustryAdvance | null {
  if (!state.depots.length || !Number.isFinite(elapsedS) || elapsedS <= 0 || elapsedS > T.maxTickGapS) return null;
  const totalS = state.remainderS + elapsedS;
  const steps = Math.floor(totalS + 1e-9);
  if (steps < 1) return { state: { ...state, remainderS: totalS }, delta: { depots: [], drones: [] }, economic: false };

  let next = state;
  const mined = new Map<string, DroneRockId>();
  for (let i = 0; i < steps; i++) next = new IndustryStep(next, points, mining, mined).step();
  const pointTanks = Object.entries(next.pointTanks).filter(([id, fuelKg]) => fuelKg !== state.pointTanks?.[id]);
  const delta: IndustryDelta = {
    depots: next.depots.filter((d, i) => d !== state.depots[i]),
    drones: next.drones.filter((d, i) => d !== state.drones[i]),
    ...(mined.size > 0 && { mined: Array.from(mined.values()) }),
    ...(pointTanks.length > 0 && { pointTanks: Object.fromEntries(pointTanks) }),
  };
  const economic = mined.size > 0 || pointTanks.length > 0 || next.depots.some((d, i) => d.storage !== state.depots[i].storage)
    || next.drones.some((d, i) => {
      const before = state.drones[i];
      return d.fuelKg !== before.fuelKg || d.cargo.items !== before.cargo.items || d.cargo.fuelKg !== before.cargo.fuelKg;
    });
  return { state: { ...next, remainderS: Math.max(0, totalS - steps) }, delta, economic };
}

export function hasIndustryDelta(delta: IndustryDelta): boolean {
  return !!delta.mined?.length || delta.depots.length > 0 || delta.drones.length > 0 ||
    !!delta.pointTanks && Object.keys(delta.pointTanks).length > 0;
}

function mergeRecords<T extends { id: string }>(before: T[], updated: T[]): T[] {
  if (!updated.length) return before;
  const byId = new Map(before.map(record => [record.id, record]));
  for (const record of updated) byId.set(record.id, record);
  return Array.from(byId.values());
}

export function applyIndustryDelta(state: IndustryState, delta: IndustryDelta): IndustryState {
  return {
    ...state,
    depots: mergeRecords(state.depots, delta.depots),
    drones: mergeRecords(state.drones, delta.drones),
    pointTanks: delta.pointTanks ? { ...state.pointTanks, ...delta.pointTanks } : state.pointTanks,
  };
}
