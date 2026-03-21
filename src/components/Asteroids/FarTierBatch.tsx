"use client";

import { memo, useEffect, useMemo } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  uv,
  normalize,
  vec3,
  vec4,
  float,
  dot,
  length,
  smoothstep,
  max,
  Discard,
  uniform,
  positionGeometry,
  modelWorldMatrix,
  cameraViewMatrix,
  cameraProjectionMatrix,
  attribute,
} from "three/tsl";

import { STAR_POSITION_KM } from "@/components/Star/Star";
import { useWorldOrigin } from "@/sim/worldOrigin";
import type { AsteroidModelAsset } from "@/sim/asteroids/modelRegistry";
import type { NearTierAllocators } from "./NearTierBatch";
import { GpuSlotAllocator, MAX_INSTANCES_PER_MODEL } from "./GpuSlotAllocator";
import {
  createFarCullComputeNode,
  createFarCullUniforms,
  extractFrustumPlanes,
} from "./asteroidCullCompute";

/** Max visible far-tier instances per model in the output buffer. */
const MAX_FAR_VISIBLE = 4096 * 32; // 131072

// Reusable temp for sun direction.
const _sunDir = new THREE.Vector3();

// ─── Per-model batch ────────────────────────────────────────────────

type FarModelBatchProps = {
  allocator: GpuSlotAllocator;
  nearRadiusKm: number;
  farRadiusKm: number;
  fadeOutKm: number;
};

/**
 * GPU-driven billboard impostor batch for one asteroid model type.
 *
 * A compute shader runs every frame: band-pass distance filter
 * (nearRadius ≤ dist < farRadius) + frustum cull, compacts visible
 * instances into the output buffer. drawIndexedIndirect renders only
 * the surviving billboards. Zero CPU per-frame instance management.
 */
