"use client";

import { useMemo, useLayoutEffect, useRef } from "react";
import { Group, Vector3 } from "three";
import { SCALED_UNITS_PER_KM, Vector3Tuple, toVector3 } from "@/sim/units";
import { useWorldOrigin } from "@/sim/worldOrigin";

type SpaceKind = "local" | "scaled";

type SimGroupProps = {
  space: SpaceKind;
  positionKm: Vector3Tuple;
  children?: React.ReactNode;
};

const tmpPositionKm = new Vector3();
const tmpConverted = new Vector3();

const SimGroup = ({ space, positionKm, children }: SimGroupProps) => {
  const groupRef = useRef<Group>(null!);
  const { worldOriginKm } = useWorldOrigin();

  const targetPosition = useMemo(() => toVector3(positionKm), [positionKm]);

  useLayoutEffect(() => {
    if (!groupRef.current) return;

    tmpPositionKm.copy(targetPosition).sub(worldOriginKm);

    if (space === "scaled") {
      tmpConverted.copy(tmpPositionKm).multiplyScalar(SCALED_UNITS_PER_KM);
      groupRef.current.position.copy(tmpConverted);
    } else {
      groupRef.current.position.copy(tmpPositionKm);
    }
  }, [
    space,
    targetPosition,
    worldOriginKm.x,
    worldOriginKm.y,
    worldOriginKm.z,
  ]);

  return <group ref={groupRef}>{children}</group>;
};

export default SimGroup;
