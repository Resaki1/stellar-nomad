"use client";

import { depotPoisAtom, industrySourcePois, trackedDronePoiAtom } from "@/store/industryHud";
import { INTERACT_LOCK_KM, isInteractFocusBlocked } from "@/store/interact";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { useAtomValue, useStore } from "jotai";

import { systemConfigAtom } from "@/store/system";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { shipView } from "@/components/Camera/shipView";
import { isStructurePoi, pilotPOIsAtom, poiBuffer, STRUCTURE_FOCUS_TIME_S, type POIDef, type ProjectedPOI } from "@/store/poi";
import { bookmarkPOIsAtom } from "@/store/discoveries";
import { sitePOIsAtom } from "@/store/sites";
import {
  STAR_MARKER_MAX_LY,
  STAR_MARKER_NEAREST,
  revealAllStarMarkersAtom,
  revealedStarMarkerIdsAtom,
  starMarkersEnabledAtom,
} from "@/store/starMarkers";
import { loadNearbyStars } from "@/sim/nearbyStars";
import {
  getStarCandidates,
  nearestStarCandidates,
  type NearestCandidate,
} from "@/components/space/starCandidates";
import { setStarTierGateStat } from "@/components/space/starLodStatus";
import {
  makeTierGate,
  tierNeedsReselect,
  tierSelected,
} from "@/components/space/starTierGate";
import { LY_IN_KM } from "@/sim/units";
import { wrecksAtom } from "@/store/death";
import { playerReplicationAtom, replicationPointsAtom } from "@/store/replication";
import { REPLICATION_TUNING } from "@/sim/replication/points";
import { isFrameId, resolveFramePositionKm } from "@/sim/frames";
import {
  bodyTransitTarget,
  targetedPOIAtom,
  transitDriveOwnedAtom,
  transitDriveBuffer,
  transitPreviewAtom,
} from "@/store/transit";

const previewEta = (p: { targetId: string; ok: boolean; etaS: number } | null, id: string): number | null =>
  p && p.ok && p.targetId === id ? p.etaS : null;

// Reusable temp vectors — zero allocation in the hot path.
const _pos = new THREE.Vector3();
const _ndc = new THREE.Vector3();
const _poiKm = new THREE.Vector3();
const _noseNdc = new THREE.Vector3();

/** Half-size, in NDC, of the "focused" square around the projected nose (the reticle). */
const FOCUS_HALF_ANGLE_NDC = 0.06; // ~3.4° at center of NDC space

/** Time in seconds the player must gaze at a POI to target it. */
const POI_TARGET_GAZE_TIME_S = 1.5;
/** A destination picked from a menu yields to gaze only after a deliberate look (arrival often faces the Sun). */
const POI_PINNED_GAZE_TIME_S = 4;

/** Grace period (seconds) where looking away doesn't untarget — absorbs brief glances. */
const POI_UNTARGET_GRACE_S = 0.3;

// ─── Per-type defaults (used when marker config is omitted) ──────

const ASTEROID_FIELD_DEFAULTS = { minDistanceKm: 0, maxDistanceKm: 50_000 };
const CELESTIAL_BODY_DEFAULTS = { minDistanceKm: 0, maxDistanceKm: 500_000 };

/** Placed point model: ring 43 m (ReplicationPoints.tsx). */
const POINT_OBJECT_RADIUS_KM = 0.043;
const WRECK_DEFAULTS = { minDistanceKm: 0, maxDistanceKm: 100_000 };

/**
 * Stars are marked at ANY range — a marker you can only see once you are already
 * there is useless for navigation, which is the whole point of these. 1e15 km is
 * ~106 ly, past `STAR_MARKER_MAX_LY`.
 */
const STAR_MARKER_MAX_DISTANCE_KM = 1e15;

/** Arrival stand-off for a star: 5 stellar radii, so autopilot stops outside it. */
const STAR_ARRIVAL_RADII = 5;

/**
 * The nearest stars to the SHIP, re-selected only when the ship has moved far enough
 * for the answer to change.
 *
 * ⚠ Rides the same movement gate as the disc and light pools (space/starTierGate.ts):
 * one pass over 8,848 candidates every ~2,673 AU of travel in the solar system, not
 * every frame. It writes React state, so the gate is doing double duty — it also
 * keeps this from re-rendering the HUD 120 times a second.
 */
