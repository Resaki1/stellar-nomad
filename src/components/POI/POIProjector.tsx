"use client";

import { memo, useMemo } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { useAtomValue, useStore } from "jotai";

import { systemConfigAtom } from "@/store/system";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { poiBuffer, type POIDef, type ProjectedPOI } from "@/store/poi";
import { wrecksAtom } from "@/store/death";
import {
  targetedPOIAtom,
  transitDriveOwnedAtom,
  transitDriveBuffer,
  calcTransitTimeS,
} from "@/store/transit";

// Reusable temp vectors — zero allocation in the hot path.
const _pos = new THREE.Vector3();
const _ndc = new THREE.Vector3();

/** Half-angle (radians) of the "focused" cone around screen center. */
const FOCUS_HALF_ANGLE_NDC = 0.06; // ~3.4° at center of NDC space

/** Time in seconds the player must gaze at a POI to target it. */
const POI_TARGET_GAZE_TIME_S = 1.5;

/** Grace period (seconds) where looking away doesn't untarget — absorbs brief glances. */
const POI_UNTARGET_GRACE_S = 0.3;

// ─── Per-type defaults (used when marker config is omitted) ──────

const ASTEROID_FIELD_DEFAULTS = { minDistanceKm: 0, maxDistanceKm: 50_000 };
const CELESTIAL_BODY_DEFAULTS = { minDistanceKm: 0, maxDistanceKm: 500_000 };

/**
 * Derives POI definitions from the active system config.
 * Sources: celestial bodies (planets, moons) + asteroid fields.
 */
const WRECK_DEFAULTS = { minDistanceKm: 0, maxDistanceKm: 100_000 };

