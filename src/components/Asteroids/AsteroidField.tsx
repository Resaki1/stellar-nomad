"use client";

import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useAtomValue, useSetAtom, useStore } from "jotai";

import SimGroup from "@/components/space/SimGroup";
import NearTierBatch from "@/components/Asteroids/NearTierBatch";
import type { NearTierAllocators } from "@/components/Asteroids/NearTierBatch";
import AsteroidImpostors from "@/components/Asteroids/AsteroidImpostors";
import { GpuSlotAllocator } from "@/components/Asteroids/GpuSlotAllocator";
import { MAX_NEAR_INSTANCES } from "@/components/Asteroids/NearTierBatch";

import { systemConfigAtom } from "@/store/system";
import { shipHealthAtom } from "@/store/store";
import { spawnVFXEventAtom } from "@/store/vfx";
import { effectiveShipConfigAtom } from "@/store/shipConfig";
import type { AsteroidFieldDef, SystemConfig } from "@/sim/systemTypes";
import {
  getSystemAsteroidModelDefs,
  resolveFieldGeneration,
  resolveFieldModels,
  resolveFieldRender,
  resolveFieldStreaming,
} from "@/sim/systemTypes";

import type { AsteroidChunkData, ChunkCoord } from "@/sim/asteroids/runtimeTypes";
import { makeChunkKey } from "@/sim/asteroids/runtimeTypes";

import { useAsteroidModelRegistry } from "@/sim/asteroids/modelRegistry";
import { useAsteroidRuntime } from "@/sim/asteroids/runtimeContext";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { prepareFieldShape, distancePointToAabbKm } from "@/sim/asteroids/shapes";

import type {
  AsteroidChunkWorkerWorkerToMainMessage,
  AsteroidChunkWorkerStreamingResultMsg,
} from "@/workers/asteroidChunkWorkerProtocol";

// ─── Tuning constants ───────────────────────────────────────────────
const MAX_CHUNK_OPS_PER_FRAME = 64; // chunk add operations per frame (cheap Map ops, no GPU work)

// Collision
const COLLISION_INTERVAL_S = 0.1;
const SHIP_COLLIDER_RADIUS_M = 60;
const COLLISION_LOG_COOLDOWN_MS = 1000;
const MAX_COLLISION_LOGS_PER_TICK = 3;

// ─── Helpers ────────────────────────────────────────────────────────

