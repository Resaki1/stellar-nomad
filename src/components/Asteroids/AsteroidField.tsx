"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { useAtomValue, useSetAtom } from "jotai";

import SimGroup from "@/components/space/SimGroup";
import AsteroidChunk from "@/components/Asteroids/AsteroidChunk";

import { systemConfigAtom } from "@/store/system";
import { shipHealthAtom } from "@/store/store";
import { spawnVFXEventAtom } from "@/store/vfx";
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

import type { AsteroidChunkWorkerWorkerToMainMessage } from "@/workers/asteroidChunkWorkerProtocol";

const UPDATE_INTERVAL_S = 0.2; // streaming / culling updates
const MAX_NEW_CHUNKS_PER_TICK = 8;

// Collision logging is intentionally conservative to keep perf stable while you validate plumbing.
const COLLISION_INTERVAL_S = 0.1; // 10 Hz collision checks
const SHIP_COLLIDER_RADIUS_M = 60; // tune later; kept small to avoid spam
const COLLISION_LOG_COOLDOWN_MS = 1000; // per asteroid id
const MAX_COLLISION_LOGS_PER_TICK = 3;

function arraysEqual(a: string[], b: string[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function computeChunkRange(
  pKm: number,
  radiusKm: number,
  chunkSizeKm: number
): [number, number] {
  const min = Math.floor((pKm - radiusKm) / chunkSizeKm);
  const max = Math.floor((pKm + radiusKm) / chunkSizeKm);
  return [min, max];
}

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

  // Authoritative runtime for this field (chunks + instanceId -> location index).
  const fieldRuntime = useMemo(
    () => asteroidRuntime.getOrCreateFieldRuntime(field.id),
    [asteroidRuntime, field.id]
  );

  // Rendering state is derived from the runtime’s loaded chunks.
  const [renderedChunks, setRenderedChunks] = useState<AsteroidChunkData[]>([]);
  const lastRenderedKeysRef = useRef<string[]>([]);
  const lastRenderedChunksRef = useRef<AsteroidChunkData[]>([]);

  // Worker lifecycle
  const workerRef = useRef<Worker | null>(null);
  const epochRef = useRef(0);
  const inFlightRef = useRef<Set<string>>(new Set());
  const wantedKeysRef = useRef<Set<string>>(new Set());

  // Tick accumulators
  const updateAccRef = useRef(0);
  const collisionAccRef = useRef(0);

  // Collision log throttling
  const lastCollisionLogMsRef = useRef<Map<number, number>>(new Map());

  const removeAsteroidInstance = useCallback(
    (instanceId: number) => {
      const updatedChunk = fieldRuntime.destroyInstance(instanceId);
      if (!updatedChunk) return;

      setRenderedChunks((prev) => {
        let changed = false;

        const next = prev.map((chunk) => {
          if (chunk.key !== updatedChunk.key) return chunk;
          changed = true;
          return updatedChunk;
        });

        if (!changed) return prev;

        // Nice-to-have: keep the ref in sync so the streaming tick doesn't do a redundant state update.
        lastRenderedChunksRef.current = next;

        return next;
      });
    },
    [fieldRuntime]
  );

  const applyShipCollisionDamage = useCallback(() => {
    setShipHealth((prev) => Math.max(0, prev - 10));
  }, [setShipHealth]);

  useEffect(() => {
    // Reset runtime + render output on re-init.
    fieldRuntime.clear();
    lastRenderedKeysRef.current = [];
    lastRenderedChunksRef.current = [];
    setRenderedChunks([]);

    // New epoch cancels stale results.
    epochRef.current += 1;
    const epoch = epochRef.current;

    // Module worker is required (worker file contains ESM imports).
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

      // msg.type === "generated"
      if (msg.fieldId !== field.id) return;
      if (msg.epoch !== epochRef.current) return;

      const chunk = msg.chunk;

      inFlightRef.current.delete(chunk.key);

      // If the chunk is no longer wanted (player moved / cap changed), drop it.
      if (!wantedKeysRef.current.has(chunk.key)) {
        return;
      }

      // Authoritatively store chunk and build instanceId -> location index.
      fieldRuntime.upsertChunk(chunk);
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

    // IMPORTANT: match asteroidChunkWorkerProtocol.ts exactly.
    w.postMessage({
      type: "init",
      fieldId: field.id,
      field,
      models,
      chunkSizeKm: streamingCfg.chunkSizeKm,
      maxAsteroidsPerChunk: generationCfg.maxAsteroidsPerChunk,
      epoch,
    });

    return () => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      w.removeEventListener("messageerror", onMessageError);
      w.terminate();

      workerRef.current = null;
      inFlightRef.current.clear();
      wantedKeysRef.current.clear();
      fieldRuntime.clear();
    };
  }, [
    field,
    field.id,
    fieldRuntime,
    models,
    streamingCfg.chunkSizeKm,
    generationCfg.maxAsteroidsPerChunk,
  ]);

  useEffect(() => {
    // Cleanup field runtime when the layer unmounts.
    // Note: We intentionally do NOT remove the field runtime here because:
    // 1. React Strict Mode causes mount/unmount/remount cycles
    // 2. The field runtime is shared and may be accessed by other components (like MiningSystem)
    // 3. The runtime will be cleared and recreated if the field config changes
    return () => {
      // Only clear the chunks, don't remove the field from the system runtime
      fieldRuntime.clear();
    };
  }, [asteroidRuntime, field.id, fieldRuntime]);

  useFrame((_, delta) => {
    // Always advance both accumulators.
    updateAccRef.current += delta;
    collisionAccRef.current += delta;

    const ship = worldOrigin.shipPosKm;

    // Ship in field-local KM coordinates (relative to field anchor).
    const px = ship.x - field.anchorKm[0];
    const py = ship.y - field.anchorKm[1];
    const pz = ship.z - field.anchorKm[2];

    // If far away, hard-clear and cancel.
    const distToFieldKm = shape.distanceToKm(px, py, pz);
    if (distToFieldKm > streamingCfg.unloadRadiusKm) {
      if (fieldRuntime.chunks.size > 0) fieldRuntime.clear();

      if (lastRenderedKeysRef.current.length > 0) {
        lastRenderedKeysRef.current = [];
        lastRenderedChunksRef.current = [];
        setRenderedChunks([]);
      }

      epochRef.current += 1;
      inFlightRef.current.clear();
      wantedKeysRef.current.clear();

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

    // Streaming / culling updates at 5 Hz.
    if (updateAccRef.current >= UPDATE_INTERVAL_S) {
      updateAccRef.current = 0;

      // Unload chunks beyond unload radius (must go through runtime to keep index correct).
      fieldRuntime.chunks.forEach((chunk, key) => {
        const d = distancePointToAabbKm(
          px,
          py,
          pz,
          chunk.aabbMinKm[0],
          chunk.aabbMinKm[1],
          chunk.aabbMinKm[2],
          chunk.aabbMaxKm[0],
          chunk.aabbMaxKm[1],
          chunk.aabbMaxKm[2]
        );

        if (d > streamingCfg.unloadRadiusKm) {
          fieldRuntime.removeChunk(key);
          inFlightRef.current.delete(key);
        }
      });

      // Determine missing chunks within load radius.
      const chunkSizeKm = streamingCfg.chunkSizeKm;

      const [minCx, maxCx] = computeChunkRange(px, streamingCfg.loadRadiusKm, chunkSizeKm);
      const [minCy, maxCy] = computeChunkRange(py, streamingCfg.loadRadiusKm, chunkSizeKm);
      const [minCz, maxCz] = computeChunkRange(pz, streamingCfg.loadRadiusKm, chunkSizeKm);

      const candidates: Array<{ coord: ChunkCoord; key: string; dist: number }> = [];

      for (let cx = minCx; cx <= maxCx; cx++) {
        const minX = cx * chunkSizeKm;
        const maxX = minX + chunkSizeKm;

        for (let cy = minCy; cy <= maxCy; cy++) {
          const minY = cy * chunkSizeKm;
          const maxY = minY + chunkSizeKm;

          for (let cz = minCz; cz <= maxCz; cz++) {
            const minZ = cz * chunkSizeKm;
            const maxZ = minZ + chunkSizeKm;

            if (!shape.intersectsAabbKm(minX, minY, minZ, maxX, maxY, maxZ)) continue;

            const dist = distancePointToAabbKm(
              px,
              py,
              pz,
              minX,
              minY,
              minZ,
              maxX,
              maxY,
              maxZ
            );
            if (dist > streamingCfg.loadRadiusKm) continue;

            const coord: ChunkCoord = { x: cx, y: cy, z: cz };
            const key = makeChunkKey(field.id, coord);
            candidates.push({ coord, key, dist });
          }
        }
      }

      candidates.sort((a, b) => a.dist - b.dist);
      const capped = candidates.slice(0, streamingCfg.maxActiveChunks);

      // Update wanted set for accepting/ignoring worker results.
      const wanted = new Set<string>();
      for (let i = 0; i < capped.length; i++) wanted.add(capped[i].key);
      wantedKeysRef.current = wanted;

      // Request missing chunks (bounded).
      const w = workerRef.current;
      const epoch = epochRef.current;
      let requestedThisTick = 0;

      for (let i = 0; i < capped.length; i++) {
        const { coord, key } = capped[i];

        if (fieldRuntime.hasChunk(key)) continue;
        if (inFlightRef.current.has(key)) continue;
        if (requestedThisTick >= MAX_NEW_CHUNKS_PER_TICK) break;

        if (w) {
          inFlightRef.current.add(key);
          w.postMessage({ type: "generate", fieldId: field.id, coord, epoch });
          requestedThisTick++;
        }
      }

      // (streaming tick runs silently; heartbeat useEffect reports status)

      // Determine which chunks should be rendered (within draw radius).
      const nextChunks: AsteroidChunkData[] = [];
      fieldRuntime.chunks.forEach((chunk) => {
        const d = distancePointToAabbKm(
          px,
          py,
          pz,
          chunk.aabbMinKm[0],
          chunk.aabbMinKm[1],
          chunk.aabbMinKm[2],
          chunk.aabbMaxKm[0],
          chunk.aabbMaxKm[1],
          chunk.aabbMaxKm[2]
        );
        if (d > renderCfg.drawRadiusKm) return;
        nextChunks.push(chunk);
      });

      nextChunks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

      const nextKeys = nextChunks.map((c) => c.key);
      const keysChanged = !arraysEqual(nextKeys, lastRenderedKeysRef.current);

      const chunksChanged =
        !keysChanged &&
        (nextChunks.length !== lastRenderedChunksRef.current.length ||
          nextChunks.some((chunk, idx) => chunk !== lastRenderedChunksRef.current[idx]));

      if (keysChanged || chunksChanged) {
        lastRenderedKeysRef.current = nextKeys;
        lastRenderedChunksRef.current = nextChunks;
        setRenderedChunks(nextChunks);
      }
    }

    // Collision checks at 10 Hz (simple sphere–sphere, logs only).
    if (collisionAccRef.current >= COLLISION_INTERVAL_S) {
      collisionAccRef.current = 0;

      const shipRadiusM = SHIP_COLLIDER_RADIUS_M;
      const shipRadiusKm = shipRadiusM / 1000;
      const chunkSizeKm = streamingCfg.chunkSizeKm;

      // Only check the chunk the ship is in and its neighbors (3x3x3) for performance.
      const shipCx = Math.floor(px / chunkSizeKm);
      const shipCy = Math.floor(py / chunkSizeKm);
      const shipCz = Math.floor(pz / chunkSizeKm);

      const nowMs = performance.now();
      const lastLog = lastCollisionLogMsRef.current;

      // Avoid unbounded growth in long sessions.
      if (lastLog.size > 20_000) lastLog.clear();

      let logsThisTick = 0;

      // Iterate 27 chunks.
      for (let ox = -1; ox <= 1 && logsThisTick < MAX_COLLISION_LOGS_PER_TICK; ox++) {
        for (let oy = -1; oy <= 1 && logsThisTick < MAX_COLLISION_LOGS_PER_TICK; oy++) {
          for (let oz = -1; oz <= 1 && logsThisTick < MAX_COLLISION_LOGS_PER_TICK; oz++) {
            const coord: ChunkCoord = { x: shipCx + ox, y: shipCy + oy, z: shipCz + oz };
            const key = makeChunkKey(field.id, coord);

            const chunk = fieldRuntime.getChunk(key);
            if (!chunk) continue;

            // Chunk-level reject using AABB distance.
            const aabbDistKm = distancePointToAabbKm(
              px,
              py,
              pz,
              chunk.aabbMinKm[0],
              chunk.aabbMinKm[1],
              chunk.aabbMinKm[2],
              chunk.aabbMaxKm[0],
              chunk.aabbMaxKm[1],
              chunk.aabbMaxKm[2]
            );

            const chunkInflationKm = shipRadiusKm + chunk.maxRadiusM / 1000;
            if (aabbDistKm > chunkInflationKm) continue;

            // Ship in chunk-local meters.
            const sxM = (px - chunk.originKm[0]) * 1000;
            const syM = (py - chunk.originKm[1]) * 1000;
            const szM = (pz - chunk.originKm[2]) * 1000;

            const byModel = chunk.instancesByModel;

            // Iterate models and instances.
            // Note: Object.keys allocates; use for..in to avoid per-tick allocations.
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
                const r2 = r * r;

                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 > r2) continue;

                const instanceId = ids[i] >>> 0;

                const prevMs = lastLog.get(instanceId);
                if (prevMs !== undefined && nowMs - prevMs < COLLISION_LOG_COOLDOWN_MS) {
                  continue;
                }
                lastLog.set(instanceId, nowMs);

                // Compute asteroid position in local render-space meters
                // (for VFX spawning — relative to world origin, not chunk)
                const chunkOriginLocalX =
                  (field.anchorKm[0] + chunk.originKm[0] - worldOrigin.worldOriginKm.x) * 1000;
                const chunkOriginLocalY =
                  (field.anchorKm[1] + chunk.originKm[1] - worldOrigin.worldOriginKm.y) * 1000;
                const chunkOriginLocalZ =
                  (field.anchorKm[2] + chunk.originKm[2] - worldOrigin.worldOriginKm.z) * 1000;

                const asteroidLocalX = chunkOriginLocalX + positions[pIndex];
                const asteroidLocalY = chunkOriginLocalY + positions[pIndex + 1];
                const asteroidLocalZ = chunkOriginLocalZ + positions[pIndex + 2];

                // Ship position in local render-space meters
                const shipLocalX = (ship.x - worldOrigin.worldOriginKm.x) * 1000;
                const shipLocalY = (ship.y - worldOrigin.worldOriginKm.y) * 1000;
                const shipLocalZ = (ship.z - worldOrigin.worldOriginKm.z) * 1000;

                // Impact direction: from asteroid center toward ship (normalized)
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

  return (
    <SimGroup space="local" positionKm={field.anchorKm}>
      {renderedChunks.map((chunk) => (
        <AsteroidChunk key={chunk.key} chunk={chunk} modelRegistry={modelRegistry} />
      ))}
    </SimGroup>
  );
});

FieldLayer.displayName = "FieldLayer";

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