function usePOIDefs(): POIDef[] {
  const system = useAtomValue(systemConfigAtom);
  const wrecks = useAtomValue(wrecksAtom);
  return useMemo(() => {
    const pois: POIDef[] = [];

    // Celestial bodies (planets, moons — stars are excluded)
    for (const body of system.celestialBodies ?? []) {
      if (body.type === "star") continue;
      if (!body.marker) continue;
      // Arrival stand-off: radius + 20% padding (minimum 100km).
      const arrivalOffsetKm = Math.max(100, body.radiusKm * 2);
      pois.push({
        id: `body:${body.id}`,
        name: body.name,
        positionKm: body.positionKm,
        minDistanceKm: body.marker.minDistanceKm ?? CELESTIAL_BODY_DEFAULTS.minDistanceKm,
        maxDistanceKm: body.marker.maxDistanceKm ?? CELESTIAL_BODY_DEFAULTS.maxDistanceKm,
        arrivalOffsetKm,
      });
    }

    // Asteroid fields
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

    // Wrecks (death sites with recoverable cargo)
    for (const wreck of wrecks) {
      pois.push({
        id: `wreck:${wreck.id}`,
        name: "Wreck",
        positionKm: wreck.positionKm,
        minDistanceKm: WRECK_DEFAULTS.minDistanceKm,
        maxDistanceKm: WRECK_DEFAULTS.maxDistanceKm,
      });
    }

    return pois;
  }, [system, wrecks]);
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
  const store = useStore();

  // Gaze tracking for POI targeting.
  const gazeIdRef = { current: null as string | null };
  const gazeTimeRef = { current: 0 };
  // Grace timer: how long the player has been looking away from the current target.
  const untargetGraceRef = { current: 0 };

  useFrame((_, delta) => {
    const projected: ProjectedPOI[] = [];
    const shipKm = worldOrigin.shipPosKm;
    const originKm = worldOrigin.worldOriginKm;
    const driveOwned = store.get(transitDriveOwnedAtom);

    let focusedPoiId: string | null = null;
    let focusedPoiDef: POIDef | null = null;
    let focusedDistKm = 0;

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

      // For distant POIs (beyond camera far plane), normalize to a safe
      // distance so the projection matrix doesn't clip them. We only
      // need the screen-space direction, not depth accuracy.
      const len = _pos.length();
      const farPlane = camera.far * 0.5;
      if (len > farPlane) {
        _pos.multiplyScalar(farPlane / len);
      }

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

      if (focused) {
        focusedPoiId = poi.id;
        focusedPoiDef = poi;
        focusedDistKm = distanceKm;
      }

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

    // ── Gaze-based POI targeting (only when transit drive is owned and idle) ───
    // Lock target while spooling/accelerating/decelerating so the auto-align
    // rotation doesn't accidentally retarget a different POI.
    const transitBusy = transitDriveBuffer.phase !== "idle";

    if (driveOwned && !transitBusy) {
      const currentTarget = store.get(targetedPOIAtom);
      const dtClamped = Math.min(delta, 0.1);

      if (focusedPoiId && focusedPoiId === gazeIdRef.current) {
        // Still gazing at same POI — accumulate time.
        gazeTimeRef.current += dtClamped;
        untargetGraceRef.current = 0;

        if (gazeTimeRef.current >= POI_TARGET_GAZE_TIME_S) {
          if (currentTarget?.id !== focusedPoiId && focusedPoiDef) {
            store.set(targetedPOIAtom, {
              id: focusedPoiDef.id,
              name: focusedPoiDef.name,
              positionKm: focusedPoiDef.positionKm,
              arrivalOffsetKm: focusedPoiDef.arrivalOffsetKm,
            });
            poiBuffer.targetedId = focusedPoiDef.id;
          }
        }
      } else if (focusedPoiId) {
        // Started gazing at a new POI — reset timer.
        gazeIdRef.current = focusedPoiId;
        gazeTimeRef.current = 0;
        untargetGraceRef.current = 0;
      } else {
        // Not gazing at any POI — reset gaze progress immediately.
        gazeIdRef.current = null;
        gazeTimeRef.current = 0;

        // If a POI is currently targeted, accumulate untarget grace and clear after timeout.
        if (currentTarget) {
          untargetGraceRef.current += dtClamped;
          if (untargetGraceRef.current >= POI_UNTARGET_GRACE_S) {
            store.set(targetedPOIAtom, null);
            poiBuffer.targetedId = null;
            poiBuffer.targetedEtaS = null;
            untargetGraceRef.current = 0;
          }
        }
      }

      // Write gaze progress for the Reticle.
      // Only show progress when actively gazing at a not-yet-targeted POI.
      const gazingAtUntargeted =
        !!focusedPoiId && (!currentTarget || currentTarget.id !== focusedPoiId);
      poiBuffer.gazeActive = gazingAtUntargeted;
      poiBuffer.gazeProgress = gazingAtUntargeted
        ? Math.min(gazeTimeRef.current / POI_TARGET_GAZE_TIME_S, 1)
        : 0;

      // Update ETA on targeted POI.
      const targeted = store.get(targetedPOIAtom);
      if (targeted) {
        const [tx, ty, tz] = targeted.positionKm;
        const tdx = tx - shipKm.x;
        const tdy = ty - shipKm.y;
        const tdz = tz - shipKm.z;
        const targetDistKm = Math.sqrt(tdx * tdx + tdy * tdy + tdz * tdz);
        poiBuffer.targetedId = targeted.id;
        poiBuffer.targetedEtaS = calcTransitTimeS(targetDistKm);
      } else {
        poiBuffer.targetedId = null;
        poiBuffer.targetedEtaS = null;
      }
    } else if (driveOwned && transitBusy) {
      // Transit in progress — freeze target, disable new gaze targeting.
      gazeIdRef.current = null;
      gazeTimeRef.current = 0;
      poiBuffer.gazeProgress = 0;
      poiBuffer.gazeActive = false;
      // Keep the existing target/ETA visible in the HUD.
      const targeted = store.get(targetedPOIAtom);
      if (targeted) {
        const [tx, ty, tz] = targeted.positionKm;
        const tdx = tx - shipKm.x;
        const tdy = ty - shipKm.y;
        const tdz = tz - shipKm.z;
        const targetDistKm = Math.sqrt(tdx * tdx + tdy * tdy + tdz * tdz);
        poiBuffer.targetedId = targeted.id;
        poiBuffer.targetedEtaS = calcTransitTimeS(targetDistKm);
      } else {
        // Autopilot was aborted mid-transit — clear the diamond highlight.
        poiBuffer.targetedId = null;
        poiBuffer.targetedEtaS = null;
      }
    } else {
      // Drive not owned — clear targeting and gaze state.
      gazeIdRef.current = null;
      gazeTimeRef.current = 0;
      untargetGraceRef.current = 0;
      poiBuffer.gazeProgress = 0;
      poiBuffer.gazeActive = false;
      if (poiBuffer.targetedId) {
        poiBuffer.targetedId = null;
        poiBuffer.targetedEtaS = null;
        store.set(targetedPOIAtom, null);
      }
    }

    poiBuffer.pois = projected;
    poiBuffer.flush?.();
  });

  return null;
});

export default POIProjector;
