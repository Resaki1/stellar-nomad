"use client";

import { memo, useMemo } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { useAtomValue } from "jotai";

import { systemConfigAtom } from "@/store/system";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { poiBuffer, type POIDef, type ProjectedPOI } from "@/store/poi";

// Reusable temp vectors — zero allocation in the hot path.
const _pos = new THREE.Vector3();
const _ndc = new THREE.Vector3();

/** Half-angle (radians) of the "focused" cone around screen center. */
const FOCUS_HALF_ANGLE_NDC = 0.06; // ~3.4° at center of NDC space

// ─── Per-type defaults (used when marker config is omitted) ──────

const ASTEROID_FIELD_DEFAULTS = { minDistanceKm: 0, maxDistanceKm: 50_000 };

/**
 * Derives POI definitions from the active system config.
 * Currently: one POI per asteroid field. Future: planets, stations, etc.
 */
function usePOIDefs(): POIDef[] {
  const system = useAtomValue(systemConfigAtom);
  return useMemo(() => {
    const pois: POIDef[] = [];
    for (const field of system.asteroidFields ?? []) {
      if (field.enabled === false) continue;
      pois.push({
        id: `field:${field.id}`,
        name: field.name,
        positionKm: field.anchorKm,
        minDistanceKm: field.marker?.minDistanceKm ?? ASTEROID_FIELD_DEFAULTS.minDistanceKm,
        maxDistanceKm: field.marker?.maxDistanceKm ?? ASTEROID_FIELD_DEFAULTS.maxDistanceKm,
      });
    }
    return pois;
  }, [system]);
}

/**
 * R3F component that projects POI world positions into screen space every frame.
 * Writes results into the shared `poiBuffer` for the HUD overlay to read.
 * Must be mounted inside the local-scene portal (has access to the local camera).
 */
const POIProjector = memo(function POIProjector() {
  const camera = useThree((s) => s.camera as THREE.PerspectiveCamera);
  const worldOrigin = useWorldOrigin();
  const pois = usePOIDefs();

  useFrame(() => {
    const projected: ProjectedPOI[] = [];
    const shipKm = worldOrigin.shipPosKm;
    const originKm = worldOrigin.worldOriginKm;

    for (let i = 0; i < pois.length; i++) {
      const poi = pois[i];
      const [px, py, pz] = poi.positionKm;

      // Distance from ship (km).
      const dx = px - shipKm.x;
      const dy = py - shipKm.y;
      const dz = pz - shipKm.z;
      const distanceKm = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // Skip POIs outside their configured visibility range.
      if (distanceKm < poi.minDistanceKm || distanceKm > poi.maxDistanceKm) continue;

      // Local render-space position (meters, relative to floating origin).
      _pos.set(
        (px - originKm.x) * 1000,
        (py - originKm.y) * 1000,
        (pz - originKm.z) * 1000,
      );

      // Project to NDC.
      _ndc.copy(_pos).project(camera);

      // Check if in front of camera (z in [-1, 1] after projection).
      const inFront = _ndc.z >= -1 && _ndc.z <= 1;

      // Normalized screen coords (0–1).
      const sx = _ndc.x * 0.5 + 0.5;
      const sy = 1 - (_ndc.y * 0.5 + 0.5);

      const inView =
        inFront && sx >= 0 && sx <= 1 && sy >= 0 && sy <= 1;

      // Focus: POI near screen center in NDC space.
      const focused =
        inView &&
        Math.abs(_ndc.x) < FOCUS_HALF_ANGLE_NDC &&
        Math.abs(_ndc.y) < FOCUS_HALF_ANGLE_NDC;

      // Edge arrow angle: direction from screen center to POI in screen space.
      // For behind-camera POIs, invert so the arrow points "back."
      let edgeAngle = 0;
      if (!inView) {
        let ex = _ndc.x;
        let ey = -_ndc.y; // flip Y for screen convention
        if (!inFront) {
          ex = -ex;
          ey = -ey;
        }
        edgeAngle = Math.atan2(ey, ex);
      }

      projected.push({
        id: poi.id,
        name: poi.name,
        inView,
        sx,
        sy,
        distanceKm,
        edgeAngle,
        focused,
      });
    }

    poiBuffer.pois = projected;
  });

  return null;
});

export default POIProjector;
