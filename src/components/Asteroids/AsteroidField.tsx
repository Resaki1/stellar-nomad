"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { useAtomValue, useSetAtom, useStore } from "jotai";

import SimGroup from "@/components/space/SimGroup";
import NearTierBatch from "@/components/Asteroids/NearTierBatch";
import AsteroidImpostors from "@/components/Asteroids/AsteroidImpostors";

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
const MAX_CHUNK_MOUNTS_PER_FRAME = 3; // near-tier React mounts per frame
const FAR_TIER_UPDATE_FRAMES = 6; // update far impostor list every N frames
/** Max streaming-result items (unloads + distance updates + remove-renders)
 *  applied per frame to avoid processing an entire result in one go. */
const MAX_STREAMING_OPS_PER_FRAME = 200;

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
  // Source of truth: Map ref. Two React states derived for each LOD tier.
  const renderedMapRef = useRef<Map<string, AsteroidChunkData>>(new Map());
  const chunkDistancesKmRef = useRef<Map<string, number>>(new Map());

  // Near tier (~17 elements): React renders AsteroidChunk components.
  // Updated per frame (budgeted) so chunks pop in smoothly.
  const [nearChunks, setNearChunks] = useState<AsteroidChunkData[]>([]);

  // Far tier (~4000 elements): passed to AsteroidImpostors (single draw call).
  // Updated less frequently since distant dots don't need per-frame accuracy.
  const [farChunks, setFarChunks] = useState<AsteroidChunkData[]>([]);

  // Incremental add/remove queues for renderedMap.
  const addQueueRef = useRef<string[]>([]);
  const removeQueueRef = useRef<string[]>([]);

  // Flags for deferred updates.
  const nearDirtyRef = useRef(false);
  const farDirtyRef = useRef(false);
  const farFrameCountRef = useRef(0);

  // Worker lifecycle
  const workerRef = useRef<Worker | null>(null);
  const epochRef = useRef(0);
  const wantedKeysRef = useRef<Set<string>>(new Set());

  // Async streaming: no fixed interval. We send a tick when the worker
  // isn't busy and process results incrementally across frames.
  const streamingPendingRef = useRef(false); // true = waiting for worker result
  const pendingResultRef = useRef<AsteroidChunkWorkerStreamingResultMsg | null>(null);
  /** Progress cursor into the pending result's arrays. */
  const pendingResultCursorRef = useRef(0);

  // Collision accumulator
  const collisionAccRef = useRef(0);

  // Collision log throttling
  const lastCollisionLogMsRef = useRef<Map<number, number>>(new Map());

  // ── Helpers ─────────────────────────────────────────────────────

  /** Rebuild nearChunks state from the renderedMap. Fast — only ~17 near-tier elements. */
  const rebuildNearChunks = useCallback(() => {
    const nearRadius = renderCfg.nearRadiusKm;
    const chunks: AsteroidChunkData[] = [];
    renderedMapRef.current.forEach((chunk, key) => {
      const d = chunkDistancesKmRef.current.get(key) ?? Infinity;
      if (d < nearRadius) chunks.push(chunk);
    });
    setNearChunks(chunks);
    nearDirtyRef.current = false;
  }, [renderCfg.nearRadiusKm]);

  /** Rebuild farChunks state from the renderedMap. */
  const rebuildFarChunks = useCallback(() => {
    if (renderCfg.farRadiusKm <= 0) {
      if (farChunks.length > 0) setFarChunks([]);
      farDirtyRef.current = false;
      return;
    }
    const farStart = renderCfg.nearRadiusKm - renderCfg.crossFadeKm;
    const chunks: AsteroidChunkData[] = [];
    renderedMapRef.current.forEach((chunk, key) => {
      const d = chunkDistancesKmRef.current.get(key) ?? 0;
      if (d >= farStart) chunks.push(chunk);
    });
    setFarChunks(chunks);
    farDirtyRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderCfg.farRadiusKm, renderCfg.nearRadiusKm, renderCfg.crossFadeKm]);

  // Listen for chunk mutations from ANY caller (MiningSystem, collisions, etc.).
  // This keeps renderedMapRef in sync when external systems call destroyInstance().
  useEffect(() => {
    const unsubscribe = fieldRuntime.onChunkUpdate((chunkKey, updatedChunk) => {
      if (renderedMapRef.current.has(chunkKey)) {
        renderedMapRef.current.set(chunkKey, updatedChunk);
        nearDirtyRef.current = true;
        farDirtyRef.current = true;
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
  // Stashes the result for incremental processing in the frame loop.
  // The wanted Set is built eagerly so that incoming "generated" chunks
  // aren't rejected while we're still draining distances.
  const handleStreamingResult = useCallback(
    (msg: AsteroidChunkWorkerStreamingResultMsg) => {
      wantedKeysRef.current = new Set(msg.wantedKeys);
      pendingResultRef.current = msg;
      pendingResultCursorRef.current = 0;
      streamingPendingRef.current = false; // worker is free for next tick
    },
    []
  );

  // ── Worker lifecycle ────────────────────────────────────────────

  useEffect(() => {
    fieldRuntime.clear();
    renderedMapRef.current.clear();
    chunkDistancesKmRef.current.clear();
    addQueueRef.current.length = 0;
    removeQueueRef.current.length = 0;
    setNearChunks([]);
    setFarChunks([]);

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
        unloadRadiusKm: streamingCfg.unloadRadiusKm,
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
      pendingResultRef.current = null;
      streamingPendingRef.current = false;
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
    streamingCfg.unloadRadiusKm,
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

  useFrame((_, delta) => {
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
        setNearChunks([]);
        setFarChunks([]);
      }

      epochRef.current += 1;
      wantedKeysRef.current.clear();
      pendingResultRef.current = null;
      streamingPendingRef.current = false;

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

    // ── Phase A: Process pending streaming result + apply queued
    //    chunk changes. Everything is budgeted per frame. ──

    // A1: Incrementally drain the pending streaming result.
    {
      const result = pendingResultRef.current;
      if (result) {
        let ops = MAX_STREAMING_OPS_PER_FRAME;
        const cursor = pendingResultCursorRef.current;
        const totalKeys = result.wantedKeys.length;
        const unloads = result.unloadKeys;
        const removeRenders = result.removeRenderKeys;

        // Step 1: Process unloads (small array, do all at once — typically 0-few).
        if (cursor === 0) {
          for (let i = 0; i < unloads.length && ops > 0; i++) {
            fieldRuntime.removeChunk(unloads[i]);
            ops--;
          }

          // Queue rendered chunks for removal.
          for (let i = 0; i < removeRenders.length && ops > 0; i++) {
            if (renderedMapRef.current.has(removeRenders[i])) {
              removeQueueRef.current.push(removeRenders[i]);
              ops--;
            }
          }
        }

        // Step 2: Apply wanted keys + distances in batches.
        let i = cursor;
        const distances = chunkDistancesKmRef.current;
        while (i < totalKeys && ops > 0) {
          distances.set(result.wantedKeys[i], result.wantedDists[i]);
          ops--;
          i++;
        }
        pendingResultCursorRef.current = i;

        // Step 3: When fully processed, queue removes for rendered
        // chunks no longer wanted (wanted set was built eagerly in the
        // message handler so "generated" chunks aren't rejected).
        if (i >= totalKeys) {
          const wanted = wantedKeysRef.current;

          renderedMapRef.current.forEach((_, key) => {
            if (!wanted.has(key)) {
              removeQueueRef.current.push(key);
            }
          });

          nearDirtyRef.current = true;
          farDirtyRef.current = true;
          pendingResultRef.current = null;
        }
      }
    }

    // A2: Apply queued chunk adds/removes (budgeted).
    {
      let budget = MAX_CHUNK_MOUNTS_PER_FRAME;
      const rendered = renderedMapRef.current;

      // Removes
      const removeQueue = removeQueueRef.current;
      while (removeQueue.length > 0 && budget > 0) {
        const key = removeQueue.pop()!;
        if (rendered.delete(key)) {
          chunkDistancesKmRef.current.delete(key);
          nearDirtyRef.current = true;
          farDirtyRef.current = true;
          budget--;
        }
      }

      // Adds
      const addQueue = addQueueRef.current;
      while (addQueue.length > 0 && budget > 0) {
        const key = addQueue[0];
        addQueue.shift();

        if (rendered.has(key)) continue;
        const chunk = fieldRuntime.getChunk(key);
        if (!chunk) continue;

        const d = chunkDistKm(
          px, py, pz,
          chunk.aabbMinKm[0], chunk.aabbMinKm[1], chunk.aabbMinKm[2],
          chunk.aabbMaxKm[0], chunk.aabbMaxKm[1], chunk.aabbMaxKm[2],
        );
        if (d > renderCfg.drawRadiusKm) continue;

        rendered.set(key, chunk);
        chunkDistancesKmRef.current.set(key, d);
        nearDirtyRef.current = true;
        farDirtyRef.current = true;
        budget--;
      }

      // Update near-tier React state (cheap — ~17 elements).
      if (nearDirtyRef.current) {
        rebuildNearChunks();
      }

      // Update far-tier React state at lower frequency.
      farFrameCountRef.current++;
      if (farDirtyRef.current && farFrameCountRef.current % FAR_TIER_UPDATE_FRAMES === 0) {
        rebuildFarChunks();
      }
    }

    // ── Phase B: Dispatch streaming tick to worker (async) ───────────
    // No fixed interval. As soon as the worker finishes a result and we've
    // processed it, fire the next tick immediately. The worker naturally
    // throttles to its own computation speed.
    if (!streamingPendingRef.current && !pendingResultRef.current) {
      const w = workerRef.current;
      if (w) {
        streamingPendingRef.current = true;
        w.postMessage({
          type: "streamingTick",
          fieldId: field.id,
          epoch: epochRef.current,
          px,
          py,
          pz,
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
      {/* Near tier: batched InstancedMesh per model type (stable, no mount/unmount churn). */}
      {nearChunks.length > 0 && (
        <NearTierBatch
          chunks={nearChunks}
          modelRegistry={modelRegistry}
        />
      )}

      {/* Far tier: billboard impostors (single batched draw call). */}
      {renderCfg.farRadiusKm > 0 && farChunks.length > 0 && (
        <AsteroidImpostors
          chunks={farChunks}
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
