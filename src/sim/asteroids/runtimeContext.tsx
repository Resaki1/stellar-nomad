// src/sim/asteroids/runtimeContext.tsx
"use client";

import React, { createContext, useContext, useMemo } from "react";
import { AsteroidSystemRuntime } from "./runtime";

const AsteroidRuntimeContext = createContext<AsteroidSystemRuntime | null>(null);

export const AsteroidRuntimeProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const runtime = useMemo(() => new AsteroidSystemRuntime(), []);

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
