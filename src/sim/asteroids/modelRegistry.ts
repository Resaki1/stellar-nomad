"use client";

import { useLoader } from "@react-three/fiber";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import * as THREE from "three";
import { useMemo } from "react";
import type { GLTF } from "three-stdlib";
import type { AsteroidModelDef } from "@/sim/systemTypes";

export type AsteroidModelAsset = {
  id: string;
  src: string;

  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];

  /**
   * Mesh-level transform applied to all instances.
   */
  baseScale: number;
  baseRotationRad: [number, number, number];

  /**
   * Bounding-sphere radius of the geometry after applying baseScale, in meters (local units).
   * Used to convert desired radius (m) into per-instance scale factor.
   */
  baseRadiusM: number;
};

function findMesh(scene: THREE.Object3D, meshName?: string): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;

  if (meshName) {
    scene.traverse((obj) => {
      if (found) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyObj = obj as any;
      if (obj.name === meshName && anyObj.isMesh) {
        found = obj as THREE.Mesh;
      }
    });
    if (found) return found;
  }

  // Fallback: first mesh in the scene
  scene.traverse((obj) => {
    if (found) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyObj = obj as any;
    if (anyObj.isMesh) {
      found = obj as THREE.Mesh;
    }
  });

  return found;
}

/**
 * Draco decoder setup:
 * - Default uses Google's hosted Draco decoders (no extra files needed).
 * - If you prefer hosting locally, see instructions below and change decoderPath to "/draco/".
 */
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("https://www.gstatic.com/draco/v1/decoders/");

export function useAsteroidModelRegistry(modelDefs: AsteroidModelDef[]) {
  const urls = useMemo(() => modelDefs.map((m) => m.src), [modelDefs]);

  // When `urls` is an array, useLoader returns an array of results in the same order.
  const gltfs = useLoader(
    GLTFLoader,
    urls,
    // Important: attach DRACOLoader so Draco-compressed GLBs can load.
    (loader) => {
      const gltfLoader = loader as GLTFLoader;
      gltfLoader.setDRACOLoader(dracoLoader);
    }
  ) as unknown as GLTF[];

  return useMemo(() => {
    const map = new Map<string, AsteroidModelAsset>();

    for (let i = 0; i < modelDefs.length; i++) {
      const def = modelDefs[i];
      const gltf = gltfs[i];

      const mesh = findMesh(gltf.scene, def.meshName);

      if (!mesh) {
        // Non-fatal: skip missing assets so the app still runs.
        // eslint-disable-next-line no-console
        console.warn(`[Asteroids] Could not find a Mesh in GLB: ${def.src}`);
        continue;
      }

      const geometry = mesh.geometry;
      const material = mesh.material;

      const baseScale = typeof def.baseScale === "number" ? def.baseScale : 1.0;

      const rotDeg = def.baseRotationDeg ?? [0, 0, 0];
      const baseRotationRad: [number, number, number] = [
        THREE.MathUtils.degToRad(rotDeg[0]),
        THREE.MathUtils.degToRad(rotDeg[1]),
        THREE.MathUtils.degToRad(rotDeg[2]),
      ];

      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const geomRadius = geometry.boundingSphere?.radius ?? 1.0;

      const baseRadiusM = Math.max(0.0001, geomRadius * baseScale);

      map.set(def.id, {
        id: def.id,
        src: def.src,
        geometry,
        material,
        baseScale,
        baseRotationRad,
        baseRadiusM,
      });
    }

    return map;
  }, [gltfs, modelDefs]);
}
