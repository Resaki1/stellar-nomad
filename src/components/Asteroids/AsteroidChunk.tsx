"use client";

import { memo, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { kmToLocalUnits } from "@/sim/units";
import type { AsteroidChunkData } from "@/sim/asteroids/runtimeTypes";
import type { AsteroidModelAsset } from "@/sim/asteroids/modelRegistry";

type Props = {
  chunk: AsteroidChunkData;
  modelRegistry: Map<string, AsteroidModelAsset>;
};

type ChunkModelMeshProps = {
  instances: AsteroidChunkData["instancesByModel"][string];
  asset: AsteroidModelAsset;
};

const tempMatrix = new THREE.Matrix4();
const tempPos = new THREE.Vector3();
const tempQuat = new THREE.Quaternion();
const tempScale = new THREE.Vector3();

const ChunkModelMesh = memo(({ instances, asset }: ChunkModelMeshProps) => {
  const ref = useRef<THREE.InstancedMesh>(null!);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;

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
      mesh.setMatrixAt(i, tempMatrix);
    }

    mesh.instanceMatrix.needsUpdate = true;

    // Important: InstancedMesh culling depends on a correct bounds computation.
    // computeBoundingSphere accounts for instance matrices in modern three versions.
    mesh.computeBoundingSphere();
    mesh.computeBoundingBox();
  }, [asset.baseRadiusM, instances]);

  const rotation = asset.baseRotationRad;
  const scale = asset.baseScale;

  return (
    <instancedMesh
      ref={ref}
      args={[asset.geometry, asset.material, instances.count]}
      rotation={rotation}
      scale={scale}
      frustumCulled
    />
  );
});

ChunkModelMesh.displayName = "ChunkModelMesh";

const AsteroidChunk = ({ chunk, modelRegistry }: Props) => {
  const groupPosition = useMemo<[number, number, number]>(() => {
    const [xKm, yKm, zKm] = chunk.originKm;
    return [kmToLocalUnits(xKm), kmToLocalUnits(yKm), kmToLocalUnits(zKm)];
  }, [chunk.originKm]);

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
          <ChunkModelMesh key={modelId} instances={instances} asset={asset} />
        );
      })}
    </group>
  );
};

export default memo(AsteroidChunk);
