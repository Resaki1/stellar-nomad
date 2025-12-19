"use client";

import React, { createContext, useCallback, useContext, useMemo, useRef } from "react";
import * as THREE from "three";

const RECENTER_THRESHOLD_KM = 150;
const RECENTER_MAX_STEP_KM_PER_S = 500; // follow the ship smoothly without large jumps

type WorldOriginContextValue = {
  worldOriginKm: THREE.Vector3;
  shipPosKm: THREE.Vector3;
  setShipPosKm: (pos: THREE.Vector3) => void;
  setWorldOriginKm: (pos: THREE.Vector3) => void;
  maybeRecenter: (shipPosKm: THREE.Vector3, delta: number) => void;
  recenterThresholdKm: number;
};

const WorldOriginContext = createContext<WorldOriginContextValue | null>(null);

export const WorldOriginProvider = ({ children }: { children: React.ReactNode }) => {
  const worldOriginRef = useRef(new THREE.Vector3());
  const shipPosRef = useRef(new THREE.Vector3());
  const tempDirection = useRef(new THREE.Vector3());

  const setWorldOriginKm = useCallback((pos: THREE.Vector3) => {
    worldOriginRef.current.copy(pos);
  }, []);

  const setShipPosKm = useCallback((pos: THREE.Vector3) => {
    shipPosRef.current.copy(pos);
  }, []);

  const maybeRecenter = useCallback(
    (shipPosKm: THREE.Vector3, delta: number) => {
      const offset = shipPosKm.distanceTo(worldOriginRef.current);

      if (offset <= RECENTER_THRESHOLD_KM) return;

      const maxStep = Math.max(RECENTER_MAX_STEP_KM_PER_S * delta, 0);
      const desired = offset - RECENTER_THRESHOLD_KM;
      const step = Math.min(desired, maxStep);

      if (step <= 0) return;

      tempDirection.current
        .copy(shipPosKm)
        .sub(worldOriginRef.current)
        .normalize();

      worldOriginRef.current.addScaledVector(tempDirection.current, step);
    },
    []
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

