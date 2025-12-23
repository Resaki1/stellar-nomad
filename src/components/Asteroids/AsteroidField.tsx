"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
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
import { makeChunkKey } from "@/sim/asteroids/runtimeTypes";
import AsteroidChunk from "@/components/Asteroids/AsteroidChunk";

import type { AsteroidChunkWorkerWorkerToMainMessage } from "@/workers/asteroidChunkWorkerProtocol";

const UPDATE_INTERVAL_S = 0.2; // 5 Hz streaming updates
const MAX_NEW_CHUNKS_PER_TICK = 8; // bounds request bursts

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

  // Worker-related refs
  const workerRef = useRef<Worker | null>(null);
  const inFlightRef = useRef<Set<string>>(new Set());
  const wantedKeysRef = useRef<Set<string>>(new Set());
  const epochRef = useRef(0);

  const [renderedChunks, setRenderedChunks] = useState<AsteroidChunkData[]>([]);

  useEffect(() => {
    // Create worker (per field layer).
    const w = new Worker(
      new URL("../../workers/asteroidChunkWorker.ts", import.meta.url),
      {
        type: "module",
      }
    );
    workerRef.current = w;

    // Reset epoch on (re)init.
    epochRef.current += 1;
    const epoch = epochRef.current;

    // init worker with static field config
    w.postMessage({
      type: "init",
      fieldId: field.id,
      field,
      models,
      chunkSizeKm: streamingCfg.chunkSizeKm,
      maxAsteroidsPerChunk: generationCfg.maxAsteroidsPerChunk,
      epoch,
    });

    const onMessage = (
      ev: MessageEvent<AsteroidChunkWorkerWorkerToMainMessage>
    ) => {
      const msg = ev.data;

      if (msg.type === "error") {
        // eslint-disable-next-line no-console
        console.error("[asteroidChunkWorker]", msg.message, msg.stack);
        return;
      }

      if (msg.type !== "generated") return;
      if (msg.fieldId !== field.id) return;

      // Drop stale results.
      if (msg.epoch !== epochRef.current) return;

      const chunk = msg.chunk;

      // No longer needed? drop it to avoid growing the map with stale chunks.
      if (!wantedKeysRef.current.has(chunk.key)) {
        inFlightRef.current.delete(chunk.key);
        return;
      }

      // Accept chunk
      inFlightRef.current.delete(chunk.key);
      chunkMapRef.current.set(chunk.key, chunk);
    };

    w.addEventListener("message", onMessage);

    return () => {
      w.removeEventListener("message", onMessage);
      w.terminate();
      workerRef.current = null;

      inFlightRef.current.clear();
      wantedKeysRef.current.clear();
    };
    // field/models/config changes should re-init worker
  }, [
    field,
    models,
    streamingCfg.chunkSizeKm,
    generationCfg.maxAsteroidsPerChunk,
  ]);

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

      // Cancel in-flight/queued work with a new epoch.
      epochRef.current += 1;
      inFlightRef.current.clear();
      wantedKeysRef.current.clear();

      const w = workerRef.current;
      if (w) {
        w.postMessage({
          type: "setEpoch",
          fieldId: field.id,
          epoch: epochRef.current,
        });
      }

      return;
    }

    // Unload chunks beyond unload radius.
    chunkMapRef.current.forEach((chunk, key) => {
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
    });

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

    // Update "wanted" set for accepting/dropping worker results.
    const wanted = new Set<string>();
    for (let i = 0; i < capped.length; i++) wanted.add(capped[i].key);
    wantedKeysRef.current = wanted;

    // Request missing chunks from worker (bounded per tick)
    const w = workerRef.current;
    const epoch = epochRef.current;

    let requestedThisTick = 0;

    for (let i = 0; i < capped.length; i++) {
      const { coord, key } = capped[i];

      if (chunkMapRef.current.has(key)) continue;
      if (inFlightRef.current.has(key)) continue;

      if (requestedThisTick >= MAX_NEW_CHUNKS_PER_TICK) break;

      if (w) {
        inFlightRef.current.add(key);
        w.postMessage({ type: "generate", fieldId: field.id, coord, epoch });
        requestedThisTick++;
      }
    }

    // Determine which chunks should be rendered (within draw radius).
    // CPU win: iterate active chunks rather than scanning a full coordinate cube.
    const nextChunks: AsteroidChunkData[] = [];

    chunkMapRef.current.forEach((chunk) => {
      const dist = distancePointToAabbKm(
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
      if (dist > renderCfg.drawRadiusKm) return;
      nextChunks.push(chunk);
    });

    // Stable order helps avoid visual "popping" due to reordering.
    nextChunks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const nextKeys = nextChunks.map((c) => c.key);
    if (!arraysEqual(nextKeys, lastRenderedKeysRef.current)) {
      lastRenderedKeysRef.current = nextKeys;
      setRenderedChunks(nextChunks);
    }
  });

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
