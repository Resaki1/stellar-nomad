// src/sim/asteroids/runtimeContext.tsx
"use client";

import React, { createContext, useContext, useEffect, useMemo } from "react";
import { AsteroidSystemRuntime } from "./runtime";
import { worldAuthority } from "@/sim/world/worldAuthority";

const AsteroidRuntimeContext = createContext<AsteroidSystemRuntime | null>(null);

let activeRuntime: AsteroidSystemRuntime | null = null;

/** A loaded rock removed by an `asteroid.destroyed` event, read just before its chunk dropped it. */
export interface LoadedRockDestroyed {
  by: string;
  cause: "mined" | "collision";
  fieldId: string;
  chunkKey: string;
  instanceId: number;
  chunkOriginKm: readonly number[];
  /** Chunk-local metres. */
  localM: [number, number, number];
  radiusM: number;
}
const rockListeners = new Set<(r: LoadedRockDestroyed) => void>();

/** Rocks destroyed while loaded here (any player): the view's chance to show it happen. */
export function onLoadedRockDestroyed(fn: (r: LoadedRockDestroyed) => void): () => void {
  rockListeners.add(fn);
  return () => rockListeners.delete(fn);
}

/** The mounted runtime, for dev/test tooling outside the React tree. */
export function getActiveAsteroidRuntime(): AsteroidSystemRuntime | null {
  return activeRuntime;
}

export const AsteroidRuntimeProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const runtime = useMemo(() => new AsteroidSystemRuntime(worldAuthority.destroyedAsteroids), []);

  // Any player's accepted destroy removes the instance from what is loaded here.
  useEffect(() => {
    activeRuntime = runtime;
    const unsubscribe = worldAuthority.subscribe((e) => {
      if (e.type !== "asteroid.destroyed") return;
      const field = runtime.getFieldRuntime(e.fieldId);
      if (!field) return;
      // Read the rock before the chunk drops it (listeners place a burst there).
      let rock: LoadedRockDestroyed | null = null;
      const loc = rockListeners.size > 0 ? field.getInstanceLocation(e.chunkKey, e.instanceId) : null;
      const chunk = loc ? field.getChunk(loc.chunkKey) : undefined;
      const inst = loc && chunk ? chunk.instancesByModel[loc.modelId] : undefined;
      if (loc && chunk && inst) {
        const i = loc.localIndex;
        rock = {
          by: e.by, cause: e.cause, fieldId: e.fieldId, chunkKey: e.chunkKey, instanceId: e.instanceId, chunkOriginKm: chunk.originKm,
          localM: [inst.positionsM[i * 3], inst.positionsM[i * 3 + 1], inst.positionsM[i * 3 + 2]], radiusM: inst.radiiM[i],
        };
      }
      field.destroyInstance(e.chunkKey, e.instanceId);
      if (rock) rockListeners.forEach((l) => l(rock));
    });
    return () => {
      unsubscribe();
      if (activeRuntime === runtime) activeRuntime = null;
    };
  }, [runtime]);

  return (
    <AsteroidRuntimeContext.Provider value={runtime}>
      {children}
    </AsteroidRuntimeContext.Provider>
  );
};

export const useAsteroidRuntime = () => {
  const ctx = useContext(AsteroidRuntimeContext);
  if (!ctx)
    throw new Error(
      "useAsteroidRuntime must be used within an AsteroidRuntimeProvider"
    );
  return ctx;
};
