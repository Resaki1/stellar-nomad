"use client";

import { memo, useEffect, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useStore } from "jotai";
import { wrecksAtom, collectWreckAtom, isDeadAtom } from "@/store/death";
import { cargoRemainingUnitsAtom, addCargoAtom } from "@/store/cargo";
import { useWorldOrigin } from "@/sim/worldOrigin";

/** Distance (km) at which wreck cargo is automatically collected. */
const COLLECTION_RADIUS_KM = 0.5; // 500 meters

/** How often to check proximity (seconds). */
const CHECK_INTERVAL_S = 0.25;

/** Max wrecks we allocate GPU slots for. */
const MAX_WRECKS = 16;

const BOX_SIZE = 8; // meters

// Shared geometry + material (one draw call for all wrecks)
const WRECK_GEO = new THREE.BoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE);
const WRECK_MAT = new THREE.MeshStandardMaterial({
  color: new THREE.Color(0.35, 0.35, 0.38),
  roughness: 0.85,
  metalness: 0.2,
  emissive: new THREE.Color(0.08, 0.08, 0.1),
  emissiveIntensity: 0.4,
});

// Reusable temps
const _pos = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);

const WreckCollector = memo(function WreckCollector() {
  const store = useStore();
  const worldOrigin = useWorldOrigin();
  const accRef = useRef(0);
  const meshRef = useRef<THREE.InstancedMesh>(null!);

  // Hide all instances on mount
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < MAX_WRECKS; i++) {
      mesh.setMatrixAt(i, _zeroMat);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, []);

  useFrame((_, delta) => {
    const wrecks = store.get(wrecksAtom);
    const mesh = meshRef.current;

    // ── Update wreck visuals ──────────────────────────────────────
    if (mesh) {
      const originKm = worldOrigin.worldOriginKm;

      for (let i = 0; i < MAX_WRECKS; i++) {
        if (i < wrecks.length) {
          const w = wrecks[i];
          _pos.set(
            (w.positionKm[0] - originKm.x) * 1000,
            (w.positionKm[1] - originKm.y) * 1000,
            (w.positionKm[2] - originKm.z) * 1000,
          );
          _mat.compose(_pos, _quat, _scale);
          mesh.setMatrixAt(i, _mat);
        } else {
          mesh.setMatrixAt(i, _zeroMat);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.count = Math.min(wrecks.length, MAX_WRECKS);
    }

    // ── Collection check (throttled) ──────────────────────────────
    accRef.current += delta;
    if (accRef.current < CHECK_INTERVAL_S) return;
    accRef.current = 0;

    if (store.get(isDeadAtom)) return;
    if (wrecks.length === 0) return;

    const ship = worldOrigin.shipPosKm;
    const r2 = COLLECTION_RADIUS_KM * COLLECTION_RADIUS_KM;

    for (const wreck of wrecks) {
      const dx = wreck.positionKm[0] - ship.x;
      const dy = wreck.positionKm[1] - ship.y;
      const dz = wreck.positionKm[2] - ship.z;
      const d2 = dx * dx + dy * dy + dz * dz;

      if (d2 > r2) continue;

      const remaining = store.get(cargoRemainingUnitsAtom);
      if (remaining <= 0) break;

      const collected = store.set(collectWreckAtom, {
        wreckId: wreck.id,
        cargoRemaining: remaining,
      });

      for (const [resourceId, amount] of Object.entries(collected)) {
        if (amount > 0) {
          store.set(addCargoAtom, { resourceId, amount });
        }
      }
    }
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[WRECK_GEO, WRECK_MAT, MAX_WRECKS]}
      frustumCulled={false}
    />
  );
});

export default WreckCollector;
