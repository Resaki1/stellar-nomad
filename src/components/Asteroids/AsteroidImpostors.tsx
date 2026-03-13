"use client";

import { memo, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { NodeMaterial } from "three/webgpu";
import {
  Fn,
  uv,
  normalize,
  vec2,
  vec3,
  vec4,
  float,
  dot,
  length,
  smoothstep,
  max,
  Discard,
  attribute,
  positionGeometry,
  modelWorldMatrix,
  cameraViewMatrix,
  cameraProjectionMatrix,
} from "three/tsl";
import type { AsteroidChunkData } from "@/sim/asteroids/runtimeTypes";

/**
 * Upper bound for billboard impostor instances.
 * Unused slots are hidden via mesh.count.
 */
const MAX_IMPOSTOR_INSTANCES = 4000;

// ─── Shared buffers (filled each update, read by vertex shader) ─────
// Position (vec3) and scale (float) are packed into a single interleaved
// buffer for efficient GPU upload: [x, y, z, scale, x, y, z, scale, ...]
const STRIDE = 4; // floats per instance
const _interleavedArray = new Float32Array(MAX_IMPOSTOR_INSTANCES * STRIDE);

// ─── Component ───────────────────────────────────────────────────────

type AsteroidImpostorsProps = {
  /** Chunks to render as billboards (already filtered to far tier). */
  chunks: AsteroidChunkData[];
};

/**
 * Renders all asteroid instances from the given chunks as camera-facing
 * billboard discs in a single batched InstancedMesh.
 *
 * Used for the far LOD tier where full geometry is too expensive.
 */
const AsteroidImpostors = memo(function AsteroidImpostors({
  chunks,
}: AsteroidImpostorsProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null!);

  const material = useMemo(() => {
    const mat = new NodeMaterial();
    mat.side = THREE.FrontSide;
    mat.depthWrite = true;

    // Custom billboard vertex node for InstancedMesh.
    //
    // The built-in billboarding() uses modelWorldMatrix (a per-object
    // uniform = mesh.matrixWorld) which does NOT include per-instance
    // transforms. This causes instance offsets to be applied in
    // view-aligned space instead of world space, making impostors drift
    // with camera rotation.
    //
    // We bypass InstanceNode / positionLocal entirely and read the
    // per-instance center + scale from dedicated instanced attributes.
    // This avoids any node-ordering ambiguity between InstanceNode's
    // positionLocal.assign() and our vertexNode.
    mat.vertexNode = Fn(() => {
      const aCenter = attribute("aCenter", "vec3");
      const aScale = attribute("aScale", "float");

      // Transform instance center: local → world → view.
      const worldCenter = modelWorldMatrix.mul(vec4(aCenter, 1.0));
      const viewCenter = cameraViewMatrix.mul(worldCenter);

      // Add billboard quad offset in view space (screen-aligned).
      // positionGeometry is the raw PlaneGeometry vertex (-1..1, z=0).
      const viewPos = viewCenter.add(
        vec4(positionGeometry.xy.mul(aScale), float(0), float(0))
      );

      return cameraProjectionMatrix.mul(viewPos);
    })();

    // Fragment: circular disc with simple shading
    mat.fragmentNode = Fn(() => {
      const uvCoord = uv();
      // Map UV 0..1 → -1..1 for circular disc test
      const p = uvCoord.mul(2).sub(1);
      const dist = length(p);

      // Discard outside circle
      Discard(dist.greaterThan(1.0));

      // Soft edge
      const edge = smoothstep(float(1.0), float(0.45), dist);
      Discard(edge.lessThan(0.01));

      // Simple directional shading (light from upper-right)
      const lightDir = normalize(vec2(0.5, 0.7));
      const shade = float(0.25).add(
        float(0.35).mul(max(float(0), dot(normalize(p), lightDir)))
      );

      // Dark rocky grey
      const color = vec3(0.04, 0.04, 0.04).mul(shade);
      return vec4(color, 1.0);
    })();

    return mat;
  }, []);

  // PlaneGeometry with instanced attributes for per-billboard center + scale.
  // Using an interleaved buffer so both are uploaded in a single GPU transfer.
  const { geometry, interleavedBuffer } = useMemo(() => {
    const geo = new THREE.PlaneGeometry(2, 2);

    const ib = new THREE.InstancedInterleavedBuffer(_interleavedArray, STRIDE, 1);
    ib.setUsage(THREE.DynamicDrawUsage);

    // aCenter: vec3 at offset 0
    geo.setAttribute("aCenter", new THREE.InterleavedBufferAttribute(ib, 3, 0, false));
    // aScale: float at offset 3
    geo.setAttribute("aScale", new THREE.InterleavedBufferAttribute(ib, 1, 3, false));

    return { geometry: geo, interleavedBuffer: ib };
  }, []);

  // Flatten all chunk instances into the instanced mesh whenever the
  // chunk set changes.
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    mesh.visible = false;
    let idx = 0;

    for (const chunk of chunks) {
      // Chunk origin in field-local meters.
      const ox = chunk.originKm[0] * 1000;
      const oy = chunk.originKm[1] * 1000;
      const oz = chunk.originKm[2] * 1000;

      for (const modelId in chunk.instancesByModel) {
        const inst = chunk.instancesByModel[modelId];
        const positions = inst.positionsM;
        const radii = inst.radiiM;

        for (let i = 0; i < inst.count && idx < MAX_IMPOSTOR_INSTANCES; i++) {
          const pi = i * 3;
          const off = idx * STRIDE;

          _interleavedArray[off] = ox + positions[pi];
          _interleavedArray[off + 1] = oy + positions[pi + 1];
          _interleavedArray[off + 2] = oz + positions[pi + 2];
          // Scale down to ~40% of bounding radius → closer to the visual
          // silhouette of an irregular rocky mesh.
          _interleavedArray[off + 3] = radii[i] * 0.4;

          idx++;
        }
      }
    }

    mesh.count = idx;
    interleavedBuffer.needsUpdate = true;

    // Disable frustum culling — impostors surround the camera in a shell.
    mesh.frustumCulled = false;

    mesh.visible = idx > 0;
  }, [chunks, interleavedBuffer]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, MAX_IMPOSTOR_INSTANCES]}
      frustumCulled={false}
    />
  );
});

export default AsteroidImpostors;
