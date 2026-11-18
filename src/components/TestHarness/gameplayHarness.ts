/**
 * `__test.gameplay` — M3 domain-operation hooks for scripts/drive-examples/gameplay-check.mjs.
 * Fixture worlds are named with FIXTURE_PREFIX; `fixtures.remove` deletes nothing else.
 */
import type { createStore } from "jotai";
import { getActiveSave, sampleCollectors } from "@/save/activeSave";
import { getLocalPlayerId, setLastWorldId } from "@/save/playerId";
import { deleteWorld, exportWorld, importWorld, listWorlds, newWorldId, putWorld } from "@/save/saveDb";
import type { SaveData, SaveMeta } from "@/save/types";
import { parseSaveData } from "@/save/validate";
import { buildMineOperation } from "@/sim/asteroids/mineOperation";
import type { OperationOutcome, WorldOperation } from "@/sim/world/commands";
import { newOpId, worldAuthority } from "@/sim/world/worldAuthority";
import { Vector3 } from "three";
import { frameOriginKm } from "@/sim/frames";
import { cargoAtom, cargoCapacityUnitsAtom, removeCargoAtom } from "@/store/cargo";
import { devTeleportAtom } from "@/store/dev";
import { dieAtom, isDeadAtom, wrecksMirrorAtom } from "@/store/death";
import { asteroidsMinedLifetimeAtom } from "@/store/mining";
import { craftItemAtom, modulesAtom } from "@/store/modules";
import { researchAtom, sharedResearchMirrorAtom } from "@/store/research";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { shipHealthAtom } from "@/store/store";
import { systemConfigAtom } from "@/store/system";
import { runOperation } from "@/store/operations";
import { testProbe } from "./testProbe";
import { computeMiningDurationS, getAsteroidMiningReward } from "@/sim/asteroids/resources";
import { getActiveAsteroidRuntime } from "@/sim/asteroids/runtimeContext";
import { getLocalPlayerShip } from "@/sim/entities";
import { simulateResources, type ResourceScript } from "@/sim/ship/resourceSim";
import { getResourceTuning, resetResourceTuning, setResourceTuning, type ResourceTuning } from "@/sim/ship/resourceTuning";
import { miningStateAtom, startMiningAtom } from "@/store/mining";
import { settingsIsOpenAtom } from "@/store/store";
import { setSimPaused } from "@/sim/simPause";
import {
  abandonShipAtom,
  cancelProcessingAtom,
  setRepairAtom,
  shipRes,
  shipResControl,
  shipReq,
  shipResourcesHudAtom,
  startProcessingAtom,
} from "@/store/shipResources";
import { Quaternion } from "three";
import { simulateTransit, type TransitScript } from "@/sim/ship/transitSim";
import { computeTransitPreview, targetedPOIAtom, transitDriveBuffer, transitInputs, transitPreviewPlan } from "@/store/transit";
import { allBodyDefs } from "@/sim/celestialConstants";
import { nearField } from "@/sim/physics/nearField";

type Store = ReturnType<typeof createStore>;

export const FIXTURE_PREFIX = "[gc] ";

type OpInput = Omit<WorldOperation, "opId"> & { opId?: string };

type RockRef = { fieldId: string; chunkKey: string; instanceId: number };

type TransitRecord = {
  frames: number; minDistKm: Record<string, number>; frameIds: string[]; phases: string[]; maxSpeedKmps: number; maxHeat01: number;
  engageStep: number; endStep: number; kg0: number; kgUsed: number; suspended: string[]; done: boolean;
};
let transitRecorder: { rec: TransitRecord; stop: () => TransitRecord } | null = null;

