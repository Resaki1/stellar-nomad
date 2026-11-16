"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import * as THREE from "three";
import type { AsteroidModelAsset } from "@/sim/asteroids/modelRegistry";

import NearTierBatch from "@/components/Asteroids/NearTierBatch";
import type { NearTierAllocators } from "@/components/Asteroids/NearTierBatch";
import MidTierBatch from "@/components/Asteroids/MidTierBatch";
import FarTierBatch from "@/components/Asteroids/FarTierBatch";
import { GpuSlotAllocator, MAX_INSTANCES_PER_MODEL } from "@/components/Asteroids/GpuSlotAllocator";

import { systemConfigAtom } from "@/store/system";
import { SYSTEM_FRAME_ID, isFrameId, type FrameId } from "@/sim/frames";
import { nearField } from "@/sim/physics/nearField";
import { AsteroidFieldColliders, asteroidFieldColliders, registerAsteroidColliderModel, renderDebug, type FieldColliderContext } from "@/sim/physics/asteroidColliders";
import type { AsteroidFieldDef, SystemConfig } from "@/sim/systemTypes";
import {
  getSystemAsteroidModelDefs,
  resolveFieldGeneration,
  resolveFieldModels,
  resolveFieldRender,
  resolveFieldStreaming,
} from "@/sim/systemTypes";

import { useAsteroidModelRegistry } from "@/sim/asteroids/modelRegistry";
import type { AsteroidModelRegistries } from "@/sim/asteroids/modelRegistry";
import { useAsteroidRuntime } from "@/sim/asteroids/runtimeContext";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { prepareFieldShape } from "@/sim/asteroids/shapes";

import type {
  AsteroidChunkWorkerWorkerToMainMessage,
} from "@/workers/asteroidChunkWorkerProtocol";

// ─── Tuning constants ───────────────────────────────────────────────

const GENERATION_LOOK_AHEAD_S = 2.0;
const MAX_GEN_REQUESTS_PER_TICK = 256;

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

// ─── Pre-allocated candidate buffers ────────────────────────────────
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

/** Collision mesh = LOD1 vertices; scale and base rotation = the near tier's (what is drawn close up). */
function registerColliderModels(registries: AsteroidModelRegistries): void {
  registries.lod0.forEach((near: AsteroidModelAsset, id) => {
    const mesh = registries.lod1.get(id);
    const pos = (mesh ?? near).geometry.getAttribute("position");
    const pts = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      pts[i * 3] = pos.getX(i); pts[i * 3 + 1] = pos.getY(i); pts[i * 3 + 2] = pos.getZ(i);
    }
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(near.baseRotationRad[0], near.baseRotationRad[1], near.baseRotationRad[2]));
    registerAsteroidColliderModel(id, pts, mesh ? "lod1" : "lod0", [q.x, q.y, q.z, q.w], near.baseRadiusM, near.baseScale, {
      vertices: pos.count,
      lod0Vertices: near.geometry.getAttribute("position").count,
      lod0RadiusM: near.baseRadiusM / near.baseScale,
      lod1RadiusM: mesh ? mesh.baseRadiusM / mesh.baseScale : NaN,
    });
  });
}

// ─── FieldLayer ─────────────────────────────────────────────────────

type FieldLayerProps = {
  system: SystemConfig;
  field: AsteroidFieldDef;
  modelRegistries: AsteroidModelRegistries;
};

