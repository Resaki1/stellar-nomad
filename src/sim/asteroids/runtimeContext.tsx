// src/sim/asteroids/runtimeContext.tsx
"use client";

import React, { createContext, useContext, useEffect, useMemo } from "react";
import { AsteroidSystemRuntime } from "./runtime";
import { worldAuthority } from "@/sim/world/worldAuthority";

const AsteroidRuntimeContext = createContext<AsteroidSystemRuntime | null>(null);

let activeRuntime: AsteroidSystemRuntime | null = null;

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
      runtime.getFieldRuntime(e.fieldId)?.destroyInstance(e.instanceId);
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
