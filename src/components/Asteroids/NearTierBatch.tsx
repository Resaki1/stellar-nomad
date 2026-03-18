"use client";

import { memo, useEffect, useMemo } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import type { AsteroidModelAsset } from "@/sim/asteroids/modelRegistry";
import { GpuSlotAllocator } from "./GpuSlotAllocator";
import {
  createCullComputeNode,
  createCullUniforms,
  extractFrustumPlanes,
} from "./asteroidCullCompute";

/**
 * Upper bound for instances per model in the near tier.
 * GPU-resident with indirect draw — only visible instances reach the vertex shader.
 */
export const MAX_NEAR_INSTANCES = 4096 * 32;

// ─── Per-model batch ────────────────────────────────────────────────

type ModelBatchProps = {
  modelId: string;
  asset: AsteroidModelAsset;
  allocator: GpuSlotAllocator;
  nearRadiusKm: number;
};

/**
 * GPU-driven InstancedMesh with indirect draw for one asteroid model.
 *
 * A compute shader runs every frame: tests each instance for visibility
 * (alive + distance + frustum), compacts visible ones to the front of
 * the output buffer via atomic counter, and writes the visible count
 * to an indirect draw argument buffer.
 *
 * drawIndexedIndirect reads the count from the GPU — invisible instances
 * never enter the vertex shader. Zero wasted vertex processing.
 */
const ModelBatch = memo(function ModelBatch({
  asset,
  allocator,
  nearRadiusKm,
}: ModelBatchProps) {
  const gl = useThree((state) => state.gl);

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

  // Create uniforms and compute node (once).
  const uniforms = useMemo(() => createCullUniforms(), []);

  const { computeNode, resetNode, outputAttr, indirectAttr } = useMemo(
    () => createCullComputeNode(
      allocator,
      MAX_NEAR_INSTANCES,
      uniforms,
      asset.geometry.index ? asset.geometry.index.count : asset.geometry.attributes.position.count,
    ),
    [allocator, uniforms, asset.geometry]
  );

  // Create the InstancedMesh imperatively:
  // - StorageInstancedBufferAttribute as instanceMatrix (compute writes to it)
  // - IndirectStorageBufferAttribute on geometry (GPU sets instance count)
  const mesh = useMemo(() => {
    // Clone geometry so setIndirect doesn't affect other users.
    const geo = asset.geometry.clone();
    geo.setIndirect(indirectAttr, 0);

    const m = new THREE.InstancedMesh(geo, asset.material, MAX_NEAR_INSTANCES);
    m.instanceMatrix = outputAttr;
    m.count = MAX_NEAR_INSTANCES; // Needed for three.js internals; actual count comes from indirect
    m.frustumCulled = false;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.geometry, asset.material, outputAttr, indirectAttr]);

  // Set stable model uniforms once.
  useEffect(() => {
    uniforms.uBaseQuat.value.set(baseQuat.x, baseQuat.y, baseQuat.z, baseQuat.w);
    uniforms.uInvBaseRadius.value = 1 / asset.baseRadiusM;
    uniforms.uBaseScale.value = asset.baseScale;
  }, [uniforms, baseQuat, asset.baseRadiusM, asset.baseScale]);

  useFrame((state) => {
    // Ensure matrixWorld is up to date (parent SimGroup sets position in useFrame).
    mesh.updateWorldMatrix(true, false);

    // Skip compute if no instances are allocated.
    if (allocator.highWaterMark === 0) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;

    // Update per-frame uniforms.
    const camWorld = state.camera.matrixWorld.elements;
    const mw = mesh.matrixWorld.elements;
    uniforms.uCameraPos.value.set(
      camWorld[12] - mw[12],
      camWorld[13] - mw[13],
      camWorld[14] - mw[14],
    );
    uniforms.uNearRadiusM.value = nearRadiusKm * 1000;

    // Extract frustum planes in field-local space.
    extractFrustumPlanes(state.camera, mesh.matrixWorld, uniforms.uFrustum);

    // Dispatch compute: reset atomic counter on GPU, then cull + compact.
    // Both run on GPU — no CPU→GPU race from needsUpdate.
    (gl as any).compute([resetNode, computeNode]);
  });

  return <primitive object={mesh} />;
});

ModelBatch.displayName = "ModelBatch";

// ─── NearTierBatch ──────────────────────────────────────────────────

export type NearTierAllocators = Map<string, GpuSlotAllocator>;

type NearTierBatchProps = {
  nearRadiusKm: number;
  modelRegistry: Map<string, AsteroidModelAsset>;
  allocatorsRef: { readonly current: NearTierAllocators };
};

/**
 * Renders all near-tier asteroid instances using GPU-driven indirect draw.
 *
 * Per frame:
 * - Compute shader tests all allocated instances (frustum + distance)
 * - Visible instances are compacted to the front of the output buffer
 * - Atomic counter writes the visible count to an indirect draw argument buffer
 * - drawIndexedIndirect renders ONLY visible instances — zero wasted vertex work
 *
 * CPU per-frame cost: ~120 bytes of uniforms + 20 bytes indirect reset.
 */
const NearTierBatch = memo(function NearTierBatch({
  nearRadiusKm,
  modelRegistry,
  allocatorsRef,
}: NearTierBatchProps) {
  const modelEntries = useMemo(() => {
    const entries: Array<{ id: string; asset: AsteroidModelAsset; allocator: GpuSlotAllocator }> = [];
    modelRegistry.forEach((asset, id) => {
      const allocator = allocatorsRef.current.get(id);
      if (allocator) {
        entries.push({ id, asset, allocator });
      }
    });
    return entries;
  }, [modelRegistry, allocatorsRef]);

  return (
    <>
      {modelEntries.map(({ id, asset, allocator }) => (
        <ModelBatch
          key={id}
          modelId={id}
          asset={asset}
          allocator={allocator}
          nearRadiusKm={nearRadiusKm}
        />
      ))}
    </>
  );
});

export default NearTierBatch;
