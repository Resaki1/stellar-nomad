"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { RemoteStarterSurvey } from "@/components/models/ships/StarterSurvey";
import { plumePointDev } from "./EngineExhaust";

/**
 * Dev only: a remote-style ship (hull, bells, plume without its own light — what a co-op
 * friend's ship mounts) placed from the console, for the far-plume checks (vfx-plume.mjs).
 *   __plumeProbe.set({ pos: [x,y,z] scene m, quat: [x,y,z,w], throttle }) / .hide()
 */
export default function PlumeProbe() {
  const group = useRef<THREE.Group>(null!);
  const thrust = useRef(0);
  useEffect(() => {
    (window as unknown as { __plumeProbe: unknown }).__plumeProbe = {
      set: (o: { pos: number[]; quat?: number[]; throttle?: number }) => {
        const g = group.current;
        g.position.set(o.pos[0], o.pos[1], o.pos[2]);
        if (o.quat) g.quaternion.set(o.quat[0], o.quat[1], o.quat[2], o.quat[3]);
        thrust.current = o.throttle ?? 1;
        g.visible = true;
      },
      hide: () => { group.current.visible = false; thrust.current = 0; },
      ...plumePointDev,
    };
  }, []);
  return (
    <group ref={group} visible={false}>
      <RemoteStarterSurvey thrust={thrust} />
    </group>
  );
}
