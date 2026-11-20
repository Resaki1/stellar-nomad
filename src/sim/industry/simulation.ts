import type { Transfer } from "@/sim/world/commands";
import { DRONE_FUEL_ID, getIndustrySource, INDUSTRY_SOURCES, INDUSTRY_TUNING as T } from "./catalog";
import { estimateDroneExtractionRoute, estimateDroneRoute } from "./route";
import { emptyStorage, type DepotRecord, type DroneRecord, type DroneStatus, type IndustryDelta, type IndustryState, type SourceStock } from "./types";

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

  constructor(private readonly state: IndustryState) {
    for (const depot of state.depots) this.depotMap.set(depot.id, depot);
    for (const [id, source] of Object.entries(state.sources)) this.sourceMap.set(id, source);
  }

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

    const source = job.kind === "extract" ? getIndustrySource(job.targetId) : undefined;
    const destination = job.kind === "haul" ? this.depotMap.get(job.targetId) : undefined;
    const route = source ? estimateDroneExtractionRoute(home, source, this.state.depots)
      : destination && estimateDroneRoute(home, destination);
    if (!route) return standBy(drone, job.kind === "extract" ? "source_out_of_range" : "route_out_of_range");
    const surplusKg = home.storage.fuelKg - route.roundTripFuelKg - job.reserveKg;
    if (surplusKg < 0) return standBy(drone, "needs_fuel");
    const cargo = emptyStorage();
    let loadId: string | undefined;
    let amount = 0;

    if (source) {
      if (space(home.storage, source.materialId, job.stopAt) <= 0) return standBy(drone, "destination_full");
      if (this.sourceMap.get(source.id)?.available === 0) return standBy(drone, "no_cargo");
    }
    if (destination) {
      let hasRoom = false;
      for (const id of job.priorities) {
        const room = space(destination.storage, id, job.stopAt);
        if (room <= 0) continue;
        hasRoom = true;
        const available = id === DRONE_FUEL_ID ? surplusKg : stock(home.storage, id);
        amount = Math.min(available, room, id === DRONE_FUEL_ID ? T.loadFuelKg : T.loadUnits);
        if (amount > 0) {
          loadId = id;
          break;
        }
      }
      if (!loadId) return standBy(drone, hasRoom ? "no_cargo" : "destination_full");
    }

    const storage = this.editStorage(home);
    storage.fuelKg -= route.roundTripFuelKg;
    if (loadId) move(storage, cargo, loadId, amount);
    return { ...inPhase(drone, "outbound", "departing", route.legSeconds), cargo,
      fuelKg: route.roundTripFuelKg / 2, returnS: route.legSeconds, via: null };
  }

  private completeWork(drone: DroneRecord, home: DepotRecord): DroneRecord {
    const job = drone.job;
    const cargo = { ...drone.cargo };
    if (job?.kind === "extract") {
      const source = getIndustrySource(job.targetId);
      if (source) {
        const stock = this.sourceMap.get(source.id) ?? { available: T.sourceCapacity, replenishProgressS: 0 };
        const amount = Math.min(T.extractUnits, stock.available, space(home.storage, source.materialId, job.stopAt));
        if (amount > 0) {
          cargo.items = changedCount(cargo.items, source.materialId, amount);
          this.sourceMap.set(source.id, { ...stock, available: stock.available - amount });
        }
      }
    } else if (job?.kind === "haul") {
      const destination = this.depotMap.get(job.targetId);
      if (destination && payloadIds(cargo).some(id => space(destination.storage, id, job.stopAt) > 0)) {
        unload(cargo, this.editStorage(destination), job.stopAt);
      }
    }

    return { ...inPhase(drone, "returning", "returning", drone.returnS), cargo, fuelKg: 0 };
  }

  private finishReturn(drone: DroneRecord, home: DepotRecord): DroneRecord {
    const ids = payloadIds(drone.cargo);
    if (ids.length > 0 && !ids.some(id => space(home.storage, id) > 0)) {
      return drone.status === "unload_blocked" ? drone : { ...drone, status: "unload_blocked", remainingS: 0 };
    }
    const cargo = { ...drone.cargo };
    if (ids.length > 0 && !unload(cargo, this.editStorage(home))) {
      return { ...drone, status: "unload_blocked", remainingS: 0, cargo };
    }
    return { ...standBy(drone, drone.job?.enabled ? "departing" : "paused"), cargo, returnS: 0, via: null };
  }

  private stepDrone(drone: DroneRecord): DroneRecord {
    const home = this.depotMap.get(drone.homeId);
    if (!home) return drone;
    if (drone.phase === "idle") {
      if (payloadIds(drone.cargo).length > 0) return this.finishReturn(drone, home);
      return this.depart(drone, home);
    }
    if (drone.remainingS > 1) return { ...drone, remainingS: drone.remainingS - 1 };
    if (drone.phase === "returning") return this.finishReturn(drone, home);
    if (drone.phase === "working") return this.completeWork(drone, home);
    return drone.job?.kind === "extract"
      ? inPhase(drone, "working", "extracting", T.extractSeconds)
      : inPhase(drone, "working", "delivering", T.deliverySeconds);
  }

  step(): IndustryState {
    for (const source of INDUSTRY_SOURCES) this.advanceSource(source.id);
    for (const depot of this.state.depots) this.refine(depot);
    const drones = this.state.drones.map(d => this.stepDrone(d));
    return { ...this.state, drones, depots: Array.from(this.depotMap.values()), sources: Object.fromEntries(this.sourceMap) };
  }
}

export interface IndustryAdvance {
  state: IndustryState;
  delta: IndustryDelta;
  economic: boolean;
}

/** Deterministic one-second substeps, driven by live active time from the owning runtime. */
export function advanceIndustry(state: IndustryState, elapsedS: number): IndustryAdvance | null {
  if (!state.depots.length || !Number.isFinite(elapsedS) || elapsedS <= 0 || elapsedS > T.maxTickGapS) return null;
  const totalS = state.remainderS + elapsedS;
  const steps = Math.floor(totalS + 1e-9);
  if (steps < 1) return { state: { ...state, remainderS: totalS }, delta: { depots: [], drones: [], sources: {} }, economic: false };

  let next = state;
  for (let i = 0; i < steps; i++) next = new IndustryStep(next).step();
  const delta: IndustryDelta = {
    depots: next.depots.filter((d, i) => d !== state.depots[i]),
    drones: next.drones.filter((d, i) => d !== state.drones[i]),
    sources: Object.fromEntries(Object.entries(next.sources).filter(([id, source]) => source !== state.sources[id])),
  };
  const economic = next.depots.some((d, i) => d.storage !== state.depots[i].storage)
    || next.drones.some((d, i) => {
      const before = state.drones[i];
      return d.fuelKg !== before.fuelKg || d.cargo.items !== before.cargo.items || d.cargo.fuelKg !== before.cargo.fuelKg;
    });
  return { state: { ...next, remainderS: Math.max(0, totalS - steps) }, delta, economic };
}

export function hasIndustryDelta(delta: IndustryDelta): boolean {
  return delta.depots.length > 0 || delta.drones.length > 0 || Object.keys(delta.sources).length > 0;
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
  };
}