/** Inlined point-to-AABB distance for chunk distance checks on main thread. */
function chunkDistKm(
  px: number, py: number, pz: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): number {
  let dx = 0;
  if (px < minX) dx = minX - px;
  else if (px > maxX) dx = px - maxX;
  let dy = 0;
  if (py < minY) dy = minY - py;
  else if (py > maxY) dy = py - maxY;
  let dz = 0;
  if (pz < minZ) dz = minZ - pz;
  else if (pz > maxZ) dz = pz - maxZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ─── FieldLayer ─────────────────────────────────────────────────────

type FieldLayerProps = {
  system: SystemConfig;
  field: AsteroidFieldDef;
  modelRegistry: ReturnType<typeof useAsteroidModelRegistry>;
};

const FieldLayer = memo(function FieldLayer({
  system,
  field,
  modelRegistry,
}: FieldLayerProps) {
  const worldOrigin = useWorldOrigin();
  const asteroidRuntime = useAsteroidRuntime();
  const store = useStore();
  const setShipHealth = useSetAtom(shipHealthAtom);
  const spawnVFX = useSetAtom(spawnVFXEventAtom);

  const renderCfg = useMemo(() => resolveFieldRender(system, field), [system, field]);

  const streamingCfg = useMemo(
    () => resolveFieldStreaming(system, field, renderCfg.drawRadiusKm),
    [system, field, renderCfg.drawRadiusKm]
  );

  const generationCfg = useMemo(
    () => resolveFieldGeneration(system, field),
    [system, field]
  );

  const models = useMemo(() => resolveFieldModels(system, field), [system, field]);
  const shape = useMemo(() => prepareFieldShape(field.shape), [field.shape]);

  const fieldRuntime = useMemo(
    () => asteroidRuntime.getOrCreateFieldRuntime(field.id),
    [asteroidRuntime, field.id]
  );

  // ── Rendering state ─────────────────────────────────────────────
  // Source of truth: Map ref. Both renderers read this directly in useFrame.
  const renderedMapRef = useRef<Map<string, AsteroidChunkData>>(new Map());
  const chunkDistancesKmRef = useRef<Map<string, number>>(new Map());

  // Generation counter: bumped on any renderedMap mutation. Far-tier impostor
  // renderer compares against its prevGen to know when to rebuild its buffer.
  // Near-tier no longer uses this (GPU compute handles it).
  const renderedGenRef = useRef(0);

  // GPU slot allocators: one per model type, created once when modelRegistry is available.
  const allocatorsRef = useRef<NearTierAllocators>(new Map());
  useMemo(() => {
    const allocs = new Map<string, GpuSlotAllocator>();
    modelRegistry.forEach((_asset, id) => {
      allocs.set(id, new GpuSlotAllocator(MAX_NEAR_INSTANCES));
    });
    allocatorsRef.current = allocs;
  }, [modelRegistry]);

  // Incremental add/remove queues for renderedMap.
  const addQueueRef = useRef<string[]>([]);
  const removeQueueRef = useRef<string[]>([]);

  // Worker lifecycle
  const workerRef = useRef<Worker | null>(null);
  const epochRef = useRef(0);
  const wantedKeysRef = useRef<Set<string>>(new Set());

  // Streaming tick throttle: send every 2 frames so the worker's planning
  // sphere tracks the player without consuming too much worker time.
  const tickFrameRef = useRef(0);
  // Previous field-local position for velocity computation (km/s).
  const prevFieldPosRef = useRef({ x: 0, y: 0, z: 0, valid: false });

  // Collision accumulator
  const collisionAccRef = useRef(0);

  // Collision log throttling
  const lastCollisionLogMsRef = useRef<Map<number, number>>(new Map());

  // Listen for chunk mutations from ANY caller (MiningSystem, collisions, etc.).
  // This keeps renderedMapRef in sync when external systems call destroyInstance().
  useEffect(() => {
    const unsubscribe = fieldRuntime.onChunkUpdate((chunkKey, updatedChunk) => {
      if (renderedMapRef.current.has(chunkKey)) {
        renderedMapRef.current.set(chunkKey, updatedChunk);
        renderedGenRef.current++;

        // Re-sync GPU allocators: free old slots, re-allocate with updated data.
        // Free ALL model allocators for this chunk (covers models whose count went to 0).
        allocatorsRef.current.forEach((alloc) => {
          if (alloc.hasChunk(chunkKey)) alloc.freeChunk(chunkKey);
        });
        // Re-allocate with the updated instance data.
        for (const modelId in updatedChunk.instancesByModel) {
          const alloc = allocatorsRef.current.get(modelId);
          if (alloc) {
            alloc.allocateChunk(chunkKey, updatedChunk.originKm, updatedChunk.instancesByModel[modelId]);
          }
        }
      }
    });
    return unsubscribe;
  }, [fieldRuntime]);

  // Collision helper: just delegates to the runtime (listener handles the rest).
  const removeAsteroidInstance = useCallback(
    (instanceId: number) => {
      fieldRuntime.destroyInstance(instanceId);
    },
    [fieldRuntime]
  );

  const applyShipCollisionDamage = useCallback(() => {
    const cfg = store.get(effectiveShipConfigAtom);
    const baseDamage = 10;
    const effectiveDamage = baseDamage * cfg.collisionDamageMult / (cfg.maxHealth / 100);
    const damage = Math.max(1, Math.round(effectiveDamage));
    setShipHealth((prev) => Math.max(0, prev - damage));
  }, [setShipHealth, store]);

  // ── Streaming result handler (called from worker message) ──────
  // Processes the entire result synchronously. This is cheap (<1ms for
  // ~4000 keys): just Map.set for distances + Set construction for wanted.
  const handleStreamingResult = useCallback(
    (msg: AsteroidChunkWorkerStreamingResultMsg) => {
      // 1. Build wanted set (used by "generated" handler to accept chunks).
      const wanted = new Set(msg.wantedKeys);
      wantedKeysRef.current = wanted;
      const rendered = renderedMapRef.current;

      // 2. Prune fieldRuntime: remove chunks that are neither wanted nor
      // rendered. The worker also prunes its generatedKeys to the wanted
      // set, so both sides stay in sync. This bounds runtime size to
      // ~wanted + rendered ≈ 5000–10000 chunks.
      const pruneKeys: string[] = [];
      fieldRuntime.chunks.forEach((_, key) => {
        if (!wanted.has(key) && !rendered.has(key)) {
          pruneKeys.push(key);
        }
      });
      for (let i = 0; i < pruneKeys.length; i++) {
        fieldRuntime.removeChunk(pruneKeys[i]);
      }

      // 3. Update distances for all wanted chunks.
      // Prune stale distance entries first to prevent slow leak from
      // keys that were wanted but never rendered.
      const distances = chunkDistancesKmRef.current;
      distances.forEach((_, key) => {
        if (!wanted.has(key) && !rendered.has(key)) {
          distances.delete(key);
        }
      });
      for (let i = 0; i < msg.wantedKeys.length; i++) {
        distances.set(msg.wantedKeys[i], msg.wantedDists[i]);
      }

      // 4. Queue rendered chunks beyond draw radius for removal.
      for (let i = 0; i < msg.removeRenderKeys.length; i++) {
        if (rendered.has(msg.removeRenderKeys[i])) {
          removeQueueRef.current.push(msg.removeRenderKeys[i]);
        }
      }

      // 5. Queue rendered chunks that aren't wanted at all for removal.
      rendered.forEach((_, key) => {
        if (!wanted.has(key)) {
          removeQueueRef.current.push(key);
        }
      });

      // 6. Rebuild addQueue: wanted chunks in runtime but not yet rendered.
      // Replaces the entire queue (wantedKeys is already distance-sorted by
      // the worker). This prevents unbounded queue growth.
      const freshQueue: string[] = [];
      for (let i = 0; i < msg.wantedKeys.length; i++) {
        const key = msg.wantedKeys[i];
        if (!rendered.has(key) && fieldRuntime.hasChunk(key)) {
          freshQueue.push(key);
        }
      }
      addQueueRef.current = freshQueue;

      // Don't unconditionally bump generation here. Phase A bumps it when
      // actual adds/removes happen. Unconditional bumps were causing ~20Hz
      // matrix rebuilds (32K instances × Matrix4.compose each) even when
      // nothing changed → 30ms CPU spikes.
    },
    [fieldRuntime]
  );

  // ── Worker lifecycle ────────────────────────────────────────────

  useEffect(() => {
    fieldRuntime.clear();
    renderedMapRef.current.clear();
    chunkDistancesKmRef.current.clear();
    addQueueRef.current.length = 0;
    removeQueueRef.current.length = 0;
    renderedGenRef.current++;
    allocatorsRef.current.forEach((alloc) => alloc.clear());

    epochRef.current += 1;
    const epoch = epochRef.current;

    const w = new Worker(
      new URL("../../workers/asteroidChunkWorker.ts", import.meta.url),
      { type: "module" }
    );
    workerRef.current = w;

    const onMessage = (ev: MessageEvent<AsteroidChunkWorkerWorkerToMainMessage>) => {
      const msg = ev.data;

      if (msg.type === "error") {
        // eslint-disable-next-line no-console
        console.error("[AsteroidChunkWorker]", msg.message, msg.stack);
        return;
      }

      if (msg.fieldId !== field.id) return;
      if (msg.epoch !== epochRef.current) return;

      if (msg.type === "generated") {
        const chunk = msg.chunk;

        // Only accept chunks that are still wanted. The worker prunes its
        // generatedKeys to match the wanted set each tick, so any rejected
        // chunk here will be re-generated when it becomes wanted again.
        if (!wantedKeysRef.current.has(chunk.key)) return;

        fieldRuntime.upsertChunk(chunk);
        addQueueRef.current.push(chunk.key);
        return;
      }

      if (msg.type === "streamingResult") {
        handleStreamingResult(msg);
        return;
      }
    };

    const onError = (ev: ErrorEvent) => {
      // eslint-disable-next-line no-console
      console.error("[AsteroidChunkWorker] error event", ev.message);
    };

    const onMessageError = () => {
      // eslint-disable-next-line no-console
      console.error("[AsteroidChunkWorker] messageerror");
    };

    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    w.addEventListener("messageerror", onMessageError);

    w.postMessage({
      type: "init",
      fieldId: field.id,
      field,
      models,
      chunkSizeKm: streamingCfg.chunkSizeKm,
      maxAsteroidsPerChunk: generationCfg.maxAsteroidsPerChunk,
      epoch,
      streaming: {
        loadRadiusKm: streamingCfg.loadRadiusKm,
        maxActiveChunks: streamingCfg.maxActiveChunks,
        drawRadiusKm: renderCfg.drawRadiusKm,
      },
    });

    return () => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      w.removeEventListener("messageerror", onMessageError);
      w.terminate();

      workerRef.current = null;
      wantedKeysRef.current.clear();
      prevFieldPosRef.current.valid = false;
      tickFrameRef.current = 0;
      fieldRuntime.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    field,
    field.id,
    fieldRuntime,
    handleStreamingResult,
    models,
    streamingCfg.chunkSizeKm,
    streamingCfg.loadRadiusKm,
    streamingCfg.maxActiveChunks,
    renderCfg.drawRadiusKm,
    generationCfg.maxAsteroidsPerChunk,
  ]);

  useEffect(() => {
    return () => {
      fieldRuntime.clear();
    };
  }, [asteroidRuntime, field.id, fieldRuntime]);

  // ── Frame loop ──────────────────────────────────────────────────

  useFrame((_state, delta) => {
    collisionAccRef.current += delta;

    const ship = worldOrigin.shipPosKm;
    const px = ship.x - field.anchorKm[0];
    const py = ship.y - field.anchorKm[1];
    const pz = ship.z - field.anchorKm[2];

    // If far away, hard-clear.
    const distToFieldKm = shape.distanceToKm(px, py, pz);
    if (distToFieldKm > streamingCfg.unloadRadiusKm) {
      if (fieldRuntime.chunks.size > 0) fieldRuntime.clear();

      if (renderedMapRef.current.size > 0) {
        renderedMapRef.current.clear();
        chunkDistancesKmRef.current.clear();
        addQueueRef.current.length = 0;
        removeQueueRef.current.length = 0;
        renderedGenRef.current++;
        // Clear all GPU slot allocators.
        allocatorsRef.current.forEach((alloc) => alloc.clear());
      }

      epochRef.current += 1;
      wantedKeysRef.current.clear();
      prevFieldPosRef.current.valid = false;
      tickFrameRef.current = 0;

      const w = workerRef.current;
      if (w) {
        w.postMessage({
          type: "setEpoch",
          fieldId: field.id,
          epoch: epochRef.current,
        });
      }
      return;
    }

    // ── Phase A: Apply queued chunk adds/removes + GPU sync. ──
    {
      const rendered = renderedMapRef.current;
      let changed = false;

      // 0. Sync GPU allocations with current ship position.
      // Runs every frame so near/far transitions happen immediately,
      // independent of streaming result timing. For ~5000 rendered
      // chunks this is ~0.15ms (AABB distance + Map lookup per chunk).
      const nearR = renderCfg.nearRadiusKm;
      rendered.forEach((chunk, key) => {
        const d = chunkDistKm(
          px, py, pz,
          chunk.aabbMinKm[0], chunk.aabbMinKm[1], chunk.aabbMinKm[2],
          chunk.aabbMaxKm[0], chunk.aabbMaxKm[1], chunk.aabbMaxKm[2],
        );
        chunkDistancesKmRef.current.set(key, d);

        if (d > nearR) {
          // Beyond near radius — free GPU slots if allocated.
          allocatorsRef.current.forEach((alloc) => {
            if (alloc.hasChunk(key)) {
              alloc.freeChunk(key);
              changed = true;
            }
          });
        } else {
          // Within near radius — allocate GPU slots if missing
          // (handles far→near transitions for existing rendered chunks).
          for (const modelId in chunk.instancesByModel) {
            const alloc = allocatorsRef.current.get(modelId);
            if (alloc && !alloc.hasChunk(key)) {
              if (alloc.allocateChunk(key, chunk.originKm, chunk.instancesByModel[modelId])) {
                changed = true;
              }
            }
          }
        }
      });

      // 1. Removes — drain entire queue (Map.delete is O(1)).
      const removeQueue = removeQueueRef.current;
      while (removeQueue.length > 0) {
        const key = removeQueue.pop()!;
        const removedChunk = rendered.get(key);
        if (removedChunk && rendered.delete(key)) {
          chunkDistancesKmRef.current.delete(key);
          // Free GPU slots for each model in the removed chunk.
          for (const modelId in removedChunk.instancesByModel) {
            allocatorsRef.current.get(modelId)?.freeChunk(key);
          }
          changed = true;
        }
      }

      // 2. Adds — budgeted. Retain entries that aren't ready yet (not
      // yet generated, or GPU capacity full) so they're retried next frame
      // instead of waiting for the next streaming result to rebuild the queue.
      {
        let addBudget = MAX_CHUNK_OPS_PER_FRAME;
        const addQueue = addQueueRef.current;
        const retainQueue: string[] = [];

        for (let i = 0; i < addQueue.length; i++) {
          const key = addQueue[i];

          if (rendered.has(key)) continue; // already rendered, drop

          if (addBudget <= 0) {
            retainQueue.push(key); // over budget, keep for next frame
            continue;
          }

          const chunk = fieldRuntime.getChunk(key);
          if (!chunk) {
            retainQueue.push(key); // not yet generated, retry later
            continue;
          }

          const d = chunkDistKm(
            px, py, pz,
            chunk.aabbMinKm[0], chunk.aabbMinKm[1], chunk.aabbMinKm[2],
            chunk.aabbMaxKm[0], chunk.aabbMaxKm[1], chunk.aabbMaxKm[2],
          );
          if (d > renderCfg.drawRadiusKm) continue; // out of range, drop

          // Allocate GPU slots for each model. If any model can't fit,
          // keep the chunk for retry when slots free up.
          let gpuOk = true;
          if (d <= renderCfg.nearRadiusKm) {
            for (const modelId in chunk.instancesByModel) {
              const alloc = allocatorsRef.current.get(modelId);
              if (alloc && !alloc.allocateChunk(key, chunk.originKm, chunk.instancesByModel[modelId])) {
                allocatorsRef.current.forEach((a) => { if (a.hasChunk(key)) a.freeChunk(key); });
                gpuOk = false;
                break;
              }
            }
          }
          if (!gpuOk) {
            retainQueue.push(key); // retry when slots free up
            continue;
          }

          rendered.set(key, chunk);
          chunkDistancesKmRef.current.set(key, d);
          changed = true;
          addBudget--;
        }

        addQueueRef.current = retainQueue;
      }

      // Bump generation once if anything changed (batched).
      if (changed) {
        renderedGenRef.current++;
      }
    }

    // ── Phase B: Dispatch streaming tick to worker (throttled) ────────
    // Compute velocity every frame (for accurate look-ahead on tick frames).
    const prev = prevFieldPosRef.current;
    let vx = 0, vy = 0, vz = 0;
    if (prev.valid && delta > 0) {
      vx = (px - prev.x) / delta;
      vy = (py - prev.y) / delta;
      vz = (pz - prev.z) / delta;
    }
    prev.x = px;
    prev.y = py;
    prev.z = pz;
    prev.valid = true;

    // Send a tick every 2 frames. Velocity enables Minecraft-style
    // generation look-ahead: chunks in the direction of travel are
    // generated before the player reaches them, reducing pop-in.
    tickFrameRef.current++;
    if (tickFrameRef.current >= 2) {
      tickFrameRef.current = 0;
      const w = workerRef.current;
      if (w) {
        w.postMessage({
          type: "streamingTick",
          fieldId: field.id,
          epoch: epochRef.current,
          px, py, pz,
          vx, vy, vz,
        });
      }
    }

    // ── Phase C: Collision checks ───────────────────────────────────
    if (collisionAccRef.current >= COLLISION_INTERVAL_S) {
      collisionAccRef.current = 0;

      const shipRadiusM = SHIP_COLLIDER_RADIUS_M;
      const shipRadiusKm = shipRadiusM / 1000;
      const chunkSizeKm = streamingCfg.chunkSizeKm;

      const shipCx = Math.floor(px / chunkSizeKm);
      const shipCy = Math.floor(py / chunkSizeKm);
      const shipCz = Math.floor(pz / chunkSizeKm);

      const nowMs = performance.now();
      const lastLog = lastCollisionLogMsRef.current;
      if (lastLog.size > 20_000) lastLog.clear();

      let logsThisTick = 0;

      for (let ox = -1; ox <= 1 && logsThisTick < MAX_COLLISION_LOGS_PER_TICK; ox++) {
        for (let oy = -1; oy <= 1 && logsThisTick < MAX_COLLISION_LOGS_PER_TICK; oy++) {
          for (let oz = -1; oz <= 1 && logsThisTick < MAX_COLLISION_LOGS_PER_TICK; oz++) {
            const coord: ChunkCoord = { x: shipCx + ox, y: shipCy + oy, z: shipCz + oz };
            const key = makeChunkKey(field.id, coord);

            const chunk = fieldRuntime.getChunk(key);
            if (!chunk) continue;

            const aabbDistKm = distancePointToAabbKm(
              px, py, pz,
              chunk.aabbMinKm[0], chunk.aabbMinKm[1], chunk.aabbMinKm[2],
              chunk.aabbMaxKm[0], chunk.aabbMaxKm[1], chunk.aabbMaxKm[2],
            );

            const chunkInflationKm = shipRadiusKm + chunk.maxRadiusM / 1000;
            if (aabbDistKm > chunkInflationKm) continue;

            const sxM = (px - chunk.originKm[0]) * 1000;
            const syM = (py - chunk.originKm[1]) * 1000;
            const szM = (pz - chunk.originKm[2]) * 1000;

            const byModel = chunk.instancesByModel;

            for (const modelId in byModel) {
              const inst = byModel[modelId];
              const positions = inst.positionsM;
              const radii = inst.radiiM;
              const ids = inst.instanceIds;
              const count = inst.count;

              for (let i = 0; i < count; i++) {
                const pIndex = i * 3;
                const dx = positions[pIndex] - sxM;
                const dy = positions[pIndex + 1] - syM;
                const dz = positions[pIndex + 2] - szM;

                const r = radii[i] + shipRadiusM;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 > r * r) continue;

                const instanceId = ids[i] >>> 0;
                const prevMs = lastLog.get(instanceId);
                if (prevMs !== undefined && nowMs - prevMs < COLLISION_LOG_COOLDOWN_MS) continue;
                lastLog.set(instanceId, nowMs);

                const chunkOriginLocalX =
                  (field.anchorKm[0] + chunk.originKm[0] - worldOrigin.worldOriginKm.x) * 1000;
                const chunkOriginLocalY =
                  (field.anchorKm[1] + chunk.originKm[1] - worldOrigin.worldOriginKm.y) * 1000;
                const chunkOriginLocalZ =
                  (field.anchorKm[2] + chunk.originKm[2] - worldOrigin.worldOriginKm.z) * 1000;

                const asteroidLocalX = chunkOriginLocalX + positions[pIndex];
                const asteroidLocalY = chunkOriginLocalY + positions[pIndex + 1];
                const asteroidLocalZ = chunkOriginLocalZ + positions[pIndex + 2];

                const shipLocalX = (ship.x - worldOrigin.worldOriginKm.x) * 1000;
                const shipLocalY = (ship.y - worldOrigin.worldOriginKm.y) * 1000;
                const shipLocalZ = (ship.z - worldOrigin.worldOriginKm.z) * 1000;

                const idX = shipLocalX - asteroidLocalX;
                const idY = shipLocalY - asteroidLocalY;
                const idZ = shipLocalZ - asteroidLocalZ;
                const idLen = Math.sqrt(idX * idX + idY * idY + idZ * idZ);
                const impactDir: [number, number, number] =
                  idLen > 0.01
                    ? [idX / idLen, idY / idLen, idZ / idLen]
                    : [0, 1, 0];

                removeAsteroidInstance(instanceId);
                applyShipCollisionDamage();

                spawnVFX({
                  type: "collision",
                  position: [asteroidLocalX, asteroidLocalY, asteroidLocalZ],
                  radiusM: radii[i],
                  impactDirection: impactDir,
                });

                logsThisTick++;
                if (logsThisTick >= MAX_COLLISION_LOGS_PER_TICK) break;
              }
              if (logsThisTick >= MAX_COLLISION_LOGS_PER_TICK) break;
            }
          }
        }
      }
    }
  });

  // ── Render ──────────────────────────────────────────────────────

  return (
    <SimGroup space="local" positionKm={field.anchorKm}>
      {/* Near tier: GPU-driven indirect draw. Compute shader culls + compacts
         visible instances, drawIndexedIndirect skips invisible ones entirely. */}
      <NearTierBatch
        nearRadiusKm={renderCfg.nearRadiusKm}
        modelRegistry={modelRegistry}
        allocatorsRef={allocatorsRef}
      />

      {/* Far tier: billboard impostors (single batched draw call).
         Config guard only — stays mounted when chunks temporarily empty. */}
      {renderCfg.farRadiusKm > 0 && (
        <AsteroidImpostors
          renderedMapRef={renderedMapRef}
          chunkDistancesRef={chunkDistancesKmRef}
          renderedGenRef={renderedGenRef}
          nearRadiusKm={renderCfg.nearRadiusKm}
          farRadiusKm={renderCfg.farRadiusKm}
          fadeOutKm={renderCfg.crossFadeKm}
        />
      )}
    </SimGroup>
  );
});

FieldLayer.displayName = "FieldLayer";

// ─── AsteroidField ──────────────────────────────────────────────────

function AsteroidField() {
  const system = useAtomValue(systemConfigAtom);
  const modelDefs = useMemo(() => getSystemAsteroidModelDefs(system), [system]);
  const modelRegistry = useAsteroidModelRegistry(modelDefs);

  const enabledFields = useMemo(
    () => (system.asteroidFields ?? []).filter((f) => f.enabled !== false),
    [system]
  );

  if (!enabledFields.length) return null;

  return (
    <>
      {enabledFields.map((field) => (
        <FieldLayer key={field.id} system={system} field={field} modelRegistry={modelRegistry} />
      ))}
    </>
  );
}

export default memo(AsteroidField);
