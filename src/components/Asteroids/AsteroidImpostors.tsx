"use client";

import { memo, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
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
  attribute,
  uniform,
  positionGeometry,
  modelWorldMatrix,
  cameraViewMatrix,
  cameraProjectionMatrix,
} from "three/tsl";
import { STAR_POSITION_KM } from "@/components/Star/Star";
import { useWorldOrigin } from "@/sim/worldOrigin";
import type { AsteroidChunkData } from "@/sim/asteroids/runtimeTypes";

/**
 * Upper bound for billboard impostor instances.
 * Unused slots are hidden via mesh.count.
 */
const MAX_IMPOSTOR_INSTANCES = 80_000;

// Floats per instance: vec3 center + float scale = 4
const STRIDE = 4;

// Reusable temp for computing sun direction each frame.
const _sunDir = new THREE.Vector3();

// ─── Component ───────────────────────────────────────────────────────

type AsteroidImpostorsProps = {
  /** Chunks to render as billboards (already filtered to far tier). */
  chunks: AsteroidChunkData[];
  /** Far-tier draw radius in km — impostors fade out approaching this. */
  farRadiusKm: number;
  /** Width of the fade-out zone at the far boundary (km). */
  fadeOutKm: number;
};

/**
 * Renders all asteroid instances from the given chunks as camera-facing
 * billboard discs in a single batched InstancedMesh.
 *
 * Used for the far LOD tier where full geometry is too expensive.
 */
const AsteroidImpostors = memo(function AsteroidImpostors({
  chunks,
  farRadiusKm,
  fadeOutKm,
}: AsteroidImpostorsProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const worldOrigin = useWorldOrigin();

  // Per-instance interleaved buffer: [x, y, z, scale, ...] — owned by
  // this component instance so multiple asteroid fields don't collide.
  const { geometry, interleavedBuffer, interleavedArray } = useMemo(() => {
    const arr = new Float32Array(MAX_IMPOSTOR_INSTANCES * STRIDE);
    const geo = new THREE.PlaneGeometry(2, 2);

    const ib = new THREE.InstancedInterleavedBuffer(arr, STRIDE, 1);
    ib.setUsage(THREE.DynamicDrawUsage);

    geo.setAttribute("aCenter", new THREE.InterleavedBufferAttribute(ib, 3, 0, false));
    geo.setAttribute("aScale", new THREE.InterleavedBufferAttribute(ib, 1, 3, false));

    return { geometry: geo, interleavedBuffer: ib, interleavedArray: arr };
  }, []);

  // TSL uniform for the world-space sun direction, updated per frame.
  const uSunDir = useMemo(() => uniform(new THREE.Vector3(0, 1, 0)), []);

  // TSL uniforms for distance fade (far boundary).
  const uFadeStart = useMemo(() => uniform(0), []);
  const uFadeEnd = useMemo(() => uniform(0), []);

  const material = useMemo(() => {
    const mat = new NodeMaterial();
    mat.side = THREE.FrontSide;
    mat.depthWrite = true;
    mat.transparent = false;
    mat.alphaHash = true;

    // ── Shared attribute nodes ─────────────────────────────────────
    // Instanced attributes are vertex-only in WebGPU. Any value the
    // fragment shader needs must be forwarded as a varying.
    const aCenter = attribute("aCenter", "vec3");
    const aScale = attribute("aScale", "float");

    // Distance from field origin → fragment needs it for the fade.
    const vCenterDist = length(aCenter).toVarying("v_centerDist");

    // ── Vertex: custom billboard for InstancedMesh ──────────────
    //
    // The built-in billboarding() uses modelWorldMatrix (a per-object
    // uniform = mesh.matrixWorld) which does NOT include per-instance
    // transforms. We bypass InstanceNode entirely and read per-instance
    // center + scale from dedicated instanced attributes.
    mat.vertexNode = Fn(() => {
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

    // ── Fragment: circular disc with world-space shading + fade ──
    mat.fragmentNode = Fn(() => {
      const uvCoord = uv();
      // Map UV 0..1 → -1..1 for circular disc test
      const p = uvCoord.mul(2).sub(1);
      const dist = length(p);

      // Soft circular edge — single smoothstep covers both disc cutoff
      // and the anti-aliased rim.
      const edge = smoothstep(float(1.0), float(0.45), dist);
      Discard(edge.lessThan(0.01));

      // World-space directional shading: project the sun direction onto
      // the billboard's implicit normal hemisphere.
      //
      // The billboard faces the camera, so we treat `p` as a tangent-
      // space direction on a virtual hemisphere. We construct a pseudo-
      // normal by combining the 2D position with a dome height and dot
      // it against the sun direction (already in world space — close
      // enough for distant dots).
      const domeZ = float(1.0).sub(dist.mul(dist)).max(0).sqrt();
      const pseudoNormal = normalize(vec3(p.x, p.y, domeZ));
      const sunDot = max(float(0), dot(pseudoNormal, uSunDir));
      const shade = float(0.15).add(float(0.45).mul(sunDot));

      // Dark rocky grey
      const color = vec3(0.04, 0.04, 0.04).mul(shade);

      // Distance fade via alphaHash: opacity ramps 1→0 over the fade zone.
      // vCenterDist is a varying computed in the vertex stage from the
      // instanced aCenter attribute (not directly readable in fragment).
      const opacity = edge.mul(
        float(1.0).sub(smoothstep(uFadeStart, uFadeEnd, vCenterDist))
      );

      return vec4(color, opacity);
    })();

    return mat;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uSunDir, uFadeStart, uFadeEnd]);

  // Update sun direction + fade uniforms each frame.
  useFrame(() => {
    // Sun direction in field-local space: sun position minus field anchor
    // (the SimGroup puts us at the field anchor). The impostor positions
    // are in field-local meters, but for a directional light the position
    // is so far away that we can just normalize the km-scale vector.
    _sunDir.set(STAR_POSITION_KM[0], STAR_POSITION_KM[1], STAR_POSITION_KM[2]);
    // Subtract world origin so the direction is relative to the render
    // origin, matching what the camera sees.
    _sunDir.sub(worldOrigin.worldOriginKm);
    _sunDir.normalize();
    uSunDir.value.copy(_sunDir);

    // Fade zone in meters (field-local, matching aCenter units).
    const fadeEnd = farRadiusKm * 1000;
    const fadeStart = Math.max(0, fadeEnd - fadeOutKm * 1000);
    uFadeStart.value = fadeStart;
    uFadeEnd.value = fadeEnd;
  });

  // Fill instance buffers when chunks change.
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    mesh.visible = false;
    let idx = 0;

    for (const chunk of chunks) {
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

          interleavedArray[off] = ox + positions[pi];
          interleavedArray[off + 1] = oy + positions[pi + 1];
          interleavedArray[off + 2] = oz + positions[pi + 2];
          // Scale down to ~40% of bounding radius → closer to the visual
          // silhouette of an irregular rocky mesh.
          interleavedArray[off + 3] = radii[i] * 0.4;

          idx++;
        }
      }
    }

    mesh.count = idx;
    interleavedBuffer.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.visible = idx > 0;
  }, [chunks, interleavedBuffer, interleavedArray]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, MAX_IMPOSTOR_INSTANCES]}
      frustumCulled={false}
    />
  );
});

export default AsteroidImpostors;
