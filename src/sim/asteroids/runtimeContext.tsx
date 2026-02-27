// src/sim/asteroids/runtimeContext.tsx
"use client";

import React, { createContext, useContext, useEffect, useMemo } from "react";
import { AsteroidSystemRuntime } from "./runtime";
import { AsteroidDeltaStore } from "./persistence";

type AsteroidRuntimeContextValue = {
  runtime: AsteroidSystemRuntime;
  deltaStore: AsteroidDeltaStore;
};

const AsteroidRuntimeContext = createContext<AsteroidRuntimeContextValue | null>(null);

export const AsteroidRuntimeProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const value = useMemo(() => {
    const deltaStore = new AsteroidDeltaStore();
    deltaStore.load();
    const runtime = new AsteroidSystemRuntime(deltaStore);
    return { runtime, deltaStore };
  }, []);

  // Flush pending saves when the page is about to unload.
  useEffect(() => {
    const onBeforeUnload = () => {
      value.deltaStore.saveImmediate();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      value.deltaStore.saveImmediate();
    };
  }, [value]);

  return (
    <AsteroidRuntimeContext.Provider value={value}>
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
  return ctx.runtime;
};

export const useAsteroidDeltaStore = () => {
  const ctx = useContext(AsteroidRuntimeContext);
  if (!ctx)
    throw new Error(
      "useAsteroidDeltaStore must be used within an AsteroidRuntimeProvider"
    );
  return ctx.deltaStore;
};
