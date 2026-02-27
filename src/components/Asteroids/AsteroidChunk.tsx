"use client";

import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { kmToLocalUnits } from "@/sim/units";
import type { AsteroidChunkData } from "@/sim/asteroids/runtimeTypes";
import type { AsteroidModelAsset } from "@/sim/asteroids/modelRegistry";

type Props = {
  chunk: AsteroidChunkData;
  modelRegistry: Map<string, AsteroidModelAsset>;
  /** 0 = fully transparent, 1 = fully opaque (default). */
  fadeOpacity?: number;
};

type ChunkModelMeshProps = {
  instances: AsteroidChunkData["instancesByModel"][string];
  asset: AsteroidModelAsset;
  aabbSizeM: [number, number, number];
  fadeOpacity: number;
};

const tempMatrix = new THREE.Matrix4();
const tempPos = new THREE.Vector3();
const tempQuat = new THREE.Quaternion();
const tempScale = new THREE.Vector3();

const ChunkModelMesh = memo(
  ({ instances, asset, aabbSizeM, fadeOpacity }: ChunkModelMeshProps) => {
    const ref = useRef<THREE.InstancedMesh>(null!);

    // Base transform for the mesh (orientation + asset scale).
    const baseMatrix = useMemo(() => {
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          asset.baseRotationRad[0],
          asset.baseRotationRad[1],
          asset.baseRotationRad[2]
        )
      );
      const s = new THREE.Vector3(asset.baseScale, asset.baseScale, asset.baseScale);
      m.compose(new THREE.Vector3(0, 0, 0), q, s);
      return m;
    }, [asset.baseRotationRad, asset.baseScale]);

    // Fill instance matrices whenever chunk data changes.
    // useLayoutEffect so matrices are filled BEFORE the first R3F render frame,
    // preventing a 1-frame flash of all instances at origin.
    useLayoutEffect(() => {
      const mesh = ref.current;
      if (!mesh) return;

      // Hide until matrices are set — prevents the flash even if a
      // render sneaks in between mount and this effect.
      mesh.visible = false;

      const { positionsM, quaternions, radiiM, count } = instances;

      for (let i = 0; i < count; i++) {
        const pIndex = i * 3;
        const qIndex = i * 4;

        tempPos.set(
          positionsM[pIndex],
          positionsM[pIndex + 1],
          positionsM[pIndex + 2]
        );
        tempQuat.set(
          quaternions[qIndex],
          quaternions[qIndex + 1],
          quaternions[qIndex + 2],
          quaternions[qIndex + 3]
        );

        const radiusM = radiiM[i];
        const s = radiusM / asset.baseRadiusM;
        tempScale.set(s, s, s);

        tempMatrix.compose(tempPos, tempQuat, tempScale);
        tempMatrix.multiply(baseMatrix); // IMPORTANT: post-multiply, doesn't scale translation
        mesh.setMatrixAt(i, tempMatrix);
      }

      mesh.instanceMatrix.needsUpdate = true;

      // InstancedMesh frustum culling depends on a correct bounding volume.
      // Computing bounds by scanning instance matrices can be O(n) per chunk and causes
      // stutters when many chunks appear at once. Since instance positions are generated
      // in local-to-chunk space within the chunk AABB, we can set conservative bounds
      // analytically using the chunk size and the max instance radius for this model.
      const [sx, sy, sz] = aabbSizeM;
      const r = instances.maxRadiusM;

      if (!mesh.boundingBox) mesh.boundingBox = new THREE.Box3();
      mesh.boundingBox.min.set(-r, -r, -r);
      mesh.boundingBox.max.set(sx + r, sy + r, sz + r);

      const hx = sx * 0.5;
      const hy = sy * 0.5;
      const hz = sz * 0.5;

      if (!mesh.boundingSphere) mesh.boundingSphere = new THREE.Sphere();
      mesh.boundingSphere.center.set(hx, hy, hz);
      mesh.boundingSphere.radius = Math.sqrt(hx * hx + hy * hy + hz * hz) + r;

      // Matrices are ready — show the mesh.
      mesh.visible = true;
    }, [asset.baseRadiusM, baseMatrix, instances, aabbSizeM]);

    // --- Fade opacity: applied imperatively via the ref so `args` stays stable. ---
    // We keep a cloned material alongside the ref and swap it in/out as needed.
    const clonedMatRef = useRef<THREE.Material | THREE.Material[] | null>(null);

    useLayoutEffect(() => {
      const mesh = ref.current;
      if (!mesh) return;

      if (fadeOpacity >= 1) {
        // Fully opaque: restore shared material if we previously swapped.
        if (clonedMatRef.current) {
          mesh.material = asset.material;
          if (Array.isArray(clonedMatRef.current)) {
            clonedMatRef.current.forEach((m) => m.dispose());
          } else {
            clonedMatRef.current.dispose();
          }
          clonedMatRef.current = null;
        }
        return;
      }

      // Fading: clone the shared material and use alphaHash for a
      // stochastic dissolve effect. Unlike true transparency this
      // discards fragments entirely (no see-through artifacts).
      const applyFade = (mat: THREE.Material): THREE.Material => {
        const c = mat.clone();
        c.transparent = false;
        c.alphaHash = true;
        c.opacity = fadeOpacity;
        return c;
      };

      // Dispose old clone if it exists.
      if (clonedMatRef.current) {
        if (Array.isArray(clonedMatRef.current)) {
          clonedMatRef.current.forEach((m) => m.dispose());
        } else {
          clonedMatRef.current.dispose();
        }
      }

      const src = asset.material;
      if (Array.isArray(src)) {
        const cloned = src.map(applyFade);
        clonedMatRef.current = cloned;
        mesh.material = cloned;
      } else {
        const cloned = applyFade(src);
        clonedMatRef.current = cloned;
        mesh.material = cloned;
      }
    }, [fadeOpacity, asset.material]);

    // Cleanup cloned materials on unmount.
    useEffect(() => {
      return () => {
        if (clonedMatRef.current) {
          if (Array.isArray(clonedMatRef.current)) {
            clonedMatRef.current.forEach((m) => m.dispose());
          } else {
            clonedMatRef.current.dispose();
          }
          clonedMatRef.current = null;
        }
      };
    }, []);

    return (
      <instancedMesh
        ref={ref}
        args={[asset.geometry, asset.material, instances.count]}
        frustumCulled
      />
    );
  }
);

