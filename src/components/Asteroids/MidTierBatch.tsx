"use client";

import { memo, useEffect, useMemo } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import type { AsteroidModelAsset } from "@/sim/asteroids/modelRegistry";
import { GpuSlotAllocator, MAX_INSTANCES_PER_MODEL } from "./GpuSlotAllocator";
import {
  createMidCullComputeNode,
  createMidCullUniforms,
  extractFrustumPlanes,
} from "./asteroidCullCompute";
import type { NearTierAllocators } from "./NearTierBatch";

/**
 * Max visible mid-tier instances per model in the output buffer.
 * Can be lower than near tier since mid-LOD covers a larger volume
 * but at lower detail — fewer instances are close enough to matter.
 */
export const MAX_MID_INSTANCES = 4096 * 32; // 131072

// ─── Per-model batch ────────────────────────────────────────────────

type MidModelBatchProps = {
  modelId: string;
  /** LOD1 (simplified) asset for this model. */
  asset: AsteroidModelAsset;
  /** Shared allocator — same instance data as near/far tiers. */
  allocator: GpuSlotAllocator;
  /** Inner distance boundary (near tier cutoff). */
  nearRadiusKm: number;
  /** Outer distance boundary (mid tier cutoff). */
  midRadiusKm: number;
};

/**
 * GPU-driven InstancedMesh with indirect draw for one asteroid model (LOD1).
 *
 * Identical to NearTierBatch's ModelBatch but uses a band-pass distance
 * filter: nearRadiusKm ≤ dist < midRadiusKm. Renders simplified geometry
 * from the LOD1 asset.
 */
const MidModelBatch = memo(function MidModelBatch({
  asset,
  allocator,
  nearRadiusKm,
  midRadiusKm,
}: MidModelBatchProps) {
  const gl = useThree((state) => state.gl);

  const baseQuat = useMemo(() => {
    return new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        asset.baseRotationRad[0],
        asset.baseRotationRad[1],
        asset.baseRotationRad[2]
      )
    );
  }, [asset.baseRotationRad]);

  const uniforms = useMemo(() => createMidCullUniforms(), []);

  const { computeNode, resetNode, outputAttr, indirectAttr } = useMemo(
    () => createMidCullComputeNode(
      allocator,
      MAX_INSTANCES_PER_MODEL,
      MAX_MID_INSTANCES,
      uniforms,
      asset.geometry.index ? asset.geometry.index.count : asset.geometry.attributes.position.count,
    ),
    [allocator, uniforms, asset.geometry]
  );

  const mesh = useMemo(() => {
    const geo = asset.geometry.clone();
    geo.setIndirect(indirectAttr, 0);

    const m = new THREE.InstancedMesh(geo, asset.material, MAX_MID_INSTANCES);
    m.instanceMatrix = outputAttr;
    m.count = MAX_MID_INSTANCES;
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
    mesh.updateWorldMatrix(true, false);

    if (allocator.highWaterMark === 0) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;

    const camWorld = state.camera.matrixWorld.elements;
    const mw = mesh.matrixWorld.elements;
    uniforms.uCameraPos.value.set(
      camWorld[12] - mw[12],
      camWorld[13] - mw[13],
      camWorld[14] - mw[14],
    );
    uniforms.uMinRadiusM.value = nearRadiusKm * 1000;
    uniforms.uMaxRadiusM.value = midRadiusKm * 1000;

    extractFrustumPlanes(state.camera, mesh.matrixWorld, uniforms.uFrustum);

    (gl as any).compute([resetNode, computeNode]);
  });

  return <primitive object={mesh} />;
});

MidModelBatch.displayName = "MidModelBatch";

// ─── MidTierBatch ───────────────────────────────────────────────────

type MidTierBatchProps = {
  nearRadiusKm: number;
  midRadiusKm: number;
  /** LOD1 model assets (simplified geometry, no textures). */
  modelRegistry: Map<string, AsteroidModelAsset>;
  /** Shared GPU allocators — same buffers as near/far tiers. */
  allocatorsRef: { readonly current: NearTierAllocators };
};

/**
 * Renders all mid-tier asteroid instances using GPU-driven indirect draw
 * with simplified LOD1 geometry. Band-pass filter: nearRadius ≤ dist < midRadius.
 */
const MidTierBatch = memo(function MidTierBatch({
  nearRadiusKm,
  midRadiusKm,
  modelRegistry,
  allocatorsRef,
}: MidTierBatchProps) {
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
        <MidModelBatch
          key={id}
          modelId={id}
          asset={asset}
          allocator={allocator}
          nearRadiusKm={nearRadiusKm}
          midRadiusKm={midRadiusKm}
        />
      ))}
    </>
  );
});

export default MidTierBatch;
