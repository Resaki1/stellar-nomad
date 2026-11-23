"use client";

import { memo, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useFrame } from "@react-three/fiber";
import { useStore } from "jotai";
import { SITES } from "@/data/content";
import { frameOriginKm, isFrameId } from "@/sim/frames";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { emitterColor } from "@/components/space/emissivePhotometry";
import { registerPreExposedEmissive } from "@/components/space/preExposedEmissive";
import { discoveriesMirrorAtom } from "@/store/research";

/** Drawn within this distance, km (the POI marker covers the rest). */
const DRAW_RANGE_KM = 400;

/** Placeholder installation: a truss frame with a dish and two panels (one merged mesh). */
function buildInstallation(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const beam = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(x, y, z);
    parts.push(g);
  };
  for (const x of [-40, 40]) for (const z of [-40, 40]) beam(x, 0, z, 4, 120, 4);
  for (const y of [-60, 60]) {
    beam(0, y, -40, 84, 4, 4);
    beam(0, y, 40, 84, 4, 4);
    beam(-40, y, 0, 4, 4, 84);
    beam(40, y, 0, 4, 4, 84);
  }
  beam(-110, 0, 0, 120, 2, 50);
  beam(110, 0, 0, 120, 2, 50);
  const dish = new THREE.SphereGeometry(30, 12, 6, 0, Math.PI * 2, 0, Math.PI / 3);
  dish.translate(0, 70, 0);
  parts.push(dish);
  const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(flat, false) ?? new THREE.BoxGeometry(80, 120, 80);
  new Set([...parts, ...flat]).forEach((g) => g !== merged && g.dispose());
  return merged;
}

const INSTALL_GEO = buildInstallation();
const CANISTER_GEO = new THREE.CylinderGeometry(6, 6, 18, 10);
const INSTALL_MAT = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.35, 0.33, 0.3), roughness: 0.8, metalness: 0.3 });
const CANISTER_MAT = new THREE.MeshStandardMaterial({
  color: new THREE.Color(0.5, 0.45, 0.3),
  roughness: 0.5,
  metalness: 0.5,
  emissive: emitterColor("replication_beacon"),
  emissiveIntensity: 0.6,
});
registerPreExposedEmissive(CANISTER_MAT);

const _o = new THREE.Vector3();

/** Authored sites in their own frame (the Moon's for the lunar canister); the canister hides once recovered. */
const SurveySite = memo(function SurveySite() {
  const store = useStore();
  const worldOrigin = useWorldOrigin();
  const groupRef = useRef<THREE.Group>(null!);
  const canisterRef = useRef<THREE.Mesh>(null!);
  const site = SITES[0];

  useFrame(() => {
    const g = groupRef.current;
    if (!site || !isFrameId(site.frameId)) {
      g.visible = false;
      return;
    }
    frameOriginKm(site.frameId, _o);
    const x = _o.x + site.positionKm[0], y = _o.y + site.positionKm[1], z = _o.z + site.positionKm[2];
    const ship = worldOrigin.shipPosKm, wo = worldOrigin.worldOriginKm;
    const dx = x - ship.x, dy = y - ship.y, dz = z - ship.z;
    g.visible = dx * dx + dy * dy + dz * dz < DRAW_RANGE_KM * DRAW_RANGE_KM;
    if (!g.visible) return;
    g.position.set((x - wo.x) * 1000, (y - wo.y) * 1000, (z - wo.z) * 1000);
    canisterRef.current.visible = !store.get(discoveriesMirrorAtom).sites[site.id];
  });

  return (
    <group ref={groupRef} visible={false}>
      <mesh receiveShadow geometry={INSTALL_GEO} material={INSTALL_MAT} />
      <mesh receiveShadow ref={canisterRef} geometry={CANISTER_GEO} material={CANISTER_MAT} position={[0, -75, 0]} />
    </group>
  );
});

export default SurveySite;