const FieldLayer = memo(function FieldLayer({
  system,
  field,
  modelRegistries,
}: FieldLayerProps) {
  const modelRegistry = modelRegistries.lod0;
  const worldOrigin = useWorldOrigin();
  const asteroidRuntime = useAsteroidRuntime();

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

  // ── GPU allocators: one per model, shared by near + far tiers ───
  const allocatorsRef = useRef<NearTierAllocators>(new Map());
  useMemo(() => {
    const allocs = new Map<string, GpuSlotAllocator>();
    modelRegistry.forEach((_asset, id) => {
      allocs.set(id, new GpuSlotAllocator(MAX_INSTANCES_PER_MODEL));
    });
    allocatorsRef.current = allocs;
  }, [modelRegistry]);

  // Worker lifecycle
  const workerRef = useRef<Worker | null>(null);
  const epochRef = useRef(0);

  // Planning tick throttle + velocity
  const tickFrameRef = useRef(0);
  const prevFieldPosRef = useRef({ x: 0, y: 0, z: 0, valid: false });

  // Physics colliders of this field's rocks around the ship (docs/PHYSICS_PLAN.md §7.2).
  const colliders = useMemo(() => new AsteroidFieldColliders(field.id, nearField), [field.id]);
  useEffect(() => {
    colliders.attach();
    asteroidFieldColliders.set(field.id, colliders);
    renderDebug.allocators.set(field.id, allocatorsRef);
    return () => {
      colliders.dispose();
      if (asteroidFieldColliders.get(field.id) === colliders) asteroidFieldColliders.delete(field.id);
      renderDebug.allocators.delete(field.id);
    };
  }, [colliders, field.id]);
  const unframedWarned = useRef(false);
  const colliderCtx = useRef<FieldColliderContext>({
    chunks: fieldRuntime.chunks, frameId: SYSTEM_FRAME_ID, anchorRelKm: [0, 0, 0], shipX: 0, shipY: 0, shipZ: 0,
  });

  // ── Chunk mutation listener (asteroid.destroyed) ──────────────
  // Re-allocates GPU slots when an external system mutates a chunk.
  useEffect(() => {
    const unsubscribe = fieldRuntime.onChunkUpdate((chunkKey, updatedChunk) => {
      colliders.onChunkUpdated(chunkKey, updatedChunk);
      // Re-sync GPU allocators for the mutated chunk.
      allocatorsRef.current.forEach((alloc) => {
        if (alloc.hasChunk(chunkKey)) alloc.freeChunk(chunkKey);
      });
      for (const modelId in updatedChunk.instancesByModel) {
        const alloc = allocatorsRef.current.get(modelId);
        if (alloc) {
          alloc.allocateChunk(chunkKey, updatedChunk.originKm, updatedChunk.instancesByModel[modelId]);
        }
      }
    });
    return unsubscribe;
  }, [fieldRuntime, colliders]);

  // ── Worker lifecycle ────────────────────────────────────────────

  useEffect(() => {
    fieldRuntime.clear();
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
         
        console.error("[AsteroidChunkWorker]", msg.message, msg.stack);
        return;
      }

      if (msg.fieldId !== field.id) return;
      if (msg.epoch !== epochRef.current) return;

      if (msg.type === "generated") {
        const chunk = msg.chunk;
        fieldRuntime.upsertChunk(chunk);

        // Use the runtime's filtered chunk (destroyed instances removed)
        // instead of the raw worker chunk.
        const filtered = fieldRuntime.getChunk(chunk.key);
        if (!filtered) return;

        // Immediately allocate GPU slots so both compute shaders see it next frame.
        for (const modelId in filtered.instancesByModel) {
          const alloc = allocatorsRef.current.get(modelId);
          if (alloc) {
            alloc.allocateChunk(filtered.key, filtered.originKm, filtered.instancesByModel[modelId]);
          }
        }
        return;
      }
    };

    const onError = (ev: ErrorEvent) => {
       
      console.error("[AsteroidChunkWorker] error event", ev.message);
    };

    const onMessageError = () => {
       
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
     
  }, [
    field,
    field.id,
    fieldRuntime,
    models,
    streamingCfg.chunkSizeKm,
    generationCfg.maxAsteroidsPerChunk,
  ]);

  useEffect(() => {
    return () => { fieldRuntime.clear(); };
  }, [asteroidRuntime, field.id, fieldRuntime]);

  // ── Frame loop ──────────────────────────────────────────────────

  useFrame((_state, delta) => {
    const ship = worldOrigin.shipPosKm;
    const px = ship.x - field.anchorKm[0];
    const py = ship.y - field.anchorKm[1];
    const pz = ship.z - field.anchorKm[2];

    // If far away, hard-clear.
    const distToFieldKm = shape.distanceToKm(px, py, pz);
    if (distToFieldKm > streamingCfg.unloadRadiusKm) {
      if (fieldRuntime.chunks.size > 0) fieldRuntime.clear();
      allocatorsRef.current.forEach((alloc) => alloc.clear());
      colliders.clear();

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

    // ── Phase A: Nothing. ───────────────────────────────────────
    // GPU allocations happen in onMessage (chunk arrives → allocate)
    // and in Phase B (chunk unloads → free). Both compute shaders
    // read the allocator buffer directly — no CPU per-frame sync.

    // ── Phase B: Planning (every 2 frames). ─────────────────────
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

      // Predicted position for generation priority.
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const lookAheadKm = Math.min(speed * GENERATION_LOOK_AHEAD_S, loadR * 0.5);
      let predX = px, predY = py, predZ = pz;
      if (speed > 0.001) {
        const scale = lookAheadKm / speed;
        predX += vx * scale;
        predY += vy * scale;
        predZ += vz * scale;
      }

      // Triple loop: candidates within load radius of predicted pos.
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

      // Sort by predicted distance, cap to maxActiveChunks.
      if (candidateCount > _candIndices.length) {
        _candIndices = new Uint32Array(candidateCount);
      }
      for (let i = 0; i < candidateCount; i++) _candIndices[i] = i;
      const indicesView = _candIndices.subarray(0, candidateCount);
      indicesView.sort((a, b) => _candDist[a] - _candDist[b]);

      const capped = Math.min(candidateCount, streamingCfg.maxActiveChunks);

      // Build "should be loaded" set + collect generation requests.
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

      // Unload chunks not in shouldBeLoaded + free GPU slots.
      const unloadKeys: string[] = [];
      fieldRuntime.chunks.forEach((_, key) => {
        if (!shouldBeLoaded.has(key)) {
          unloadKeys.push(key);
        }
      });
      for (let i = 0; i < unloadKeys.length; i++) {
        fieldRuntime.removeChunk(unloadKeys[i]);
        allocatorsRef.current.forEach((alloc) => {
          if (alloc.hasChunk(unloadKeys[i])) alloc.freeChunk(unloadKeys[i]);
        });
      }

      // Tell worker to forget unloaded keys.
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

      // Send generation requests (append, not replace).
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

    // ── Phase C: physics colliders around the ship ──────────────
    const ctx = colliderCtx.current;
    const frameId: FrameId = field.anchorBody && field.anchorOffsetKm && isFrameId(field.anchorBody) ? field.anchorBody : SYSTEM_FRAME_ID;
    ctx.chunks = fieldRuntime.chunks;
    ctx.frameId = frameId;
    // In its body's frame the anchor offset IS the field's position (anchorKm = body + offset).
    ctx.anchorRelKm = frameId === SYSTEM_FRAME_ID ? field.anchorKm : (field.anchorOffsetKm ?? field.anchorKm);
    ctx.shipX = px; ctx.shipY = py; ctx.shipZ = pz;
    // A body-anchored field without a frame would leave system-frame colliders behind the moving rocks.
    if (field.anchorBody && frameId === SYSTEM_FRAME_ID) {
      if (!unframedWarned.current) {
        unframedWarned.current = true;
        console.warn(`[physics] field ${field.id} is anchored to ${field.anchorBody} without a frame/anchorOffsetKm: no asteroid colliders`);
      }
    } else colliders.update(ctx);
  });

  // ── Render ──────────────────────────────────────────────────────

  // No anchor translation: the batches subtract the world origin per instance (split precision).
  return (
    <group>
      <NearTierBatch
        fieldId={field.id}
        anchorKm={field.anchorKm}
        nearRadiusKm={renderCfg.nearRadiusKm}
        modelRegistry={modelRegistry}
        allocatorsRef={allocatorsRef}
      />

      {renderCfg.midRadiusKm > 0 && modelRegistries.lod1.size > 0 && (
        <MidTierBatch
          fieldId={field.id}
          anchorKm={field.anchorKm}
          nearRadiusKm={renderCfg.nearRadiusKm}
          midRadiusKm={renderCfg.midRadiusKm}
          modelRegistry={modelRegistries.lod1}
          allocatorsRef={allocatorsRef}
        />
      )}

      {renderCfg.farRadiusKm > 0 && (
        <FarTierBatch
          fieldId={field.id}
          anchorKm={field.anchorKm}
          nearRadiusKm={renderCfg.midRadiusKm > 0 ? renderCfg.midRadiusKm : renderCfg.nearRadiusKm}
          farRadiusKm={renderCfg.farRadiusKm}
          fadeOutKm={renderCfg.crossFadeKm}
          modelRegistry={modelRegistry}
          allocatorsRef={allocatorsRef}
        />
      )}
    </group>
  );
});

FieldLayer.displayName = "FieldLayer";

// ─── AsteroidField ──────────────────────────────────────────────────

function AsteroidField() {
  const system = useAtomValue(systemConfigAtom);
  const modelDefs = useMemo(() => getSystemAsteroidModelDefs(system), [system]);
  const modelRegistries = useAsteroidModelRegistry(modelDefs);
  useEffect(() => registerColliderModels(modelRegistries), [modelRegistries]);

  const enabledFields = useMemo(
    () => (system.asteroidFields ?? []).filter((f) => f.enabled !== false),
    [system]
  );

  if (!enabledFields.length) return null;

  return (
    <>
      {enabledFields.map((field) => (
        <FieldLayer key={field.id} system={system} field={field} modelRegistries={modelRegistries} />
      ))}
    </>
  );
}

export default memo(AsteroidField);
