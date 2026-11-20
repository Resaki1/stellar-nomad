import type { Difficulty, ReplicationPoint } from "@/save/types";
import type { Transfer } from "@/sim/world/commands";
import { DRONE_FUEL_ID, getIndustrySource, INDUSTRY_SOURCES, INDUSTRY_TUNING as T, POINT_TANK_CAPACITY_KG } from "./catalog";
import {
  dronePayloadMassKg, estimateDroneRoute, estimateDroneWorkRoute, planDroneFuel, planDroneLoad, planDroneReturnFuel, type DroneRoute,
} from "./route";
import { canMineField, droneRockKey, finiteMiningJob, resolveDroneLoot, type DroneMiningSearch } from "./mining";
import { emptyStorage, type DepotRecord, type DroneJob, type DroneRecord, type DroneRockId, type DroneStatus, type IndustryDelta, type IndustryState, type SourceStock } from "./types";

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

function payloadMassKg(storage: Transfer): number {
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
  private readonly sourceMap = new Map<string, SourceStock>();
  private pointTanks: IndustryState["pointTanks"];
  private readonly claimed = new Set<string>();

  constructor(
    private readonly state: IndustryState,
    private readonly points: readonly ReplicationPoint[],
    private readonly mining: IndustryMiningContext | undefined,
    private readonly mined: Map<string, DroneRockId>,
  ) {
    for (const depot of state.depots) this.depotMap.set(depot.id, depot);
    for (const [id, source] of Object.entries(state.sources)) this.sourceMap.set(id, source);
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

  private advanceSource(id: string): void {
    const source = this.sourceMap.get(id);
    if (!source || source.available >= T.sourceCapacity) return;
    const ready = source.replenishProgressS + 1 >= T.sourceSecondsPerUnit;
    this.sourceMap.set(id, ready
      ? { available: source.available + 1, replenishProgressS: 0 }
      : { ...source, replenishProgressS: source.replenishProgressS + 1 });
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

  private depart(drone: DroneRecord, home: DepotRecord): DroneRecord {
    const job = drone.job;
    if (!job) return standBy(drone, "unassigned");
    if (!job.enabled) return standBy(drone, "paused");
    if (job.kind === "mine") return this.departMining(drone, home, job);

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

  private departMining(drone: DroneRecord, home: DepotRecord, job: DroneJob): DroneRecord {
    if (!this.mining || !job.mineFilter || !canMineField(home, job.targetId)) {
      return standBy(drone, "source_out_of_range");
    }
    const room = T.cargoCapacity - storageUnits(home.storage);
    if (room <= 0) return standBy(drone, "destination_full");
    const fuel = home.storage.fuelKg - job.reserveKg;
    if (fuel <= 0) return standBy(drone, "needs_fuel");
    let roomNeeded = false, fuelNeeded = false;
    const { candidate, searching } = this.mining.search.find(home, job.targetId, job.mineFilter, this.mining.difficulty, this.destroyed, candidate => {
      if (this.claimed.has(droneRockKey(candidate.rock))) return false;
      if (candidate.units > room || Object.entries(candidate.loot).some(([id, amount]) => amount > space(home.storage, id, job.stopAt))) {
        roomNeeded = true;
        return false;
      }
      const funded = planDroneFuel(candidate.route, 0, candidate.units * T.cargoUnitMassKg).roundTripFuelKg;
      if (funded > Math.min(fuel, T.droneTankKg)) {
        fuelNeeded = true;
        return false;
      }
      return true;
    });
    if (!candidate) return standBy(drone, searching ? "searching" : fuelNeeded ? "needs_fuel" : roomNeeded ? "destination_full" : "no_matching_rock");
    this.claimed.add(droneRockKey(candidate.rock));
    const { route, rock, units } = candidate;
    const funded = planDroneFuel(route, 0, units * T.cargoUnitMassKg);
    this.editStorage(home).fuelKg -= funded.roundTripFuelKg;
    return { ...inPhase(drone, "outbound", "departing", route.legSeconds), fuelKg: funded.returnFuelKg, returnS: route.legSeconds, via: null,
      flight: { profile: route.profile, returnFuelAtDryKg: route.returnFuelAtDryKg, rock } };
  }

  private completeWork(drone: DroneRecord, home: DepotRecord): DroneRecord {
    const job = drone.job;
    const cargo = { ...drone.cargo };
    if (job?.kind === "mine" && job.mineFilter && drone.flight?.rock && this.mining) {
      const rock = drone.flight.rock;
      const loot = job.targetId === rock.fieldId && !this.destroyed(rock) && estimateDroneWorkRoute(home, rock) &&
        resolveDroneLoot(rock, this.mining.difficulty, job.mineFilter);
      if (loot) {
        const items = { ...cargo.items };
        for (const [id, amount] of Object.entries(loot)) items[id] = (items[id] ?? 0) + amount;
        const manifest = { ...cargo, items };
        const cost = planDroneReturnFuel(drone.flight.returnFuelAtDryKg, payloadMassKg(manifest));
        if (storageUnits(manifest) <= T.loadUnits && cost <= drone.fuelKg + EPSILON_KG) {
          cargo.items = items;
          this.mined.set(droneRockKey(rock), { fieldId: rock.fieldId, chunkKey: rock.chunkKey, instanceId: rock.instanceId });
        }
      }
    } else if (job?.kind === "extract") {
      const source = getIndustrySource(job.targetId);
      if (source) {
        const stock = this.sourceMap.get(source.id) ?? { available: T.sourceCapacity, replenishProgressS: 0 };
        const amount = Math.min(drone.flight?.extractUnits ?? T.extractUnits, stock.available, space(home.storage, source.materialId, job.stopAt));
        if (amount > 0) {
          cargo.items = changedCount(cargo.items, source.materialId, amount);
          this.sourceMap.set(source.id, { ...stock, available: stock.available - amount });
        }
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
      job: drone.job && finiteMiningJob(drone.job), cargo, fuelKg: 0, returnS: 0, via: null, flight: null };
  }

  private stepDrone(drone: DroneRecord): DroneRecord {
    const home = this.depotMap.get(drone.homeId);
    if (!home) return drone;
    if (drone.phase === "idle") {
      if (payloadIds(drone.cargo).length > 0 || (drone.flight && drone.fuelKg > 0)) return this.finishReturn(drone, home);
      const job = drone.job && finiteMiningJob(drone.job);
      return this.depart(job === drone.job ? drone : { ...drone, job }, home);
    }
    if (drone.remainingS > 1) return { ...drone, remainingS: drone.remainingS - 1 };
    if (drone.phase === "returning") return this.finishReturn(drone, home);
    if (drone.phase === "working") return this.completeWork(drone, home);
    if (drone.job?.kind === "mine" && drone.flight?.rock) return inPhase(drone, "working", "mining", drone.flight.rock.workSeconds);
    return drone.job?.kind === "extract"
      ? inPhase(drone, "working", "extracting", T.extractSeconds)
      : inPhase(drone, "working", "delivering", T.deliverySeconds);
  }

  step(): IndustryState {
    this.mining?.search.beginTick();
    for (const source of INDUSTRY_SOURCES) {
      if (this.state.drones.some(d => d.job?.kind === "extract" && d.job.targetId === source.id && d.phase !== "idle")) this.advanceSource(source.id);
    }
    for (const depot of this.state.depots) this.refine(depot);
    const scouts: number[] = [];
    const drones = this.state.drones.map((drone, i) => {
      if (this.mining && drone.phase === "idle" && drone.job?.enabled &&
          (drone.job.kind === "mine" || drone.job.kind === "extract")) {
        scouts.push(i);
        return drone;
      }
      return this.stepDrone(drone);
    });
    for (const i of this.mining?.search.orderScouts(scouts) ?? []) drones[i] = this.stepDrone(drones[i]);
    return { ...this.state, drones, depots: Array.from(this.depotMap.values()), sources: Object.fromEntries(this.sourceMap), pointTanks: this.pointTanks };
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
  if (steps < 1) return { state: { ...state, remainderS: totalS }, delta: { depots: [], drones: [], sources: {} }, economic: false };

  let next = state;
  const mined = new Map<string, DroneRockId>();
  for (let i = 0; i < steps; i++) next = new IndustryStep(next, points, mining, mined).step();
  const pointTanks = Object.entries(next.pointTanks).filter(([id, fuelKg]) => fuelKg !== state.pointTanks?.[id]);
  const delta: IndustryDelta = {
    depots: next.depots.filter((d, i) => d !== state.depots[i]),
    drones: next.drones.filter((d, i) => d !== state.drones[i]),
    sources: Object.fromEntries(Object.entries(next.sources).filter(([id, source]) => source !== state.sources[id])),
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
  return !!delta.mined?.length || delta.depots.length > 0 || delta.drones.length > 0 || Object.keys(delta.sources).length > 0 ||
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
    sources: { ...state.sources, ...delta.sources },
    pointTanks: delta.pointTanks ? { ...state.pointTanks, ...delta.pointTanks } : state.pointTanks,
  };
}
