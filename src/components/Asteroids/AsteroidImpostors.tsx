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
  billboarding,
} from "three/tsl";
import type { AsteroidChunkData } from "@/sim/asteroids/runtimeTypes";

/**
 * Upper bound for billboard impostor instances.
 * Unused slots are hidden via mesh.count.
 */
const MAX_IMPOSTOR_INSTANCES = 4000;

// ─── Reusable temps ──────────────────────────────────────────────────

const _mat4 = new THREE.Matrix4();
const _scale = new THREE.Vector3();

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

    // Billboard vertex: face the camera, instance matrix provides position + scale
    mat.vertexNode = billboarding({ horizontal: true, vertical: true });

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

  // PlaneGeometry spans -1..1 so the vertex shader knows quad extents.
  const geometry = useMemo(() => new THREE.PlaneGeometry(2, 2), []);

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
          const x = ox + positions[pi];
          const y = oy + positions[pi + 1];
          const z = oz + positions[pi + 2];
          const r = radii[i];

          // Scale down to ~40% of bounding radius → closer to the visual
          // silhouette of an irregular rocky mesh.
          const visualR = r * 0.4;

          // Encode position + uniform scale in the instance matrix.
          // The billboard vertex shader extracts these and ignores rotation.
          _mat4.makeTranslation(x, y, z);
          _scale.set(visualR, visualR, visualR);
          _mat4.scale(_scale);
          mesh.setMatrixAt(idx, _mat4);
          idx++;
        }
      }
    }

    mesh.count = idx;
    mesh.instanceMatrix.needsUpdate = true;

    // Disable frustum culling — impostors surround the camera in a shell.
    mesh.frustumCulled = false;

    mesh.visible = idx > 0;
  }, [chunks]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, MAX_IMPOSTOR_INSTANCES]}
      frustumCulled={false}
    />
  );
});

export default AsteroidImpostors;
