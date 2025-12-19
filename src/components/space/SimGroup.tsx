"use client";

import { useEffect, useRef } from "react";
import { Group, Vector3 } from "three";

import { Vector3Like, asVector3, toLocalUnitsKm, toScaledUnitsKm } from "@/sim/units";
import { useWorldOriginKm } from "@/sim/worldOrigin";

export type SimGroupProps = {
  space: "local" | "scaled";
  positionKm: Vector3Like;
  children?: React.ReactNode;
};

const SimGroup = ({ space, positionKm, children }: SimGroupProps) => {
  const groupRef = useRef<Group>(null!);
  const originVec = useRef(new Vector3());
  const positionVec = useRef(new Vector3());
  const relativeKm = useRef(new Vector3());
  const worldUnits = useRef(new Vector3());
  const worldOrigin = useWorldOriginKm();

  useEffect(() => {
    asVector3(positionKm, positionVec.current);
  }, [positionKm]);

  useEffect(() => {
    originVec.current.set(worldOrigin[0], worldOrigin[1], worldOrigin[2]);
    relativeKm.current.copy(positionVec.current).sub(originVec.current);

    if (space === "local") {
      toLocalUnitsKm(relativeKm.current, worldUnits.current);
    } else {
      toScaledUnitsKm(relativeKm.current, worldUnits.current);
    }

    if (groupRef.current) {
      groupRef.current.position.copy(worldUnits.current);
    }
  }, [positionKm, space, worldOrigin]);

  return <group ref={groupRef}>{children}</group>;
};

export default SimGroup;
