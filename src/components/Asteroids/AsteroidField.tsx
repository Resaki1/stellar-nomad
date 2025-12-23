"use client";

import { memo, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { useFrame } from "@react-three/fiber";
import SimGroup from "@/components/space/SimGroup";
import { useWorldOrigin } from "@/sim/worldOrigin";

import { systemConfigAtom } from "@/store/system";
import type { AsteroidFieldDef, SystemConfig } from "@/sim/systemTypes";
import {
  getSystemAsteroidModelDefs,
  resolveFieldGeneration,
  resolveFieldModels,
  resolveFieldRender,
  resolveFieldStreaming,
} from "@/sim/systemTypes";

import { useAsteroidModelRegistry } from "@/sim/asteroids/modelRegistry";
import {
  prepareFieldShape,
  distancePointToAabbKm,
} from "@/sim/asteroids/shapes";
import type {
  AsteroidChunkData,
  ChunkCoord,
} from "@/sim/asteroids/runtimeTypes";
import { generateAsteroidChunk } from "@/sim/asteroids/generation";
import { makeChunkKey } from "@/sim/asteroids/runtimeTypes";
import AsteroidChunk from "@/components/Asteroids/AsteroidChunk";

const UPDATE_INTERVAL_S = 0.2; // 5 Hz streaming updates
const MAX_NEW_CHUNKS_PER_TICK = 8; // prevents spikes when entering dense areas

function arraysEqual(a: string[], b: string[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function computeChunkRange(
  pKm: number,
  radiusKm: number,
  chunkSizeKm: number
): [number, number] {
  const min = Math.floor((pKm - radiusKm) / chunkSizeKm);
  const max = Math.floor((pKm + radiusKm) / chunkSizeKm);
  return [min, max];
}

type FieldLayerProps = {
  system: SystemConfig;
  field: AsteroidFieldDef;
  modelRegistry: ReturnType<typeof useAsteroidModelRegistry>;
};

const FieldLayer = memo(({ system, field, modelRegistry }: FieldLayerProps) => {
  const worldOrigin = useWorldOrigin();

  // Prepared evaluators for fast inside/intersection tests.
  const shape = useMemo(() => prepareFieldShape(field.shape), [field.shape]);

  const renderCfg = useMemo(
    () => resolveFieldRender(system, field),
    [system, field]
  );
  const streamingCfg = useMemo(
    () => resolveFieldStreaming(system, field, renderCfg.drawRadiusKm),
    [system, field, renderCfg.drawRadiusKm]
  );
  const generationCfg = useMemo(
    () => resolveFieldGeneration(system, field),
    [system, field]
  );
  const models = useMemo(
    () => resolveFieldModels(system, field),
    [system, field]
  );

  const chunkMapRef = useRef<Map<string, AsteroidChunkData>>(new Map());
  const lastRenderedKeysRef = useRef<string[]>([]);
  const timeAccRef = useRef(0);

  const [renderedChunks, setRenderedChunks] = useState<AsteroidChunkData[]>([]);

  useFrame((_, delta) => {
    timeAccRef.current += delta;
    if (timeAccRef.current < UPDATE_INTERVAL_S) return;
    timeAccRef.current = 0;

    const ship = worldOrigin.shipPosKm;

    // Player position in field-local KM coordinates (relative to the field anchor).
    const px = ship.x - field.anchorKm[0];
    const py = ship.y - field.anchorKm[1];
    const pz = ship.z - field.anchorKm[2];

    // If the player is far from the field, clear everything quickly.
    const distToFieldKm = shape.distanceToKm(px, py, pz);
    if (distToFieldKm > streamingCfg.unloadRadiusKm) {
      if (chunkMapRef.current.size > 0) chunkMapRef.current.clear();
      if (lastRenderedKeysRef.current.length > 0) {
        lastRenderedKeysRef.current = [];
        setRenderedChunks([]);
      }
      return;
    }

    // Unload chunks beyond unload radius (hysteresis).
    for (const [key, chunk] of chunkMapRef.current) {
      const d = distancePointToAabbKm(
        px,
        py,
        pz,
        chunk.aabbMinKm[0],
        chunk.aabbMinKm[1],
        chunk.aabbMinKm[2],
        chunk.aabbMaxKm[0],
        chunk.aabbMaxKm[1],
        chunk.aabbMaxKm[2]
      );
      if (d > streamingCfg.unloadRadiusKm) {
        chunkMapRef.current.delete(key);
      }
    }

    // Load missing chunks within load radius.
    const chunkSizeKm = streamingCfg.chunkSizeKm;

    const [minCx, maxCx] = computeChunkRange(
      px,
      streamingCfg.loadRadiusKm,
      chunkSizeKm
    );
    const [minCy, maxCy] = computeChunkRange(
      py,
      streamingCfg.loadRadiusKm,
      chunkSizeKm
    );
    const [minCz, maxCz] = computeChunkRange(
      pz,
      streamingCfg.loadRadiusKm,
      chunkSizeKm
    );

    // Build candidates so we can cap to maxActiveChunks deterministically by distance.
    const candidates: Array<{ coord: ChunkCoord; key: string; dist: number }> =
      [];

    for (let cx = minCx; cx <= maxCx; cx++) {
      const minX = cx * chunkSizeKm;
      const maxX = minX + chunkSizeKm;

      for (let cy = minCy; cy <= maxCy; cy++) {
        const minY = cy * chunkSizeKm;
        const maxY = minY + chunkSizeKm;

        for (let cz = minCz; cz <= maxCz; cz++) {
          const minZ = cz * chunkSizeKm;
          const maxZ = minZ + chunkSizeKm;

          // Broad phase: chunk must intersect the field shape.
          if (!shape.intersectsAabbKm(minX, minY, minZ, maxX, maxY, maxZ))
            continue;

          const dist = distancePointToAabbKm(
            px,
            py,
            pz,
            minX,
            minY,
            minZ,
            maxX,
            maxY,
            maxZ
          );
          if (dist > streamingCfg.loadRadiusKm) continue;

          const coord: ChunkCoord = { x: cx, y: cy, z: cz };
          const key = makeChunkKey(field.id, coord);

          candidates.push({ coord, key, dist });
        }
      }
    }

    candidates.sort((a, b) => a.dist - b.dist);

    // Enforce maxActiveChunks (safety cap).
    const capped = candidates.slice(0, streamingCfg.maxActiveChunks);

    let newChunksThisTick = 0;

    for (let i = 0; i < capped.length; i++) {
      const { coord, key } = capped[i];
      if (chunkMapRef.current.has(key)) continue;

      if (newChunksThisTick >= MAX_NEW_CHUNKS_PER_TICK) break;

      const chunk = generateAsteroidChunk({
        field,
        fieldId: field.id,
        models,
        shape,
        coord,
        chunkSizeKm,
        maxAsteroidsPerChunk: generationCfg.maxAsteroidsPerChunk,
      });

      chunkMapRef.current.set(key, chunk);
      newChunksThisTick++;
    }

    // Determine which chunks should be rendered (within draw radius).
    const [rMinCx, rMaxCx] = computeChunkRange(
      px,
      renderCfg.drawRadiusKm,
      chunkSizeKm
    );
    const [rMinCy, rMaxCy] = computeChunkRange(
      py,
      renderCfg.drawRadiusKm,
      chunkSizeKm
    );
    const [rMinCz, rMaxCz] = computeChunkRange(
      pz,
      renderCfg.drawRadiusKm,
      chunkSizeKm
    );

    const nextChunks: AsteroidChunkData[] = [];

    for (let cx = rMinCx; cx <= rMaxCx; cx++) {
      const minX = cx * chunkSizeKm;
      const maxX = minX + chunkSizeKm;

      for (let cy = rMinCy; cy <= rMaxCy; cy++) {
        const minY = cy * chunkSizeKm;
        const maxY = minY + chunkSizeKm;

        for (let cz = rMinCz; cz <= rMaxCz; cz++) {
          const minZ = cz * chunkSizeKm;
          const maxZ = minZ + chunkSizeKm;

          if (!shape.intersectsAabbKm(minX, minY, minZ, maxX, maxY, maxZ))
            continue;

          const dist = distancePointToAabbKm(
            px,
            py,
            pz,
            minX,
            minY,
            minZ,
            maxX,
            maxY,
            maxZ
          );
          if (dist > renderCfg.drawRadiusKm) continue;

          const coord: ChunkCoord = { x: cx, y: cy, z: cz };
          const key = makeChunkKey(field.id, coord);

          const chunk = chunkMapRef.current.get(key);
          if (chunk) nextChunks.push(chunk);
        }
      }
    }

    // Stable order helps avoid visual "popping" due to reordering.
    nextChunks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const nextKeys = nextChunks.map((c) => c.key);
    if (!arraysEqual(nextKeys, lastRenderedKeysRef.current)) {
      lastRenderedKeysRef.current = nextKeys;
      setRenderedChunks(nextChunks);
    }
  });

  // One SimGroup per field anchor (keeps world-origin updates O(fields), not O(chunks)).
  return (
    <SimGroup space="local" positionKm={field.anchorKm}>
      {renderedChunks.map((chunk) => (
        <AsteroidChunk
          key={chunk.key}
          chunk={chunk}
          modelRegistry={modelRegistry}
        />
      ))}
    </SimGroup>
  );
});

FieldLayer.displayName = "FieldLayer";

const AsteroidField = () => {
  const system = useAtomValue(systemConfigAtom) as SystemConfig;

  // Ensure we always have at least one model def, otherwise the model registry hook
  // would be called with an empty URL list.
  const modelDefs = useMemo(() => {
    const defs = getSystemAsteroidModelDefs(system);
    if (defs.length > 0) return defs;

    // Hard fallback (should not happen if sol.json is present).
    return [
      {
        id: "asteroid_01",
        src: "/models/asteroids/asteroid01.glb",
        meshName: "Daphne_LP001_1_0",
        baseScale: 0.125,
        baseRotationDeg: [-90, 0, 0] as [number, number, number],
      },
    ];
  }, [system]);

  const modelRegistry = useAsteroidModelRegistry(modelDefs);

  const enabledFields = useMemo(
    () => system.asteroidFields.filter((f) => f.enabled !== false),
    [system]
  );

  return (
    <>
      {enabledFields.map((field) => (
        <FieldLayer
          key={field.id}
          system={system}
          field={field}
          modelRegistry={modelRegistry}
        />
      ))}
    </>
  );
};

export default memo(AsteroidField);
