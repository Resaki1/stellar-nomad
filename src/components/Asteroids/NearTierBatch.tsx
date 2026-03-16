"use client";

import { memo, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { AsteroidChunkData } from "@/sim/asteroids/runtimeTypes";
import type { AsteroidModelAsset } from "@/sim/asteroids/modelRegistry";

/**
 * Upper bound for instances per model in the near tier.
 * With nearRadius=32km, chunkSize=20km, density=0.004/km³:
 *   ~11 chunks × ~32 asteroids ≈ 352 total, split across models.
 * 4096 is generous headroom.
 */
const MAX_NEAR_INSTANCES = 4096;

// Reusable temporaries for matrix composition (no per-frame allocations).
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _matrix = new THREE.Matrix4();

// ─── Per-model batch ────────────────────────────────────────────────

type ModelBatchProps = {
  modelId: string;
  asset: AsteroidModelAsset;
  chunks: AsteroidChunkData[];
};

/**
 * A single stable InstancedMesh for one asteroid model type.
 * Created once, never destroyed — only instance matrices + count change.
 * This avoids the WebGPU shader build cost that occurs when new InstancedMesh
 * objects enter the scene.
 */
const ModelBatch = memo(function ModelBatch({
  modelId,
  asset,
  chunks,
}: ModelBatchProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null!);

  // Pre-compute base rotation quaternion for the asset (stable).
  const baseQuat = useMemo(() => {
    return new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        asset.baseRotationRad[0],
        asset.baseRotationRad[1],
        asset.baseRotationRad[2]
      )
    );
  }, [asset.baseRotationRad]);

  // Fill instance matrices whenever the chunk list changes.
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    mesh.visible = false;
    let idx = 0;

    const invBaseRadius = 1 / asset.baseRadiusM;

    for (const chunk of chunks) {
      const inst = chunk.instancesByModel[modelId];
      if (!inst) continue;

      const ox = chunk.originKm[0] * 1000;
      const oy = chunk.originKm[1] * 1000;
      const oz = chunk.originKm[2] * 1000;

      const { positionsM, quaternions, radiiM, count } = inst;

      for (let i = 0; i < count && idx < MAX_NEAR_INSTANCES; i++) {
        const pi = i * 3;
        const qi = i * 4;

        // Position: chunk origin (m) + instance offset (m).
        _pos.set(
          ox + positionsM[pi],
          oy + positionsM[pi + 1],
          oz + positionsM[pi + 2]
        );

        // Rotation: instance quaternion × base asset rotation.
        _quat.set(
          quaternions[qi],
          quaternions[qi + 1],
          quaternions[qi + 2],
          quaternions[qi + 3]
        );
        _quat.multiply(baseQuat);

        // Scale: (desired radius / base radius) × baseScale.
        const s = (radiiM[i] * invBaseRadius) * asset.baseScale;
        _scale.set(s, s, s);

        _matrix.compose(_pos, _quat, _scale);
        mesh.setMatrixAt(idx, _matrix);
        idx++;
      }
    }

    mesh.count = idx;
    if (idx > 0) {
      mesh.instanceMatrix.needsUpdate = true;
    }

    // Disable per-instance bounding computation — instances span the
    // entire near sphere so individual culling isn't useful.
    mesh.frustumCulled = false;
    mesh.visible = idx > 0;
  }, [chunks, modelId, asset.baseRadiusM, asset.baseScale, baseQuat]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[asset.geometry, asset.material, MAX_NEAR_INSTANCES]}
      frustumCulled={false}
    />
  );
});

ModelBatch.displayName = "ModelBatch";

// ─── NearTierBatch ──────────────────────────────────────────────────

type NearTierBatchProps = {
  chunks: AsteroidChunkData[];
  modelRegistry: Map<string, AsteroidModelAsset>;
};

/**
 * Renders all near-tier asteroid instances using one batched InstancedMesh
 * per model type. The meshes are created once and persisted — only their
 * instance data (matrices + count) changes when chunks update.
 *
 * This eliminates the WebGPU shader compilation stutter that occurred when
 * individual AsteroidChunk components mounted/unmounted (creating new
 * THREE.InstancedMesh objects that each triggered a full TSL node build).
 */
const NearTierBatch = memo(function NearTierBatch({
  chunks,
  modelRegistry,
}: NearTierBatchProps) {
  // Stable list of model IDs — only changes if modelRegistry changes
  // (which only happens on system config change, not during gameplay).
  const modelEntries = useMemo(() => {
    const entries: Array<{ id: string; asset: AsteroidModelAsset }> = [];
    modelRegistry.forEach((asset, id) => {
      entries.push({ id, asset });
    });
    return entries;
  }, [modelRegistry]);

  return (
    <>
      {modelEntries.map(({ id, asset }) => (
        <ModelBatch
          key={id}
          modelId={id}
          asset={asset}
          chunks={chunks}
        />
      ))}
    </>
  );
});

export default NearTierBatch;
