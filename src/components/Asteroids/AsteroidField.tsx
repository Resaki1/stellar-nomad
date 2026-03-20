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
} from "@/workers/asteroidChunkWorkerProtocol";

// ─── Tuning constants ───────────────────────────────────────────────

/**
 * Look-ahead time in seconds for generation priority. The planning
 * sphere is centered on (pos + vel × lookAhead) so chunks in the
 * direction of travel are discovered and generated first.
 */
const GENERATION_LOOK_AHEAD_S = 2.0;

/** Max new generation requests sent to worker per planning tick. */
const MAX_GEN_REQUESTS_PER_TICK = 256;

// Collision
const COLLISION_INTERVAL_S = 0.1;
const SHIP_COLLIDER_RADIUS_M = 60;
const COLLISION_LOG_COOLDOWN_MS = 1000;
const MAX_COLLISION_LOGS_PER_TICK = 3;

// ─── Helpers ────────────────────────────────────────────────────────

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

function computeChunkRange(
  pKm: number,
  radiusKm: number,
  chunkSizeKm: number
): [number, number] {
  return [
    Math.floor((pKm - radiusKm) / chunkSizeKm),
    Math.floor((pKm + radiusKm) / chunkSizeKm),
  ];
}

function computeEffectiveLoadRadius(
  loadRadiusKm: number,
  chunkSizeKm: number,
  maxActiveChunks: number
): number {
  const chunkVol = chunkSizeKm * chunkSizeKm * chunkSizeKm;
  const sphereRadius = Math.pow(
    (maxActiveChunks * chunkVol * 3) / (4 * Math.PI),
    1 / 3
  );
  return Math.min(loadRadiusKm, sphereRadius + chunkSizeKm);
}

// ─── Pre-allocated candidate buffers (reused across planning ticks) ──
const _MAX_CANDIDATES = 32768;
let _candCx = new Int32Array(_MAX_CANDIDATES);
let _candCy = new Int32Array(_MAX_CANDIDATES);
let _candCz = new Int32Array(_MAX_CANDIDATES);
let _candDist = new Float64Array(_MAX_CANDIDATES);
let _candIndices = new Uint32Array(_MAX_CANDIDATES);