function useNearestStars(): NearestCandidate[] {
  const worldOrigin = useWorldOrigin();
  const [nearest, setNearest] = useState<NearestCandidate[]>([]);
  const gate = useRef(makeTierGate());

  useFrame(() => {
    // 🐛🐛 DO NOT ADVANCE THE GATE BEFORE THE CANDIDATES EXIST. The union is built on
    // the first frame after the nearby catalogue's FETCH resolves, so on early frames
    // `getStarCandidates()` is null. The first version advanced the gate anyway, with
    // the safety cap as the budget — committing a **30 ly** movement budget while the
    // data was still loading. Symptom on device: load anywhere but Sol and no star
    // markers appear at all until you have travelled 30 ly, "and that only seems to
    // work sometimes" — the sometimes being whether the fetch happened to land before
    // the first frame.
    //
    // 🔑 "Not loaded yet" and "loaded, nothing in range" are different states and I
    // collapsed them. Only the second one justifies taking a budget.
    if (!getStarCandidates()) return;
    const sx = worldOrigin.shipPosKm.x;
    const sy = worldOrigin.shipPosKm.y;
    const sz = worldOrigin.shipPosKm.z;
    if (!tierNeedsReselect(gate.current, sx, sy, sz)) return;
    const picked = nearestStarCandidates(
      sx,
      sy,
      sz,
      STAR_MARKER_NEAREST,
      STAR_MARKER_MAX_LY * LY_IN_KM,
      LY_IN_KM,
    );
    // ⚠ Advance the gate even when nothing is in RANGE, or a genuinely empty pose
    // would re-run this 8,848-candidate pass every frame. 1% of the cap, not the cap:
    // the nearest candidate is then beyond the cap, so moving 1% of it cannot bring
    // one inside — and a full-cap budget is what caused the defect above.
    tierSelected(
      gate.current,
      sx,
      sy,
      sz,
      picked.length > 0
        ? picked[0].distKm
        : 0.01 * STAR_MARKER_MAX_LY * LY_IN_KM,
    );
    setStarTierGateStat(
      "marker",
      gate.current.runs,
      gate.current.skipped,
      Math.sqrt(gate.current.budgetSq),
    );
    if (picked.length === 0) {
      setNearest((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    setNearest((prev) =>
      prev.length === picked.length &&
      prev.every((p, i) => p.id === picked[i].id)
        ? prev
        : picked,
    );
  });

  return nearest;
}

/**
 * Derives POI definitions from the active system config.
 * Sources: celestial bodies (planets, moons) + asteroid fields.
 */
function usePOIDefs(): POIDef[] {
  const system = useAtomValue(systemConfigAtom);
  const wrecks = useAtomValue(wrecksAtom);
  const bookmarkPois = useAtomValue(bookmarkPOIsAtom);
  const sitePois = useAtomValue(sitePOIsAtom);
  const pilotPois = useAtomValue(pilotPOIsAtom);
  const target = useAtomValue(targetedPOIAtom);
  const droneBearing = useAtomValue(trackedDronePoiAtom);
  const depotPois = useAtomValue(depotPoisAtom);
  const points = useAtomValue(replicationPointsAtom);
  const activePointId = useAtomValue(playerReplicationAtom).activeId;
  const starsOn = useAtomValue(starMarkersEnabledAtom);
  const revealAll = useAtomValue(revealAllStarMarkersAtom);
  const revealed = useAtomValue(revealedStarMarkerIdsAtom);
  // The nearest stars to the SHIP, gated — see useNearestStars.
  const nearestStars = useNearestStars();
  // Kick the nearby catalogue's fetch: `starCandidates` needs it to build the union,
  // and nothing else in this component does.
  useEffect(() => {
    void loadNearbyStars();
  }, []);

  return useMemo(() => {
    const pois: POIDef[] = [];

    // Celestial bodies (planets, moons — stars are excluded)
    for (const body of system.celestialBodies ?? []) {
      if (body.type === "star") continue;
      if (!body.marker) continue;
      const t = bodyTransitTarget(body, system.asteroidFields);
      pois.push({
        id: t.id,
        name: t.name,
        positionKm: body.positionKm,
        minDistanceKm: body.marker.minDistanceKm ?? CELESTIAL_BODY_DEFAULTS.minDistanceKm,
        maxDistanceKm: body.marker.maxDistanceKm ?? CELESTIAL_BODY_DEFAULTS.maxDistanceKm,
        arrivalOffsetKm: t.arrivalOffsetKm,
        field: t.field,
      });
    }

    // Asteroid fields: hidden while the ship is inside the field's outer radius (§8)
    for (const field of system.asteroidFields ?? []) {
      if (field.enabled === false) continue;
      const id = `field:${field.id}`;
      const tracked = target?.id === id && poiBuffer.pinnedId === id;
      const outerKm = field.shape.type === "sphere" ? field.shape.radiusKm + (field.shape.edgeFalloffKm ?? 0) : 0;
      pois.push({
        id,
        name: field.name,
        positionKm: field.anchorKm,
        minDistanceKm: tracked ? 0 : Math.max(outerKm, field.marker?.minDistanceKm ?? ASTEROID_FIELD_DEFAULTS.minDistanceKm),
        maxDistanceKm: tracked ? STAR_MARKER_MAX_DISTANCE_KM : field.marker?.maxDistanceKm ?? ASTEROID_FIELD_DEFAULTS.maxDistanceKm,
      });
    }

    // Wrecks (death sites with recoverable cargo, consumables and/or fuel)
    for (const wreck of wrecks) {
      // Contents are on the Target Card when focused (§1.11).
      pois.push({
        id: `wreck:${wreck.id}`,
        name: "Wreck",
        positionKm: wreck.positionKm,
        frameId: wreck.frameId,
        minDistanceKm: WRECK_DEFAULTS.minDistanceKm,
        maxDistanceKm: WRECK_DEFAULTS.maxDistanceKm,
      });
    }

    // Replication points: transit destinations with room to brake
    for (const pt of points) {
      // D1: the origin point is the recovery fallback (world spawn), not a place: no marker.
      if (pt.starter || !isFrameId(pt.frameId)) continue;
      pois.push({
        id: `point:${pt.id}`,
        name: pt.id === activePointId ? `${pt.name} ◆` : pt.name,
        positionKm: pt.positionKm,
        frameId: pt.frameId,
        minDistanceKm: 0,
        maxDistanceKm: 2e6,
        arrivalOffsetKm: REPLICATION_TUNING.transitStandOffKm,
        objectRadiusKm: POINT_OBJECT_RADIUS_KM,
      });
    }

    // Bookmarked resource sources (discoveries list)
    for (const b of bookmarkPois) pois.push(b);

    // Authored site signals
    for (const p of sitePois) pois.push(p);

    // Other pilots (co-op): live frame-relative positions
    for (const p of pilotPois) pois.push(p);

    if (droneBearing) pois.push(droneBearing);
    for (const p of depotPois) pois.push(p.id === target?.id ? { ...p, maxDistanceKm: STAR_MARKER_MAX_DISTANCE_KM } : p);
    for (const p of industrySourcePois) pois.push(p.id === target?.id ? { ...p, maxDistanceKm: STAR_MARKER_MAX_DISTANCE_KM } : p);

    // B3: the current destination always has a marker, even when nothing else lists it.
    if (target && !target.id.startsWith("drone:") && !pois.some((p) => p.id === target.id)) {
      pois.push({
        id: target.id,
        name: target.name,
        positionKm: target.positionKm as [number, number, number],
        frameId: target.frameId,
        minDistanceKm: 0,
        maxDistanceKm: STAR_MARKER_MAX_DISTANCE_KM,
        arrivalOffsetKm: target.arrivalOffsetKm,
        field: target.field,
      });
    }

    // ── Stars ────────────────────────────────────────────────────────────────
    // ⚠ Includes the PRIMARY, which the celestial-body loop above deliberately
    // skips (`type === "star"`). Without it there is no way to find your way home
    // once you have left, which is the one marker that matters most.
    if (starsOn) {
      const revealedSet = new Set(revealed);
      const star = system.celestialBodies?.find((b) => b.type === "star");
      if (star) {
        pois.push({
          id: `star:sol`,
          name: star.name,
          positionKm: star.positionKm,
          minDistanceKm: 0,
          maxDistanceKm: STAR_MARKER_MAX_DISTANCE_KM,
          arrivalOffsetKm: star.radiusKm * STAR_ARRIVAL_RADII,
        });
      }
      // ⚠⚠ THE NEAREST STARS TO THE SHIP, from the same candidate union the disc
      // and light pools promote from — so a marker, its disc, its light, its collider
      // and the warp target are all the same position, to the last bit. The previous
      // rule filtered on `distLy` (the catalogue distance FROM SOL) over the 166-star
      // nearby list, which both went wrong the moment the player left the system and
      // could never mark any of the other 8,682 stars.
      for (const s of nearestStars) {
        if (!revealAll && !revealedSet.has(s.id)) continue;
        pois.push({
          id: `star:${s.id}`,
          name: s.name,
          positionKm: s.positionKm,
          minDistanceKm: 0,
          maxDistanceKm: STAR_MARKER_MAX_DISTANCE_KM,
          // 🔑 Derived from the star's own radius (Stefan–Boltzmann via
          // starPhysics), so autopilot stops outside a supergiant as readily as
          // outside a red dwarf without a per-star number anywhere.
          arrivalOffsetKm: s.radiusKm * STAR_ARRIVAL_RADII,
        });
      }
    }

    return pois;
  }, [system, wrecks, points, activePointId, bookmarkPois, sitePois, pilotPois, depotPois, droneBearing, target, starsOn, revealAll, revealed, nearestStars]);
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

  // A renamed station or recovery point keeps its current navigation lock and bearing.
  useEffect(() => {
    const target = store.get(targetedPOIAtom);
    if (!target || !(isStructurePoi(target.id) || target.id.startsWith("drone:"))) return;
    const poi = pois.find(p => p.id === target.id);
    if (!poi && target.id.startsWith("drone:")) {
      poiBuffer.pinnedId = null;
      poiBuffer.targetedId = null;
      store.set(targetedPOIAtom, null);
    }
    if (poi && poi.name !== target.name) store.set(targetedPOIAtom, { ...target, name: poi.name });
  }, [pois, store]);

  // Gaze tracking for POI targeting.
  const gazeIdRef = useRef<string | null>(null);
  const gazeTimeRef = useRef(0);
  // Grace timer: how long the player has been looking away from the current target.
  const untargetGraceRef = useRef(0);

  useFrame((_, delta) => {
    const projected: ProjectedPOI[] = [];
    const shipKm = worldOrigin.shipPosKm;
    const originKm = worldOrigin.worldOriginKm;
    const driveOwned = store.get(transitDriveOwnedAtom);

    let focusedPoiId: string | null = null;
    let focusedPoiDef: POIDef | null = null;
    let focusedDistKm = 0;
    let focusedNoseOff = Infinity;

    // Gaze is measured at the reticle (ship nose), which the lagging chase camera moves off centre.
    _noseNdc.copy(shipView.forward).multiplyScalar(camera.far * 0.5).add(shipView.position).project(camera);
    const noseInFront = _noseNdc.z >= -1 && _noseNdc.z <= 1;

    for (let i = 0; i < pois.length; i++) {
      const poi = pois[i];
      resolveFramePositionKm(poi.positionKm, poi.frameId, _poiKm);
      const px = _poiKm.x, py = _poiKm.y, pz = _poiKm.z;

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

      const focused =
        inView &&
        noseInFront &&
        Math.abs(_ndc.x - _noseNdc.x) < FOCUS_HALF_ANGLE_NDC &&
        Math.abs(_ndc.y - _noseNdc.y) < FOCUS_HALF_ANGLE_NDC;

      // Nearest the nose wins: in an eclipse the Moon and the Sun share the focus box.
      const noseOff = focused ? Math.hypot(_ndc.x - _noseNdc.x, _ndc.y - _noseNdc.y) : Infinity;
      if (focused && poi.targetable !== false && noseOff < focusedNoseOff) {
        focusedNoseOff = noseOff;
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

      // projectionMatrix[5] = 1/tan(fov/2): radius over distance → fraction of the half-height.
      const objectRadiusFrac = inView && poi.objectRadiusKm
        ? (0.5 * camera.projectionMatrix.elements[5] * poi.objectRadiusKm * 1000) / Math.max(1, _pos.distanceTo(camera.position))
        : 0;

      projected.push({
        id: poi.id,
        name: poi.name,
        inView,
        sx,
        sy,
        distanceKm,
        edgeAngle,
        focused,
        objectRadiusFrac,
        kind: poi.kind,
      });
    }

    // ── Gaze-based POI targeting (only when transit drive is owned and idle) ───
    // Lock target while spooling/accelerating/decelerating so the auto-align
    // rotation doesn't accidentally retarget a different POI.
    const transitBusy = transitDriveBuffer.phase !== "idle";

    // A POI the ship already stands at (inside its arrival stand-off) is no transit target: gazing
    // at it (recovery emerges facing its point) must not replace the current one.
    // An interactable within lock range is a Target Card target, not a transit destination (§2.2).
    const interactable = !!focusedPoiDef && /^(site|wreck|point|depot):/.test(focusedPoiDef.id) && focusedDistKm <= INTERACT_LOCK_KM;
    const structureBlocked = focusedPoiDef && isStructurePoi(focusedPoiDef.id) && isInteractFocusBlocked(store);
    const ignoringGaze = focusedPoiId !== null && focusedPoiId === poiBuffer.ignoreGazeUntilLookAway;
    if (!ignoringGaze) poiBuffer.ignoreGazeUntilLookAway = null;
    if (focusedPoiDef && (interactable || structureBlocked || ignoringGaze || focusedDistKm <= (focusedPoiDef.arrivalOffsetKm ?? 0) * 1.2 + 0.5)) {
      focusedPoiId = null;
      focusedPoiDef = null;
    }

    if (driveOwned && !transitBusy) {
      const currentTarget = store.get(targetedPOIAtom);
      const dtClamped = Math.min(delta, 0.1);

      const gazeNeedS = focusedPoiId && isStructurePoi(focusedPoiId) ? STRUCTURE_FOCUS_TIME_S
        : currentTarget && currentTarget.id === poiBuffer.pinnedId ? POI_PINNED_GAZE_TIME_S : POI_TARGET_GAZE_TIME_S;
      if (focusedPoiId && focusedPoiId === gazeIdRef.current) {
        // Still gazing at same POI — accumulate time.
        gazeTimeRef.current += dtClamped;

        if (gazeTimeRef.current >= gazeNeedS) {
          if (currentTarget?.id !== focusedPoiId && focusedPoiDef) {
            poiBuffer.pinnedId = null;
            store.set(targetedPOIAtom, {
              id: focusedPoiDef.id,
              name: focusedPoiDef.name,
              positionKm: focusedPoiDef.positionKm,
              frameId: focusedPoiDef.frameId,
              arrivalOffsetKm: focusedPoiDef.arrivalOffsetKm,
              field: focusedPoiDef.field,
            });
            poiBuffer.targetedId = focusedPoiDef.id;
          }
        }
      } else if (focusedPoiId) {
        // Started gazing at a new POI — reset timer.
        gazeIdRef.current = focusedPoiId;
        gazeTimeRef.current = 0;
      } else {
        // Not gazing at any POI — reset gaze progress immediately.
        gazeIdRef.current = null;
        gazeTimeRef.current = 0;
      }

      const targetAfterGaze = store.get(targetedPOIAtom);
      // A structure's automatic lock expires on look-away, even while starting to aim at
      // a different POI. An explicitly pinned bearing stays until another is chosen.
      if (targetAfterGaze && targetAfterGaze.id !== poiBuffer.pinnedId &&
        (!focusedPoiId || (isStructurePoi(targetAfterGaze.id) && targetAfterGaze.id !== focusedPoiId))) {
        untargetGraceRef.current += dtClamped;
        if (untargetGraceRef.current >= POI_UNTARGET_GRACE_S) {
          store.set(targetedPOIAtom, null);
          untargetGraceRef.current = 0;
        }
      } else untargetGraceRef.current = 0;

      // Write gaze progress for the Reticle.
      // Only show progress when actively gazing at a not-yet-targeted POI.
      const gazingAtUntargeted =
        !!focusedPoiId && (!currentTarget || currentTarget.id !== focusedPoiId);
      poiBuffer.gazeActive = gazingAtUntargeted;
      poiBuffer.gazeProgress = gazingAtUntargeted
        ? Math.min(gazeTimeRef.current / gazeNeedS, 1)
        : 0;

      // ETA on the targeted POI: the transit predictor's (fuel-limited legs and clearance routes included).
      const targeted = store.get(targetedPOIAtom);
      if (targeted) {
        poiBuffer.targetedId = targeted.id;
        poiBuffer.targetedEtaS = previewEta(store.get(transitPreviewAtom), targeted.id);
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
        poiBuffer.targetedId = targeted.id;
        poiBuffer.targetedEtaS = previewEta(store.get(transitPreviewAtom), targeted.id);
      } else {
        // Autopilot was aborted mid-transit — clear the diamond highlight.
        poiBuffer.targetedId = null;
        poiBuffer.targetedEtaS = null;
      }
    } else {
      // A manually tracked Industry bearing remains usable before a drive is installed.
      gazeIdRef.current = null;
      gazeTimeRef.current = 0;
      untargetGraceRef.current = 0;
      poiBuffer.gazeProgress = 0;
      poiBuffer.gazeActive = false;
      const targeted = store.get(targetedPOIAtom);
      const industryBearing = !!targeted && targeted.id === poiBuffer.pinnedId && /^(depot|drone|field|industry-source):/.test(targeted.id);
      if (!industryBearing && poiBuffer.targetedId) store.set(targetedPOIAtom, null);
      poiBuffer.targetedId = industryBearing ? targeted.id : null;
      poiBuffer.targetedEtaS = null;
    }

    poiBuffer.pois = projected;
    poiBuffer.flush?.();
  });

  return null;
});

export default POIProjector;