ChunkModelMesh.displayName = "ChunkModelMesh";

const AsteroidChunk = ({ chunk, modelRegistry, fadeOpacity = 1 }: Props) => {
  const groupPosition = useMemo<[number, number, number]>(() => {
    const [xKm, yKm, zKm] = chunk.originKm;
    return [kmToLocalUnits(xKm), kmToLocalUnits(yKm), kmToLocalUnits(zKm)];
  }, [chunk.originKm]);

  const aabbSizeM = useMemo<[number, number, number]>(() => {
    return [
      kmToLocalUnits(chunk.aabbMaxKm[0] - chunk.aabbMinKm[0]),
      kmToLocalUnits(chunk.aabbMaxKm[1] - chunk.aabbMinKm[1]),
      kmToLocalUnits(chunk.aabbMaxKm[2] - chunk.aabbMinKm[2]),
    ];
  }, [chunk.aabbMinKm, chunk.aabbMaxKm]);

  const modelEntries = useMemo(
    () => Object.entries(chunk.instancesByModel),
    [chunk.instancesByModel]
  );

  return (
    <group position={groupPosition}>
      {modelEntries.map(([modelId, instances]) => {
        const asset = modelRegistry.get(modelId);
        if (!asset || instances.count <= 0) return null;

        return (
          <ChunkModelMesh
            key={modelId}
            instances={instances}
            asset={asset}
            aabbSizeM={aabbSizeM}
            fadeOpacity={fadeOpacity}
          />
        );
      })}
    </group>
  );
};

export default memo(AsteroidChunk);
