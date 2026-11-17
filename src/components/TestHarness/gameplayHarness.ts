/**
 * `__test.gameplay` — M3 domain-operation hooks for scripts/drive-examples/gameplay-check.mjs.
 * Fixture worlds are named with FIXTURE_PREFIX; `fixtures.remove` deletes nothing else.
 */
import type { createStore } from "jotai";
import { getActiveSave, sampleCollectors } from "@/save/activeSave";
import { getLocalPlayerId, setLastWorldId } from "@/save/playerId";
import { deleteWorld, exportWorld, importWorld, listWorlds, newWorldId, putWorld } from "@/save/saveDb";
import type { DiscoveryState, ModulesState, ReplicationPoint, SaveData, SaveMeta } from "@/save/types";
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
import { bookmarksAtom, discoveriesMirrorAtom, sharedResearchMirrorAtom, unlockResearchAtom } from "@/store/research";
import { RESEARCH_NODES, getResearchNode } from "@/data/content";
import { DEFAULT_CARGO_CAPACITY_UNITS, SCHEMA_VERSION, defaultSaveData, defaultShipConfig } from "@/save/defaults";
import { auditContent, evaluateNode } from "@/sim/research/requirements";
import { buildInspectOperation } from "@/sim/asteroids/inspectOperation";
import { aggregateEffects, applyModifiers } from "@/sim/ship/loadout";
import { computeLoadoutPreview } from "@/sim/ship/loadoutPreview";
import { getItemDef, type ItemEffect } from "@/data/content";
import { inspectControl, startInspectionAtom } from "@/store/mining";
import { getShipTuning } from "@/store/shipResources";
import { loadoutPreviewAtom, setDestinationToSourceAtom } from "@/store/discoveries";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import { shipHealthAtom } from "@/store/store";
import { systemConfigAtom } from "@/store/system";
import { runOperation } from "@/store/operations";
import { testProbe } from "./testProbe";
import { createM37Harness } from "./m37Harness";
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
import { poiBuffer } from "@/store/poi";
import { probeClearance, absoluteKm, type Obstruction } from "@/sim/replication/clearance";
import { checkPlacement, resolveRecovery, type PlacementCheck } from "@/sim/replication/placement";
import { REPLICATION_TUNING, emergencePose, starterPoint } from "@/sim/replication/points";
import { repositionState } from "@/sim/ship/reposition";
import { isSimPaused } from "@/sim/simPause";
import {
  activatePointAtom,
  deactivatePointAtom,
  lastRecoveryAtom,
  nearbyPointAtom,
  placePointAtom,
  placementModeAtom,
  placementPreview,
  placementStatusAtom,
  playerReplicationAtom,
  recoverAtom,
  replicationPointsAtom,
  updateNearbyPoint,
  updatePlacementPreview,
} from "@/store/replication";
import { lastLossAtom } from "@/store/death";
import { cameraShakeIntensityAtom } from "@/store/vfx";
import { playerInput } from "@/input/playerInput";
import { mouseState } from "@/input/mouse";
import { activeTimedEffectsAtom } from "@/store/timedEffects";

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
      discoveries: store.get(discoveriesMirrorAtom),
      bookmarks: store.get(bookmarksAtom),
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
        { miningEfficiencyMult: cfg.miningEfficiencyMult },
        opId ?? newOpId(),
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
                const reward = getAsteroidMiningReward(system, f.id, id, radiusM, chunkKey);
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

    /** M3.3/M3.4: discovery research, content audit, loadout preview. */
    m37: createM37Harness(store),

    m33: {
      audit: () => auditContent(DEFAULT_CARGO_CAPACITY_UNITS),
      nodeIds: (): string[] => RESEARCH_NODES.map((n) => n.id),
      node: (id: string) => getResearchNode(id) ?? null,
      /** Pure evaluation against the live world record. */
      evaluate(id: string) {
        const n = getResearchNode(id);
        const w = getActiveSave()?.data.world;
        if (!n || !w) return null;
        return evaluateNode(n, { discoveries: w.discoveries, completed: new Set(w.research.completedNodes) });
      },
      /** Loaded rocks nearest the ship with class and composition (the scanner's view). */
      rocks(n = 20, classId?: string, minRadiusM = 0) {
        const rt = getActiveAsteroidRuntime();
        const system = store.get(systemConfigAtom);
        const ship = testProbe.ship.posKm;
        const out: { fieldId: string; chunkKey: string; instanceId: number; radiusM: number; classId: string; composition: Record<string, number>; distKm: number; mineS: number }[] = [];
        const speedMult = store.get(effectiveShipConfigAtom).miningSpeedMult;
        for (const f of system.asteroidFields ?? []) {
          const fr = rt?.getFieldRuntime(f.id);
          if (!fr) continue;
          fr.chunks.forEach((chunk, chunkKey) => {
            for (const modelId in chunk.instancesByModel) {
              const inst = chunk.instancesByModel[modelId];
              for (let i = 0; i < inst.count; i++) {
                const radiusM = inst.radiiM[i];
                if (radiusM < minRadiusM) continue;
                const id = inst.instanceIds[i] >>> 0;
                const reward = getAsteroidMiningReward(system, f.id, id, radiusM, chunkKey);
                if (!reward || (classId && reward.asteroidClass.id !== classId)) continue;
                const x = f.anchorKm[0] + chunk.originKm[0] + inst.positionsM[i * 3] / 1000;
                const y = f.anchorKm[1] + chunk.originKm[1] + inst.positionsM[i * 3 + 1] / 1000;
                const z = f.anchorKm[2] + chunk.originKm[2] + inst.positionsM[i * 3 + 2] / 1000;
                const composition: Record<string, number> = {};
                for (const r of reward.resources) composition[r.resourceId] = r.amount;
                out.push({ fieldId: f.id, chunkKey, instanceId: id, radiusM, classId: reward.asteroidClass.id, composition, distKm: Math.hypot(x - ship[0], y - ship[1], z - ship[2]), mineS: computeMiningDurationS(radiusM) / speedMult });
              }
            }
          });
        }
        out.sort((a, b) => a.distKm - b.distKm);
        return out.slice(0, n);
      },
      /** The scanner's inspection claim for a loaded rock, submitted as the local player (range not checked). */
      inspect(t: RockRef & { radiusM?: number }, opId?: string): OperationOutcome | { status: "missing" } {
        const chunk = getActiveAsteroidRuntime()?.getFieldRuntime(t.fieldId)?.getChunk(t.chunkKey);
        if (!chunk) return { status: "missing" };
        for (const modelId in chunk.instancesByModel) {
          const inst = chunk.instancesByModel[modelId];
          for (let i = 0; i < inst.count; i++) {
            if (inst.instanceIds[i] >>> 0 !== t.instanceId >>> 0) continue;
            const op = buildInspectOperation(
              store.get(systemConfigAtom),
              { fieldId: t.fieldId, chunkKey: t.chunkKey, instanceId: t.instanceId, radiusM: inst.radiiM[i], chunkOriginKm: chunk.originKm, localM: [inst.positionsM[i * 3], inst.positionsM[i * 3 + 1], inst.positionsM[i * 3 + 2]] },
              opId ?? newOpId(),
            );
            return op ? runOperation(op) : { status: "missing" };
          }
        }
        return { status: "missing" };
      },
      /** Teleport `offsetKm` from a rock along +x (system frame). */
      approach(t: RockRef, offsetKm = 0.6): boolean {
        const p = resolveKm(t);
        if (!p) return false;
        store.set(devTeleportAtom, { positionKm: [p[0] + offsetKm, p[1], p[2]] });
        return true;
      },
      /** The research panel's unlock action. */
      unlock(nodeId: string): OperationOutcome | null {
        const out: { o: OperationOutcome | null } = { o: null };
        store.set(unlockResearchAtom, { nodeId, onSettled: (o) => (out.o = o) });
        return out.o;
      },
      /** Pure preview for an equipped id list (gate d) and the live one the loadout panel shows. */
      preview(equipped: string[]) {
        const effects: ItemEffect[] = [];
        for (const id of equipped) effects.push(...(getItemDef(id)?.effects ?? []));
        const cfg = applyModifiers(defaultShipConfig(), aggregateEffects(effects));
        return { ...computeLoadoutPreview(cfg, getResourceTuning(), DEFAULT_CARGO_CAPACITY_UNITS), cfg };
      },
      livePreview: () => store.get(loadoutPreviewAtom),
      /** Dev: own and equip exactly these modules (each in its own slot), nothing else equipped. */
      setLoadout(ids: string[]): void {
        store.set(modulesAtom, (m) => {
          const equippedModules: ModulesState["equippedModules"] = {};
          for (const id of ids) {
            const def = getItemDef(id);
            if (def?.type === "module") equippedModules[def.slot] = id;
          }
          return { ...m, ownedModules: Array.from(new Set([...m.ownedModules, ...ids])), equippedModules };
        });
      },
      liveTuning: (): ResourceTuning => ({ ...getShipTuning() }),
      /** The loadout panel's path: equip (or `null` empty) a slot through the authority. */
      equipOp: (itemId: string | null, slot: string): OperationOutcome => runOperation({ type: "module.equip", opId: newOpId(), slot, itemId }),
      /** UI path: start a close inspection on the locked rock. */
      startInspection: (): boolean => store.set(startInspectionAtom),
      inspection: () => ({ ...inspectControl, progressUi: store.get(miningStateAtom).inspectProgress }),
      /** Discoveries list action: make a recorded source the transit destination. */
      setDestination: (sourceId: string): boolean => store.set(setDestinationToSourceAtom, sourceId),
      bookmark: (sourceId: string, name: string | null): OperationOutcome => runOperation({ type: "bookmark.set", opId: newOpId(), sourceId, name }),
      /** Test setup only: overwrite the active (fixture) world's findings and unlocked options. */
      devSetWorld(p: { discoveries?: DiscoveryState; completedNodes?: string[] }): void {
        const w = getActiveSave()?.data.world;
        if (!w) return;
        // Through the sanitiser, so an older-schema fixture shape gains the newer slices.
        if (p.discoveries) w.discoveries = parseSaveData({ schemaVersion: SCHEMA_VERSION, world: { discoveries: structuredClone(p.discoveries) }, players: {} }).world.discoveries;
        if (p.completedNodes) w.research = { completedNodes: [...p.completedNodes], legacy: w.research.legacy };
        store.set(discoveriesMirrorAtom, w.discoveries);
        store.set(sharedResearchMirrorAtom, w.research.completedNodes);
      },
      /** Target a body as gaze-locking it would (transit preview / destination). */
      targetBody(bodyId: string): boolean {
        const b = allBodyDefs().find((x) => x.id === bodyId);
        if (!b?.positionKm) return false;
        store.set(targetedPOIAtom, { id: `body:${b.id}`, name: b.name, positionKm: b.positionKm, arrivalOffsetKm: Math.max(100, b.radiusKm * 2) });
        return true;
      },
      /** Starter-belt hydrate economics over the loaded chunks within `radiusKm` of the ship. */
      fuelStats(radiusKm = 25) {
        const t = getResourceTuning();
        const rocks = this.rocks(1e6).filter((r) => r.distKm <= radiusKm);
        const hyd = rocks.map((r) => r.composition.hydrates ?? 0);
        const c = rocks.filter((r) => r.classId === "c_type");
        const cHyd = c.map((r) => r.composition.hydrates ?? 0).sort((a, b) => a - b);
        const coldC = c.filter((r) => r.mineS < 14).map((r) => r.composition.hydrates ?? 0).sort((a, b) => b - a);
        const unitsPerTank = t.tankKg / t.processingKgPerUnit;
        let need = unitsPerTank;
        let best = 0;
        for (const h of coldC) {
          if (need <= 0) break;
          need -= h;
          best++;
        }
        const mean = (xs: number[]) => (xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : 0);
        return {
          rocks: rocks.length, cType: c.length, unitsPerTank, kgPerUnit: t.processingKgPerUnit,
          meanHydratesAll: mean(hyd), meanHydratesC: mean(cHyd), medianHydratesC: cHyd[Math.floor(cHyd.length / 2)] ?? 0,
          rocksPerTankMeanC: mean(cHyd) > 0 ? unitsPerTank / mean(cHyd) : null, rocksPerTankBestColdC: need <= 0 ? best : null,
        };
      },
    },

    /** M3.6 replication points and recovery. */
    rep: {
      tuning: () => ({ ...REPLICATION_TUNING }),
      starter: () => starterPoint(),
      points: () => structuredClone(store.get(replicationPointsAtom)),
      activeId: (): string => store.get(playerReplicationAtom).activeId,
      /** The preview's check at a frame-relative pose, from the local ship (pure). */
      check(frameId: string, positionKm: number[], quaternion: number[], kits?: number): PlacementCheck {
        const ship = getLocalPlayerShip();
        worldAuthority.world();
        const out: PlacementCheck = { refusal: null, bodyAltKm: 0, bodyId: null, rockClearM: 0 };
        return checkPlacement({ frameId, positionKm, quaternion }, ship ? { frameId: ship.frameId, positionKm: [ship.posKm.x, ship.posKm.y, ship.posKm.z] } : null, kits ?? 1, worldAuthority.asteroids, out);
      },
      probe(frameId: string, positionKm: number[], searchM = 2000): Obstruction {
        worldAuthority.world();
        return probeClearance(frameId, positionKm, searchM, worldAuthority.asteroids, { bodyAltKm: 0, bodyId: null, rockClearM: 0 });
      },
      emergence: (positionKm: [number, number, number], quaternion: [number, number, number, number], i = 0) => emergencePose({ positionKm, quaternion }, i),
      abs: (frameId: string, positionKm: number[]): number[] => absoluteKm(frameId, positionKm, new Vector3()).toArray(),
      /** Ship pose now: frame, relative km, quaternion. */
      ship() {
        const sh = getLocalPlayerShip();
        return sh ? { frameId: sh.frameId, posKm: sh.posKm.toArray(), absKm: sh.absPosKm.toArray(), quat: sh.quat.toArray(), velKmps: sh.velKmps.toArray(), angVel: sh.angVel.toArray() } : null;
      },
      /** Dev warp to a frame-relative pose (resolved at the current ephemeris instant). */
      teleportRel(frameId: string, positionKm: number[], quaternion?: [number, number, number, number]): void {
        const a = absoluteKm(frameId, positionKm, new Vector3());
        store.set(devTeleportAtom, { positionKm: [a.x, a.y, a.z], quaternion });
      },
      /** UI path: open/close the preview, refresh its check now, place with a name. */
      setMode: (on: boolean): void => store.set(placementModeAtom, on),
      preview() {
        updatePlacementPreview(store);
        return { ...structuredClone({ frameId: placementPreview.frameId, positionKm: placementPreview.positionKm, quaternion: placementPreview.quaternion, emergenceKm: placementPreview.emergenceKm, valid: placementPreview.valid, check: placementPreview.check }), status: store.get(placementStatusAtom) };
      },
      place: (name: string, opId?: string): OperationOutcome => store.set(placePointAtom, { name, opId }),
      nearby() {
        updateNearbyPoint(store);
        return store.get(nearbyPointAtom);
      },
      activate: (pointId: string): OperationOutcome => store.set(activatePointAtom, pointId),
      deactivate: (): OperationOutcome => store.set(deactivatePointAtom),
      /** Where the authority would recover the local player now (pure). */
      resolve(mode: "active" | "starter") {
        worldAuthority.world();
        const p = getActiveSave()?.data.players[getLocalPlayerId()];
        return resolveRecovery(getActiveSave()?.data.world.replication.points ?? [], p?.replication.activeId ?? "starter", mode, worldAuthority.asteroids);
      },
      /** Loaded rocks nearest the ship, with their anchor-frame pose (fields ride their body). */
      rocks(n = 20) {
        const rt = getActiveAsteroidRuntime();
        const system = store.get(systemConfigAtom);
        const ship = testProbe.ship.posKm;
        const out: { fieldId: string; chunkKey: string; instanceId: number; radiusM: number; frameId: string; posKm: number[]; distKm: number }[] = [];
        for (const f of system.asteroidFields ?? []) {
          const fr = rt?.getFieldRuntime(f.id);
          const frameId = f.anchorBody;
          if (!fr || !frameId || !f.anchorOffsetKm) continue;
          const off = f.anchorOffsetKm;
          fr.chunks.forEach((chunk, chunkKey) => {
            for (const modelId in chunk.instancesByModel) {
              const inst = chunk.instancesByModel[modelId];
              for (let i = 0; i < inst.count; i++) {
                const rel = [0, 1, 2].map((k) => off[k] + chunk.originKm[k] + inst.positionsM[i * 3 + k] / 1000);
                const abs = [0, 1, 2].map((k) => f.anchorKm[k] + chunk.originKm[k] + inst.positionsM[i * 3 + k] / 1000);
                out.push({ fieldId: f.id, chunkKey, instanceId: inst.instanceIds[i] >>> 0, radiusM: inst.radiiM[i], frameId, posKm: rel, distKm: Math.hypot(abs[0] - ship[0], abs[1] - ship[1], abs[2] - ship[2]) });
              }
            }
          });
        }
        out.sort((a, b) => a.distKm - b.distKm);
        return out.slice(0, n);
      },
      /** Test setup only (fixture worlds): add/replace a point record, set a player's selection or ship pose. */
      devSetPoint(point: ReplicationPoint): void {
        const w = getActiveSave()?.data.world;
        if (!w) return;
        w.replication.points = [...w.replication.points.filter((x) => x.id !== point.id), structuredClone(point)];
        store.set(replicationPointsAtom, w.replication.points);
      },
      devSetActive(activeId: string, playerId?: string): void {
        const p = getActiveSave()?.data.players[playerId ?? getLocalPlayerId()];
        if (!p) return;
        p.replication = { activeId };
        if (!playerId || playerId === getLocalPlayerId()) store.set(playerReplicationAtom, { activeId });
      },
      devSetPlayerShip(playerId: string, pose: { frameId: string; positionKm: [number, number, number]; quaternion: [number, number, number, number] }): void {
        const p = getActiveSave()?.data.players[playerId];
        if (p) p.ship = structuredClone(pose);
      },
      /** Projected POI markers (id, name) the HUD shows now. */
      pois: (prefix = "") => poiBuffer.pois.filter((p) => p.id.startsWith(prefix)).map((p) => ({ id: p.id, name: p.name, distanceKm: p.distanceKm })),
      /** The death screen's recover action. */
      recover: (mode: "active" | "starter"): OperationOutcome => store.set(recoverAtom, mode),
      lastRecovery: () => store.get(lastRecoveryAtom),
      lastLoss: () => store.get(lastLossAtom),
      /** Reposition / arrival-gate state and the reset-relevant runtime buffers. */
      runtime() {
        const sh = getLocalPlayerShip();
        return {
          applied: repositionState.applied, pending: repositionState.pending !== null, arriving: repositionState.arrivalSince > 0, lastArrivalMs: repositionState.lastArrivalMs,
          paused: isSimPaused(), shake: store.get(cameraShakeIntensityAtom), throttle: playerInput.throttle, mouseYaw: playerInput.mouseYaw, mousePitch: playerInput.mousePitch,
          stickX: mouseState.stickX, stickY: mouseState.stickY, transitPhase: transitDriveBuffer.phase, transitSpeed: transitDriveBuffer.speedKmps,
          speedMps: sh ? sh.velKmps.length() * 1000 : null, angVel: sh ? sh.angVel.length() : null, timedEffects: store.get(activeTimedEffectsAtom).length,
          nearField: { ...nearField.counters, suspended: nearField.suspended, owner: nearField.lastOwner },
        };
      },
    },

    fixtures: {
      /** Store raw `data` (any schema; migrated when loaded) as a new fixture world; "new" = createWorld's data. */
      async create(name: string, data: unknown, opts?: { seed?: number; difficulty?: SaveMeta["difficulty"] }): Promise<string> {
        const now = Date.now();
        if (data === "new") data = defaultSaveData(getLocalPlayerId(), opts?.difficulty ?? "standard");
        const raw = data as { schemaVersion?: unknown };
        const meta: SaveMeta = {
          id: newWorldId(),
          name: FIXTURE_PREFIX + name,
          seed: (opts?.seed ?? 1) >>> 0,
          difficulty: opts?.difficulty ?? "standard",
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