const FarModelBatch = memo(function FarModelBatch({
  allocator,
  nearRadiusKm,
  farRadiusKm,
  fadeOutKm,
}: FarModelBatchProps) {
  const gl = useThree((state) => state.gl);
  const worldOrigin = useWorldOrigin();

  // Compute uniforms.
  const uniforms = useMemo(() => createFarCullUniforms(), []);

  const { computeNode, resetNode, outputAttr, indirectAttr } = useMemo(
    () => createFarCullComputeNode(
      allocator,
      MAX_INSTANCES_PER_MODEL,
      MAX_FAR_VISIBLE,
      uniforms,
    ),
    [allocator, uniforms]
  );

  // Material uniforms for the billboard shader.
  const uSunDir = useMemo(() => uniform(new THREE.Vector3(0, 1, 0)), []);
  const uFadeStart = useMemo(() => uniform(0), []);
  const uFadeEnd = useMemo(() => uniform(0), []);

  const material = useMemo(() => {
    const mat = new NodeMaterial();
    mat.side = THREE.FrontSide;
    mat.depthWrite = true;
    mat.transparent = false;
    mat.alphaHash = true;

    // Read per-instance data from compute output via named attribute.
    // Compute writes vec4(pos.xyz, radius) per visible instance.
    const aFarData = attribute("aFarData", "vec4");
    const aCenter = aFarData.xyz;
    const aScale = aFarData.w.mul(float(0.4)); // visual scale factor

    // Distance from field origin for fragment fade (must be a varying).
    const vCenterDist = length(aCenter).toVarying("v_centerDist");

    // ── Vertex: camera-facing billboard ──────────────────────────
    mat.vertexNode = Fn(() => {
      const worldCenter = modelWorldMatrix.mul(vec4(aCenter, 1.0));
      const viewCenter = cameraViewMatrix.mul(worldCenter);
      const viewPos = viewCenter.add(
        vec4(positionGeometry.xy.mul(aScale), float(0), float(0))
      );
      return cameraProjectionMatrix.mul(viewPos);
    })();

    // ── Fragment: circular disc + hemisphere shading + fade ──────
    mat.fragmentNode = Fn(() => {
      const uvCoord = uv();
      const p = uvCoord.mul(2).sub(1);
      const dist = length(p);

      const edge = smoothstep(float(1.0), float(0.45), dist);
      Discard(edge.lessThan(0.01));

      // Hemisphere shading with view-space sun direction.
      const domeZ = float(1.0).sub(dist.mul(dist)).max(0).sqrt();
      const pseudoNormal = normalize(vec3(p.x, p.y, domeZ));
      const viewSunDir = normalize(cameraViewMatrix.mul(vec4(uSunDir, float(0))).xyz);
      const sunDot = max(float(0), dot(pseudoNormal, viewSunDir));
      const shade = float(0.15).add(float(8.0).mul(sunDot));
      const color = vec3(0.1, 0.1, 0.1).mul(shade);

      // Distance fade at far boundary.
      const opacity = edge.mul(
        float(1.0).sub(smoothstep(uFadeStart, uFadeEnd, vCenterDist))
      );

      return vec4(color, opacity);
    })();

    return mat;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputAttr, uSunDir, uFadeStart, uFadeEnd]);

  // Create InstancedMesh with compute output as a named geometry attribute.
  // The custom vertexNode reads "aFarData" for billboard positioning.
  // instanceMatrix is left as the default (identity) — never read by our shader.
  const mesh = useMemo(() => {
    const geo = new THREE.PlaneGeometry(2, 2);
    geo.setAttribute("aFarData", outputAttr);
    geo.setIndirect(indirectAttr, 0);

    const m = new THREE.InstancedMesh(geo, material, MAX_FAR_VISIBLE);
    m.count = MAX_FAR_VISIBLE;
    m.frustumCulled = false;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [material, outputAttr, indirectAttr]);

  // Set stable uniforms once.
  useEffect(() => {
    const fadeEnd = farRadiusKm * 1000;
    const fadeStart = Math.max(0, fadeEnd - fadeOutKm * 1000);
    uFadeStart.value = fadeStart;
    uFadeEnd.value = fadeEnd;
  }, [farRadiusKm, fadeOutKm, uFadeStart, uFadeEnd]);

  useFrame((state) => {
    mesh.updateWorldMatrix(true, false);

    if (allocator.highWaterMark === 0) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;

    // Per-frame uniforms.
    const camWorld = state.camera.matrixWorld.elements;
    const mw = mesh.matrixWorld.elements;
    uniforms.uCameraPos.value.set(
      camWorld[12] - mw[12],
      camWorld[13] - mw[13],
      camWorld[14] - mw[14],
    );
    uniforms.uNearRadiusM.value = nearRadiusKm * 1000;
    uniforms.uFarRadiusM.value = farRadiusKm * 1000;

    extractFrustumPlanes(state.camera, mesh.matrixWorld, uniforms.uFrustum);

    // Sun direction in field-local space.
    _sunDir.set(STAR_POSITION_KM[0], STAR_POSITION_KM[1], STAR_POSITION_KM[2]);
    _sunDir.sub(worldOrigin.worldOriginKm);
    _sunDir.normalize();
    uSunDir.value.copy(_sunDir);

    (gl as any).compute([resetNode, computeNode]);
  });

  return <primitive object={mesh} />;
});

FarModelBatch.displayName = "FarModelBatch";

// ─── FarTierBatch ───────────────────────────────────────────────────

type FarTierBatchProps = {
  nearRadiusKm: number;
  farRadiusKm: number;
  fadeOutKm: number;
  modelRegistry: Map<string, AsteroidModelAsset>;
  allocatorsRef: { readonly current: NearTierAllocators };
};

/**
 * GPU-driven far tier: one billboard impostor batch per model type.
 * Mirrors NearTierBatch but renders camera-facing discs instead of
 * 3D meshes, with a band-pass distance filter [nearRadius, farRadius).
 */
const FarTierBatch = memo(function FarTierBatch({
  nearRadiusKm,
  farRadiusKm,
  fadeOutKm,
  modelRegistry,
  allocatorsRef,
}: FarTierBatchProps) {
  const entries = useMemo(() => {
    const result: Array<{ id: string; allocator: GpuSlotAllocator }> = [];
    modelRegistry.forEach((_asset, id) => {
      const allocator = allocatorsRef.current.get(id);
      if (allocator) {
        result.push({ id, allocator });
      }
    });
    return result;
  }, [modelRegistry, allocatorsRef]);

  return (
    <>
      {entries.map(({ id, allocator }) => (
        <FarModelBatch
          key={id}
          allocator={allocator}
          nearRadiusKm={nearRadiusKm}
          farRadiusKm={farRadiusKm}
          fadeOutKm={fadeOutKm}
        />
      ))}
    </>
  );
});

export default FarTierBatch;
