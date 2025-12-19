"use client";

import { ReactNode, useMemo, useRef } from "react";
import * as THREE from "three";
import { toLocalUnitsKm, toScaledUnitsKm } from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { useFrame } from "@react-three/fiber";

type SimGroupProps = {
  space: "local" | "scaled";
  positionKm: readonly [number, number, number];
  children?: ReactNode;
};

const SimGroup = ({ space, positionKm, children }: SimGroupProps) => {
  const groupRef = useRef<THREE.Group>(null!);
  const worldOrigin = useWorldOrigin();

  const cachedPosition = useMemo(() => new THREE.Vector3(), []);
  const relativeKm = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    relativeKm.set(positionKm[0], positionKm[1], positionKm[2]);
    relativeKm.sub(worldOrigin.worldOriginKm);

    if (space === "local") {
      toLocalUnitsKm(relativeKm, cachedPosition);
    } else {
      toScaledUnitsKm(relativeKm, cachedPosition);
    }

    if (groupRef.current) {
      groupRef.current.position.copy(cachedPosition);
    }
  });

  return <group ref={groupRef}>{children}</group>;
};

export default SimGroup;