function ensureCandidateBuffers(size: number): void {
  if (size <= _candCx.length) return;
  const newSize = Math.max(size, _candCx.length * 2);
  _candCx = new Int32Array(newSize);
  _candCy = new Int32Array(newSize);
  _candCz = new Int32Array(newSize);
  _candDist = new Float64Array(newSize);
  _candIndices = new Uint32Array(newSize);
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

  const effectiveLoadRadiusKm = useMemo(
    () => computeEffectiveLoadRadius(
      streamingCfg.loadRadiusKm,
      streamingCfg.chunkSizeKm,
      streamingCfg.maxActiveChunks,
    ),
    [streamingCfg.loadRadiusKm, streamingCfg.chunkSizeKm, streamingCfg.maxActiveChunks]
  );

  const fieldRuntime = useMemo(
    () => asteroidRuntime.getOrCreateFieldRuntime(field.id),
    [asteroidRuntime, field.id]
  );

  // ── Rendering state ─────────────────────────────────────────────
  const renderedMapRef = useRef<Map<string, AsteroidChunkData>>(new Map());
  const chunkDistancesKmRef = useRef<Map<string, number>>(new Map());
  const renderedGenRef = useRef(0);

  // GPU slot allocators: one per model type.
  const allocatorsRef = useRef<NearTierAllocators>(new Map());
  useMemo(() => {
    const allocs = new Map<string, GpuSlotAllocator>();
    modelRegistry.forEach((_asset, id) => {
      allocs.set(id, new GpuSlotAllocator(MAX_NEAR_INSTANCES));
    });
    allocatorsRef.current = allocs;
  }, [modelRegistry]);

  // Worker lifecycle
  const workerRef = useRef<Worker | null>(null);
  const epochRef = useRef(0);

  // Planning tick throttle + velocity.
  const tickFrameRef = useRef(0);
  const prevFieldPosRef = useRef({ x: 0, y: 0, z: 0, valid: false });

  // Collision
  const collisionAccRef = useRef(0);
  const lastCollisionLogMsRef = useRef<Map<number, number>>(new Map());

  // DEBUG: diagnostic timer for stuck chunks
  const debugAccRef = useRef(0);

  // Listen for chunk mutations from external systems (mining, collisions).
  useEffect(() => {
    const unsubscribe = fieldRuntime.onChunkUpdate((chunkKey, updatedChunk) => {
      if (renderedMapRef.current.has(chunkKey)) {
        renderedMapRef.current.set(chunkKey, updatedChunk);
        renderedGenRef.current++;

        allocatorsRef.current.forEach((alloc) => {
          if (alloc.hasChunk(chunkKey)) alloc.freeChunk(chunkKey);
        });
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

  // ── Worker lifecycle ────────────────────────────────────────────

  useEffect(() => {
    fieldRuntime.clear();
    renderedMapRef.current.clear();
    chunkDistancesKmRef.current.clear();
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
        // Upsert into runtime. Phase A will pick it up next frame.
        fieldRuntime.upsertChunk(msg.chunk);
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
    });

    return () => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      w.removeEventListener("messageerror", onMessageError);
      w.terminate();

      workerRef.current = null;
      prevFieldPosRef.current.valid = false;
      tickFrameRef.current = 0;
      fieldRuntime.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    field,
    field.id,
    fieldRuntime,
    models,
    streamingCfg.chunkSizeKm,
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
        renderedGenRef.current++;
        allocatorsRef.current.forEach((alloc) => alloc.clear());
      }

      epochRef.current += 1;
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

    // ── Phase A: Sync rendered state from fieldRuntime. ─────────
    // Iterate all loaded chunks. Add/remove from rendered based on
    // actual player distance. Sync GPU allocations for near/far.
    // This is the Minecraft model: rendered = loaded ∩ drawRadius.
    {
      const rendered = renderedMapRef.current;
      const distances = chunkDistancesKmRef.current;
      const nearR = renderCfg.nearRadiusKm;
      const drawR = renderCfg.drawRadiusKm;
      let changed = false;

      // 1. Sync loaded chunks → rendered.
      fieldRuntime.chunks.forEach((chunk, key) => {
        const d = chunkDistKm(
          px, py, pz,
          chunk.aabbMinKm[0], chunk.aabbMinKm[1], chunk.aabbMinKm[2],
          chunk.aabbMaxKm[0], chunk.aabbMaxKm[1], chunk.aabbMaxKm[2],
        );
        distances.set(key, d);

        if (d <= drawR) {
          if (!rendered.has(key)) {
            // New chunk entering draw range — always add to rendered
            // so the far tier (impostors) can display it. GPU allocation
            // for the near tier is best-effort on top of that.
            rendered.set(key, chunk);
            changed = true;

            if (d <= nearR) {
              // Best-effort GPU allocation per model. Models that can't
              // fit stay as impostors — no rollback, no all-or-nothing.
              for (const modelId in chunk.instancesByModel) {
                const alloc = allocatorsRef.current.get(modelId);
                if (alloc) {
                  alloc.allocateChunk(key, chunk.originKm, chunk.instancesByModel[modelId]);
                }
              }
            }
          } else {
            // Already rendered — sync GPU near/far transitions.
            if (d <= nearR) {
              for (const modelId in chunk.instancesByModel) {
                const alloc = allocatorsRef.current.get(modelId);
                if (alloc && !alloc.hasChunk(key)) {
                  if (alloc.allocateChunk(key, chunk.originKm, chunk.instancesByModel[modelId])) {
                    changed = true;
                  }
                }
              }
            } else {
              allocatorsRef.current.forEach((alloc) => {
                if (alloc.hasChunk(key)) {
                  alloc.freeChunk(key);
                  changed = true;
                }
              });
            }
          }
        } else {
          // Beyond draw range — remove if rendered.
          if (rendered.has(key)) {
            rendered.delete(key);
            distances.delete(key);
            for (const modelId in chunk.instancesByModel) {
              allocatorsRef.current.get(modelId)?.freeChunk(key);
            }
            changed = true;
          }
        }
      });

      // 2. Clean up rendered entries whose chunks were unloaded
      //    (by Phase B's unload from the previous frame).
      rendered.forEach((_, key) => {
        if (!fieldRuntime.hasChunk(key)) {
          rendered.delete(key);
          distances.delete(key);
          allocatorsRef.current.forEach((alloc) => {
            if (alloc.hasChunk(key)) alloc.freeChunk(key);
          });
          changed = true;
        }
      });

      if (changed) renderedGenRef.current++;
    }

    // ── DEBUG: Report all chunks within 10km every 2 seconds ────
    debugAccRef.current += delta;
    if (debugAccRef.current >= 2) {
      debugAccRef.current = 0;
      const rendered = renderedMapRef.current;
      const nearbyInfo: string[] = [];
      fieldRuntime.chunks.forEach((chunk, key) => {
        const d = chunkDistKm(
          px, py, pz,
          chunk.aabbMinKm[0], chunk.aabbMinKm[1], chunk.aabbMinKm[2],
          chunk.aabbMaxKm[0], chunk.aabbMaxKm[1], chunk.aabbMaxKm[2],
        );
        if (d > 10) return; // only chunks within 10km
        const inRendered = rendered.has(key);
        const renderedChunk = rendered.get(key);
        const modelIds = Object.keys(chunk.instancesByModel);
        const gpuState = modelIds.map((mid) => {
          const alloc = allocatorsRef.current.get(mid);
          const ftCount = chunk.instancesByModel[mid].count;
          const rtSame = renderedChunk ? renderedChunk.instancesByModel[mid] === chunk.instancesByModel[mid] : false;
          return `${mid}(count=${ftCount},gpu=${alloc?.hasChunk(key)},sameRef=${rtSame})`;
        });
        nearbyInfo.push(
          `  ${key} d=${d.toFixed(2)}km rendered=${inRendered} models=[${gpuState.join(", ")}]`
        );
      });
      if (nearbyInfo.length > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[DEBUG] ${nearbyInfo.length} chunks within 10km.`,
          `ftSize=${fieldRuntime.chunks.size} rendSize=${rendered.size}`,
          `nearR=${renderCfg.nearRadiusKm} drawR=${renderCfg.drawRadiusKm}`,
          `\n${nearbyInfo.join("\n")}`
        );
      }
    }

    // ── Phase B: Planning (every 2 frames). ─────────────────────
    // Discover which chunks should be loaded, request generation for
    // new ones, unload chunks that left the load sphere.
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

    tickFrameRef.current++;
    if (tickFrameRef.current >= 2) {
      tickFrameRef.current = 0;

      const loadR = effectiveLoadRadiusKm;
      const chunkSizeKm = streamingCfg.chunkSizeKm;

      // 1. Predicted position for candidate discovery.
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const lookAheadKm = Math.min(speed * GENERATION_LOOK_AHEAD_S, loadR * 0.5);
      let predX = px, predY = py, predZ = pz;
      if (speed > 0.001) {
        const scale = lookAheadKm / speed;
        predX += vx * scale;
        predY += vy * scale;
        predZ += vz * scale;
      }

      // 2. Triple loop: find candidates within load radius of predicted pos.
      const [minCx, maxCx] = computeChunkRange(predX, loadR, chunkSizeKm);
      const [minCy, maxCy] = computeChunkRange(predY, loadR, chunkSizeKm);
      const [minCz, maxCz] = computeChunkRange(predZ, loadR, chunkSizeKm);

      let candidateCount = 0;

      for (let cx = minCx; cx <= maxCx; cx++) {
        const cMinX = cx * chunkSizeKm;
        const cMaxX = cMinX + chunkSizeKm;
        for (let cy = minCy; cy <= maxCy; cy++) {
          const cMinY = cy * chunkSizeKm;
          const cMaxY = cMinY + chunkSizeKm;
          for (let cz = minCz; cz <= maxCz; cz++) {
            const cMinZ = cz * chunkSizeKm;
            const cMaxZ = cMinZ + chunkSizeKm;

            if (!shape.intersectsAabbKm(cMinX, cMinY, cMinZ, cMaxX, cMaxY, cMaxZ)) continue;

            const dist = chunkDistKm(predX, predY, predZ, cMinX, cMinY, cMinZ, cMaxX, cMaxY, cMaxZ);
            if (dist > loadR) continue;

            ensureCandidateBuffers(candidateCount + 1);
            _candCx[candidateCount] = cx;
            _candCy[candidateCount] = cy;
            _candCz[candidateCount] = cz;
            _candDist[candidateCount] = dist;
            candidateCount++;
          }
        }
      }

      // 3. Sort by predicted distance, cap to maxActiveChunks.
      if (candidateCount > _candIndices.length) {
        _candIndices = new Uint32Array(candidateCount);
      }
      for (let i = 0; i < candidateCount; i++) _candIndices[i] = i;
      const indicesView = _candIndices.subarray(0, candidateCount);
      indicesView.sort((a, b) => _candDist[a] - _candDist[b]);

      const capped = Math.min(candidateCount, streamingCfg.maxActiveChunks);

      // 4. Build "should be loaded" set + collect generation requests.
      const shouldBeLoaded = new Set<string>();
      const genItems: Array<{ cx: number; cy: number; cz: number }> = [];

      for (let i = 0; i < capped; i++) {
        const idx = indicesView[i];
        const cx = _candCx[idx];
        const cy = _candCy[idx];
        const cz = _candCz[idx];
        const key = `${field.id}:${cx},${cy},${cz}`;

        shouldBeLoaded.add(key);

        if (!fieldRuntime.hasChunk(key) && genItems.length < MAX_GEN_REQUESTS_PER_TICK) {
          genItems.push({ cx, cy, cz });
        }
      }

      // 5. Unload chunks not in the "should be loaded" set.
      const unloadKeys: string[] = [];
      fieldRuntime.chunks.forEach((_, key) => {
        if (!shouldBeLoaded.has(key)) {
          unloadKeys.push(key);
        }
      });
      for (let i = 0; i < unloadKeys.length; i++) {
        fieldRuntime.removeChunk(unloadKeys[i]);
      }

      // 6. Tell worker to forget unloaded keys (so it can re-generate
      //    them if the player returns to the area).
      if (unloadKeys.length > 0) {
        const w = workerRef.current;
        if (w) {
          w.postMessage({
            type: "forgetChunks",
            fieldId: field.id,
            epoch: epochRef.current,
            keys: unloadKeys,
          });
        }
      }

      // 7. Send generation requests (append, not replace).
      if (genItems.length > 0) {
        const w = workerRef.current;
        if (w) {
          w.postMessage({
            type: "generateChunks",
            fieldId: field.id,
            epoch: epochRef.current,
            items: genItems,
          });
        }
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
      <NearTierBatch
        nearRadiusKm={renderCfg.nearRadiusKm}
        modelRegistry={modelRegistry}
        allocatorsRef={allocatorsRef}
      />

      {renderCfg.farRadiusKm > 0 && (
        <AsteroidImpostors
          renderedMapRef={renderedMapRef}
          chunkDistancesRef={chunkDistancesKmRef}
          renderedGenRef={renderedGenRef}
          nearRadiusKm={Math.max(0, renderCfg.nearRadiusKm - Math.sqrt(3) * streamingCfg.chunkSizeKm)}
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