export function createGameplayHarness(store: Store) {
  /** Live system-frame position of a rock (fields ride their body), or a fixed point. */
  const resolveKm = (t: number[] | RockRef): number[] | null => {
    if (Array.isArray(t)) return t;
    const f = (store.get(systemConfigAtom).asteroidFields ?? []).find((x) => x.id === t.fieldId);
    const chunk = getActiveAsteroidRuntime()?.getFieldRuntime(t.fieldId)?.getChunk(t.chunkKey);
    if (!f || !chunk) return null;
    for (const modelId in chunk.instancesByModel) {
      const inst = chunk.instancesByModel[modelId];
      for (let i = 0; i < inst.count; i++) {
        if (inst.instanceIds[i] >>> 0 !== t.instanceId >>> 0) continue;
        return [0, 1, 2].map((k) => f.anchorKm[k] + chunk.originKm[k] + inst.positionsM[i * 3 + k] / 1000);
      }
    }
    return null;
  };

  const withId = (op: OpInput): WorldOperation => ({ ...op, opId: op.opId ?? newOpId() }) as WorldOperation;

  return {
    localId: (): string => getLocalPlayerId(),
    /** Submit as `by` (default: local player). Returns the settled outcome. */
    submit(op: OpInput, by?: string): OperationOutcome {
      // As runOperation does: live runtime values into the record before a local-player op.
      if (!by || by === getLocalPlayerId()) sampleCollectors();
      return worldAuthority.submit(withId(op), by ?? getLocalPlayerId());
    },
    world: () => structuredClone(getActiveSave()?.data.world ?? null),
    /** The record as an operation would see it (live sampled values included). */
    player: (id?: string) => {
      sampleCollectors();
      return structuredClone(getActiveSave()?.data.players[id ?? getLocalPlayerId()] ?? null);
    },
    /** What the UI atoms hold now (must equal the save after every operation). */
    mirrors: () => ({
      cargo: store.get(cargoAtom),
      research: store.get(researchAtom),
      modules: store.get(modulesAtom),
      isDead: store.get(isDeadAtom),
      health: store.get(shipHealthAtom),
      minedLifetime: store.get(asteroidsMinedLifetimeAtom),
      completedNodes: [...store.get(sharedResearchMirrorAtom)],
      wrecks: store.get(wrecksMirrorAtom),
      maxHealth: store.get(effectiveShipConfigAtom).maxHealth,
      cargoCapacity: store.get(cargoCapacityUnitsAtom),
    }),
    /** Pure migration + sanitising of a raw save object (no IndexedDB). */
    parse: (raw: unknown): SaveData => parseSaveData(raw),

    /** Mine a rock with the same claim builder MiningSystem uses (aiming skipped). */
    mine(t: { fieldId: string; chunkKey: string; instanceId: number; radiusM: number }, opId?: string): OperationOutcome {
      const cfg = store.get(effectiveShipConfigAtom);
      const op = buildMineOperation(
        store.get(systemConfigAtom),
        t,
        { miningEfficiencyMult: cfg.miningEfficiencyMult, assaySampleBonusChance: cfg.assaySampleBonusChance, minedLifetime: store.get(asteroidsMinedLifetimeAtom) },
        opId ?? newOpId(),
        () => 1,
      );
      return runOperation(op);
    },
    /** The crafting panel's action. */
    craft(itemId: string): OperationOutcome | null {
      const out: { o: OperationOutcome | null } = { o: null };
      store.set(craftItemAtom, { itemId, onSettled: (o) => (out.o = o) });
      return out.o;
    },
    /** The ship's death path (as a fatal impact calls it), at the current pose. */
    kill(): OperationOutcome | null {
      const s = testProbe.ship;
      return store.set(dieAtom, { frameId: s.frameId, positionKm: [s.relPosKm[0], s.relPosKm[1], s.relPosKm[2]] });
    },
    /** The cargo panel's jettison. */
    jettison: (resourceId: string, amount?: number): void => store.set(removeCargoAtom, { resourceId, amount }),
    /** Teleport by an offset from the ship's current system-frame position, km. */
    nudgeKm(dx: number, dy: number, dz: number): void {
      const p = testProbe.ship.posKm;
      store.set(devTeleportAtom, { positionKm: [p[0] + dx, p[1] + dy, p[2] + dz] });
    },
    /** Teleport `offsetM` from a wreck along +x (system frame), facing it. */
    teleportToWreck(wreckId: string, offsetM = 100): boolean {
      const w = getActiveSave()?.data.world.wrecks.find((x) => x.id === wreckId);
      if (!w) return false;
      const o = frameOriginKm(w.frameId, new Vector3());
      store.set(devTeleportAtom, { positionKm: [o.x + w.positionKm[0] + offsetM / 1000, o.y + w.positionKm[1], o.z + w.positionKm[2]] });
      return true;
    },

    /** M3.2 ship resources: pure simulation, live runtime state and the player actions. */
    res: {
      simulate: (script: ResourceScript) => simulateResources(script),
      tuning: (): ResourceTuning => ({ ...getResourceTuning() }),
      setTuning: (p: Partial<ResourceTuning>): void => setResourceTuning(p),
      resetTuning: (): void => resetResourceTuning(),
      state() {
        const r = shipRes;
        return {
          ordinaryKg: r.ordinaryKg, protectedKg: r.protectedKg, heat01: r.heat01, capacitor01: r.capacitor01, tripped: r.miningTripped,
          processing: { ...r.processing }, meter: { ...r.meter }, powerScale: r.powerScale, heatScale: r.heatScale,
          miningScale: r.miningScale, processingScale: r.processingScale, repairScale: r.repairScale, tankFull: r.tankFull,
          req: { ...shipReq }, control: { ...shipResControl }, hud: store.get(shipResourcesHudAtom),
          boostCharge: getLocalPlayerShip()?.boostCharge ?? null, health: store.get(shipHealthAtom), maxHealth: store.get(effectiveShipConfigAtom).maxHealth,
        };
      },
      /** Dev: overwrite runtime stores (test setup only). */
      set(p: { ordinaryKg?: number; protectedKg?: number; heat01?: number }): void {
        if (p.ordinaryKg !== undefined) shipRes.ordinaryKg = p.ordinaryKg;
        if (p.protectedKg !== undefined) shipRes.protectedKg = p.protectedKg;
        if (p.heat01 !== undefined) shipRes.heat01 = p.heat01;
      },
      forceMining: (on: boolean): void => {
        shipResControl.forceMining = on;
      },
      startProcessing: (units: number, recipeId = "hydrate_propellant"): OperationOutcome => store.set(startProcessingAtom, { recipeId, units }),
      cancelProcessing: (): OperationOutcome => store.set(cancelProcessingAtom),
      repair: (on: boolean): boolean => store.set(setRepairAtom, on),
      abandon: (): boolean => store.set(abandonShipAtom),
      setSettingsOpen: (on: boolean): void => store.set(settingsIsOpenAtom, on),
      setLoadingPause: (on: boolean): void => setSimPaused(on, "test"),
      /** Hydrate-bearing rocks among the loaded chunks, nearest first (STARTER REACH measurement). */
      starterReach(n = 8) {
        const rt = getActiveAsteroidRuntime();
        const system = store.get(systemConfigAtom);
        const ship = testProbe.ship.posKm;
        const speedMult = store.get(effectiveShipConfigAtom).miningSpeedMult;
        const out: { fieldId: string; chunkKey: string; instanceId: number; distKm: number; radiusM: number; hydrates: number; total: number; mineS: number; posKm: number[] }[] = [];
        let rocks = 0;
        for (const f of system.asteroidFields ?? []) {
          const fr = rt?.getFieldRuntime(f.id);
          if (!fr) continue;
          fr.chunks.forEach((chunk, chunkKey) => {
            for (const modelId in chunk.instancesByModel) {
              const inst = chunk.instancesByModel[modelId];
              for (let i = 0; i < inst.count; i++) {
                rocks++;
                const id = inst.instanceIds[i] >>> 0;
                const radiusM = inst.radiiM[i];
                const reward = getAsteroidMiningReward(system, f.id, id, radiusM);
                const hyd = reward?.resources.find((r) => r.resourceId === "hydrates")?.amount ?? 0;
                if (hyd < 1) continue;
                const x = f.anchorKm[0] + chunk.originKm[0] + inst.positionsM[i * 3] / 1000;
                const y = f.anchorKm[1] + chunk.originKm[1] + inst.positionsM[i * 3 + 1] / 1000;
                const z = f.anchorKm[2] + chunk.originKm[2] + inst.positionsM[i * 3 + 2] / 1000;
                out.push({
                  fieldId: f.id, chunkKey, instanceId: id, radiusM, hydrates: hyd, total: reward?.totalAmount ?? 0,
                  distKm: Math.hypot(x - ship[0], y - ship[1], z - ship[2]), mineS: computeMiningDurationS(radiusM) / speedMult, posKm: [x, y, z],
                });
              }
            }
          });
        }
        out.sort((a, b) => a.distKm - b.distKm);
        // Mineable from a cold laser: extraction must finish before the 15 s over-temperature trip.
        const cold = out.filter((r) => r.mineS < 14);
        const rich = [...cold].sort((a, b) => b.hydrates - a.hydrates || a.distKm - b.distKm).filter((r) => r.distKm < 25);
        return { rocksLoaded: rocks, hydrateRocks: out.length, nearest: out.slice(0, n), nearestColdMineable: cold.slice(0, n), richestWithin25Km: rich.slice(0, n) };
      },
      /** Dev aiming shortcut: point the nose at a system-frame position (no rotation charge). */
      face(target: number[] | RockRef): boolean {
        const ship = getLocalPlayerShip();
        const targetKm = resolveKm(target);
        if (!ship || !targetKm) return false;
        const d = new Vector3(targetKm[0] - ship.absPosKm.x, targetKm[1] - ship.absPosKm.y, targetKm[2] - ship.absPosKm.z).normalize();
        const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), d);
        ship.quat.copy(q);
        ship.prevQuat.copy(q);
        ship.angVel.set(0, 0, 0);
        return true;
      },
      /** Distance (km) and speed (m/s) to a system-frame point; closing speed > 0 when approaching. */
      nav(target: number[] | RockRef) {
        const ship = getLocalPlayerShip();
        const targetKm = resolveKm(target);
        if (!ship || !targetKm) return null;
        const dx = targetKm[0] - ship.absPosKm.x, dy = targetKm[1] - ship.absPosKm.y, dz = targetKm[2] - ship.absPosKm.z;
        const dist = Math.hypot(dx, dy, dz);
        const v = ship.velKmps;
        return { distKm: dist, speedMps: v.length() * 1000, closingMps: dist > 0 ? ((v.x * dx + v.y * dy + v.z * dz) / dist) * 1000 : 0 };
      },
      /** Dev: own and equip a module without crafting it. */
      equip(itemId: string, slot: string): void {
        store.set(modulesAtom, (m) => ({
          ...m,
          ownedModules: m.ownedModules.includes(itemId) ? m.ownedModules : [...m.ownedModules, itemId],
          equippedModules: { ...m.equippedModules, [slot]: itemId },
        }));
      },
      startMining: (): void => store.set(startMiningAtom),
      mining() {
        const m = store.get(miningStateAtom);
        return { targetId: m.targetedAsteroid?.instanceId ?? null, distM: m.targetedAsteroid?.distanceM ?? null, focused: m.isFocused, mining: m.isMining, progress: m.miningProgress, heat: m.laserHeat, overheated: m.isOverheated };
      },
    },

    /** M3.5 transit: pure scripted runs, the live runtime, the live preview and body positions. */
    transit: {
      simulate: (script: TransitScript) => simulateTransit(script),
      state() {
        const r = transitDriveBuffer;
        return {
          phase: r.phase, speedKmps: r.speedKmps, autopilot: r.autopilot, stopping: r.stopping, legIndex: r.legIndex, legCount: r.legCount,
          legBudgetKg: r.legBudgetKg, legSpentKg: r.legSpentKg, distKm: r.distKm, aimKm: [r.aimX, r.aimY, r.aimZ], totalKg: r.totalKg,
          viaBodyId: r.viaBodyId, ev: { ...r.ev }, target: r.target?.id ?? null, targeted: store.get(targetedPOIAtom)?.id ?? null,
          aimVel: [transitInputs.aimVelX, transitInputs.aimVelY, transitInputs.aimVelZ],
        };
      },
      /** Recompute the live preview now (as TransitTicker does at 4 Hz) and return the full plan. */
      preview() {
        const p = computeTransitPreview(store);
        const q = transitPreviewPlan;
        return p ? { ...p, steps: q.steps, peakKmps: q.peakKmps, endHeat01: q.endHeat01, pathKm: q.pathKm, directKm: q.directKm, idealEtaS: q.idealEtaS, idealFuelKg: q.idealFuelKg } : null;
      },
      /** System-frame body centres and radii, km. */
      bodies: (ids: string[]) =>
        Object.fromEntries(allBodyDefs().filter((b) => ids.includes(b.id)).map((b) => [b.id, { posKm: b.positionKm ? [...b.positionKm] : null, radiusKm: b.radiusKm }])),
      /** Asteroid-field anchors (system km, LIVE positions). */
      fields: (ids: string[]) =>
        Object.fromEntries((store.get(systemConfigAtom).asteroidFields ?? []).filter((f) => ids.includes(f.id)).map((f) => [f.id, { posKm: [...f.anchorKm] }])),
      tap(): void {
        transitDriveBuffer.keyTapped = true;
      },
      /** Record per-frame samples (min distance to bodies, frame, phase) until stop() or `maxFrames`. */
      record(bodyIds: string[], maxFrames = 100000) {
        const bodies = allBodyDefs().filter((b) => bodyIds.includes(b.id) && b.positionKm);
        const rec: TransitRecord = { frames: 0, minDistKm: {}, frameIds: [], phases: [], maxSpeedKmps: 0, maxHeat01: shipRes.heat01, engageStep: -1, endStep: -1, kg0: shipRes.ordinaryKg + shipRes.protectedKg, kgUsed: 0, suspended: [], done: false };
        for (const b of bodies) rec.minDistKm[b.id] = Infinity;
        const hook = () => {
          const p = testProbe.ship.posKm;
          for (const b of bodies) {
            const bp = b.positionKm!;
            const d = Math.hypot(p[0] - bp[0], p[1] - bp[1], p[2] - bp[2]);
            if (d < rec.minDistKm[b.id]) rec.minDistKm[b.id] = d;
          }
          if (rec.frameIds.at(-1) !== testProbe.ship.frameId) rec.frameIds.push(testProbe.ship.frameId);
          const ph = transitDriveBuffer.phase;
          if (rec.phases.at(-1) !== ph) {
            rec.phases.push(ph);
            // Step counts at the phase change (exact to the frame: TransitTicker reads the same buffer).
            if (ph === "spooling" && rec.engageStep < 0) rec.engageStep = testProbe.ship.steps - transitDriveBuffer.spoolSteps;
            if (ph === "idle" && rec.engageStep >= 0 && rec.endStep < 0) rec.endStep = testProbe.ship.steps;
          }
          const sus = nearField.suspended ?? "none";
          if (rec.suspended.at(-1) !== sus) rec.suspended.push(sus);
          if (shipRes.heat01 > rec.maxHeat01) rec.maxHeat01 = shipRes.heat01;
          rec.kgUsed = rec.kg0 - shipRes.ordinaryKg - shipRes.protectedKg;
          if (transitDriveBuffer.speedKmps > rec.maxSpeedKmps) rec.maxSpeedKmps = transitDriveBuffer.speedKmps;
          if (++rec.frames >= maxFrames) stop();
        };
        const stop = () => {
          testProbe.frameHooks.delete(hook);
          rec.done = true;
          return rec;
        };
        testProbe.frameHooks.add(hook);
        transitRecorder = { rec, stop };
        return true;
      },
      recordStop() {
        const r = transitRecorder;
        transitRecorder = null;
        return r ? r.stop() : null;
      },
    },

    fixtures: {
      /** Store raw `data` (any schema; migrated when loaded) as a new fixture world. */
      async create(name: string, data: unknown): Promise<string> {
        const now = Date.now();
        const raw = data as { schemaVersion?: unknown };
        const meta: SaveMeta = {
          id: newWorldId(),
          name: FIXTURE_PREFIX + name,
          seed: 1,
          difficulty: "standard",
          createdAt: now,
          lastPlayedAt: now,
          playTimeS: 0,
          schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1,
        };
        // Raw on purpose: the load path must migrate it, as it would an old record.
        await putWorld(meta, data as SaveData);
        return meta.id;
      },
      list: async (): Promise<{ id: string; name: string }[]> =>
        (await listWorlds()).filter((w) => w.name.startsWith(FIXTURE_PREFIX)).map((w) => ({ id: w.id, name: w.name })),
      /** Boot this world on the next reload. */
      activate: (id: string): void => setLastWorldId(id),
      export: (id: string): Promise<string> => exportWorld(id),
      import: async (json: string): Promise<string> => (await importWorld(json, getLocalPlayerId())).id,
      async remove(id: string): Promise<boolean> {
        const w = (await listWorlds()).find((x) => x.id === id);
        if (!w || !w.name.startsWith(FIXTURE_PREFIX) || getActiveSave()?.meta.id === id) return false;
        await deleteWorld(id);
        return true;
      },
    },
  };
}

export type GameplayHarness = ReturnType<typeof createGameplayHarness>;
