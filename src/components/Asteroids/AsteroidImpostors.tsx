"use client";

import { memo, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { AsteroidChunkData } from "@/sim/asteroids/runtimeTypes";

/**
 * Upper bound for billboard impostor instances.
 * Unused slots are hidden via mesh.count.
 */
const MAX_IMPOSTOR_INSTANCES = 4000;

// ─── Shaders ─────────────────────────────────────────────────────────

const IMPOSTOR_VS = /* glsl */ `
varying vec2 vUv;
varying float vShade;

void main() {
  vUv = uv;

  // Instance world position (model matrix includes the SimGroup offset).
  vec3 worldPos = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

  // Uniform scale encoded in the instance matrix.
  float scale = length((modelMatrix * instanceMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);

  // Billboard: align the quad to the camera using view-matrix columns.
  vec3 camRight = vec3(viewMatrix[0].x, viewMatrix[1].x, viewMatrix[2].x);
  vec3 camUp    = vec3(viewMatrix[0].y, viewMatrix[1].y, viewMatrix[2].y);

  vec3 billboardPos = worldPos
    + camRight * position.x * scale
    + camUp    * position.y * scale;

  gl_Position = projectionMatrix * viewMatrix * vec4(billboardPos, 1.0);

  // Simple directional shading (light from upper-right).
  vec2 lightDir = normalize(vec2(0.5, 0.7));
  vShade = 0.25 + 0.35 * max(0.0, dot(normalize(position.xy), lightDir));
}
`;

const IMPOSTOR_FS = /* glsl */ `
varying vec2 vUv;
varying float vShade;

void main() {
  // Map UV 0..1 → -1..1 for circular disc test.
  vec2 p = vUv * 2.0 - 1.0;
  float dist = length(p);

  if (dist > 1.0) discard;

  // Soft edge.
  float edge = smoothstep(1.0, 0.45, dist);
  if (edge < 0.01) discard;

  // Dark rocky grey to blend with space background.
  vec3 color = vec3(0.04, 0.04, 0.04) * vShade;

  gl_FragColor = vec4(color, 1.0);
}
`;

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

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: IMPOSTOR_VS,
        fragmentShader: IMPOSTOR_FS,
        side: THREE.DoubleSide,
        depthWrite: true,
        depthTest: true,
      }),
    []
  );

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
