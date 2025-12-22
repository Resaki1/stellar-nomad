"use client";

import React, { createContext, useCallback, useContext, useMemo, useRef } from "react";
import * as THREE from "three";

const RECENTER_THRESHOLD_KM = 10_000;

type WorldOriginContextValue = {
  worldOriginKm: THREE.Vector3;
  shipPosKm: THREE.Vector3;
  setShipPosKm: (pos: THREE.Vector3) => void;
  setWorldOriginKm: (pos: THREE.Vector3) => void;
  maybeRecenter: (shipPosKm: THREE.Vector3) => void;
  recenterThresholdKm: number;
};

const WorldOriginContext = createContext<WorldOriginContextValue | null>(null);

export const WorldOriginProvider = ({ children }: { children: React.ReactNode }) => {
  const worldOriginRef = useRef(new THREE.Vector3());
  const shipPosRef = useRef(new THREE.Vector3());

  const setWorldOriginKm = useCallback((pos: THREE.Vector3) => {
    worldOriginRef.current.copy(pos);
  }, []);

  const setShipPosKm = useCallback((pos: THREE.Vector3) => {
    shipPosRef.current.copy(pos);
  }, []);

  const maybeRecenter = useCallback(
    (shipPosKm: THREE.Vector3) => {
      if (shipPosKm.distanceTo(worldOriginRef.current) > RECENTER_THRESHOLD_KM) {
        setWorldOriginKm(shipPosKm);
      }
    },
    [setWorldOriginKm]
  );

  const value = useMemo(
    () => ({
      worldOriginKm: worldOriginRef.current,
      shipPosKm: shipPosRef.current,
      setShipPosKm,
      setWorldOriginKm,
      maybeRecenter,
      recenterThresholdKm: RECENTER_THRESHOLD_KM,
    }),
    [maybeRecenter, setShipPosKm, setWorldOriginKm]
  );

  return <WorldOriginContext.Provider value={value}>{children}</WorldOriginContext.Provider>;
};

export const useWorldOrigin = () => {
  const ctx = useContext(WorldOriginContext);
  if (!ctx) throw new Error("useWorldOrigin must be used within a WorldOriginProvider");
  return ctx;
};

