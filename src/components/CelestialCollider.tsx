"use client";

import { memo, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useAtomValue, useStore } from "jotai";
import { systemConfigAtom } from "@/store/system";
import { shipHealthAtom } from "@/store/store";
import { spawnVFXEventAtom } from "@/store/vfx";
import { dieAtom, isDeadAtom } from "@/store/death";
import { cargoAtom } from "@/store/cargo";
import { useWorldOrigin } from "@/sim/worldOrigin";

type Collider = {
  id: string;
  positionKm: [number, number, number];
  radiusKm: number;
};

/** How often to check proximity (seconds). */
const CHECK_INTERVAL_S = 0.2;

/**
 * Checks ship distance to all planets/moons/star each tick.
 * Instant kill on contact (inside radius).
 */
const CelestialCollider = memo(function CelestialCollider() {
  const system = useAtomValue(systemConfigAtom);
  const store = useStore();
  const worldOrigin = useWorldOrigin();
  const accRef = useRef(0);

  const colliders = useMemo<Collider[]>(() => {
    const list: Collider[] = [];
    for (const body of system.celestialBodies ?? []) {
      list.push({
        id: body.id,
        positionKm: body.positionKm,
        radiusKm: body.radiusKm,
      });
    }
    return list;
  }, [system]);

  useFrame((_, delta) => {
    accRef.current += delta;
    if (accRef.current < CHECK_INTERVAL_S) return;
    accRef.current = 0;

    if (store.get(isDeadAtom)) return;

    const ship = worldOrigin.shipPosKm;

    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      const dx = ship.x - c.positionKm[0];
      const dy = ship.y - c.positionKm[1];
      const dz = ship.z - c.positionKm[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      const r = c.radiusKm;

      if (d2 < r * r) {
        // Instant kill — set health to 0 and trigger death
        store.set(shipHealthAtom, 0);

        // Spawn destruction debris at ship local position (0,0,0 in render space)
        store.set(spawnVFXEventAtom, {
          type: "collision",
          position: [0, 0, 0],
          radiusM: 120,
        });

        const cargo = store.get(cargoAtom);
        store.set(dieAtom, {
          positionKm: [ship.x, ship.y, ship.z],
          cargoItems: cargo.items,
        });
        return;
      }
    }
  });

  return null;
});

export default CelestialCollider;
