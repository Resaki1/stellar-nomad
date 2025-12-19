"use client";

import { forwardRef, useMemo, type ReactNode } from "react";
import { Group, Vector3 } from "three";
import { kmVectorToLocalUnits, kmVectorToScaledUnits } from "@/sim/units";
import { useWorldOriginKm } from "@/sim/worldOrigin";

type SimGroupProps = {
  space: "local" | "scaled";
  positionKm: [number, number, number];
  children: ReactNode;
};

const SimGroup = forwardRef<Group, SimGroupProps>(
  ({ children, positionKm, space }, ref) => {
    const worldOriginKm = useWorldOriginKm();

    const groupPosition = useMemo(() => new Vector3(), []);
    const tempKm = useMemo(() => new Vector3(), []);
    const renderPosition = useMemo(() => new Vector3(), []);

    tempKm.fromArray(positionKm).sub(worldOriginKm);

    if (space === "scaled") {
      kmVectorToScaledUnits(tempKm, renderPosition);
    } else {
      kmVectorToLocalUnits(tempKm, renderPosition);
    }

    groupPosition.copy(renderPosition);

    return (
      <group ref={ref} position={groupPosition.toArray() as [number, number, number]}>
        {children}
      </group>
    );
  }
);

SimGroup.displayName = "SimGroup";

export default SimGroup;
