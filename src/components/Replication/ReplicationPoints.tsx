"use client";

import { memo, useEffect, useRef } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useFrame } from "@react-three/fiber";
import { useStore } from "jotai";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { frameOriginKm, isFrameId } from "@/sim/frames";
import { getLocalPlayerShip } from "@/sim/entities";
import { emitterColor } from "@/components/space/emissivePhotometry";
import { registerPreExposedEmissive } from "@/components/space/preExposedEmissive";
import { MAX_POINTS, REPLICATION_TUNING } from "@/sim/replication/points";
import { arrivalChunksReady } from "@/sim/replication/clearance";
import { ARRIVAL_TIMEOUT_MS, endArrival, repositionState } from "@/sim/ship/reposition";
import { nearFieldLoadSettled } from "@/sim/physics/nearField";
import { getActiveAsteroidRuntime } from "@/sim/asteroids/runtimeContext";
import { placementModeAtom, placementPreview, replicationPointsAtom } from "@/store/replication";
import { shipView } from "@/components/Camera/shipView";

/** Points beyond this are not drawn (their POI marker still is), km. */
const DRAW_RANGE_KM = 400;
/** Arrival gate: streamed chunks within this reach of the ship, km. */
const ARRIVAL_REACH_KM = 1.5;
const ARRIVAL_MIN_FRAMES = 3;

// ── Placeholder model, one merged geometry → one instanced draw call ──
function buildPointGeometry(): THREE.BufferGeometry {
  const core = new THREE.OctahedronGeometry(22, 0);
  const ring = new THREE.TorusGeometry(40, 3, 6, 32);
  const mast = new THREE.CylinderGeometry(2, 2, 70, 6);
  mast.rotateX(Math.PI / 2);
  const parts = [core, ring, mast].map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(parts, false);
  new Set([core, ring, mast, ...parts]).forEach((g) => g.dispose());
  return merged ?? new THREE.OctahedronGeometry(22, 0);
}

const POINT_GEO = buildPointGeometry();
const POINT_MAT = new THREE.MeshStandardMaterial({
  color: new THREE.Color(0.3, 0.32, 0.36),
  roughness: 0.6,
  metalness: 0.4,
  emissive: emitterColor("replication_beacon"),
  emissiveIntensity: 1,
});
registerPreExposedEmissive(POINT_MAT);

const GHOST_OK = new THREE.MeshBasicMaterial({ color: emitterColor("replication_preview"), wireframe: true, transparent: true, opacity: 0.5 });
const GHOST_BAD = new THREE.MeshBasicMaterial({ color: emitterColor("replication_preview_bad"), wireframe: true, transparent: true, opacity: 0.5 });
const LINE_OK = new THREE.LineBasicMaterial({ color: emitterColor("replication_preview"), transparent: true, opacity: 0.6 });
const LINE_BAD = new THREE.LineBasicMaterial({ color: emitterColor("replication_preview_bad"), transparent: true, opacity: 0.6 });
[GHOST_OK, GHOST_BAD, LINE_OK, LINE_BAD].forEach((m) => registerPreExposedEmissive(m));

/** Range indicator: the rock-clearance ring around the point plus the emergence leg (point → −Z). */
function buildRangeGeometry(): THREE.BufferGeometry {
  const r = REPLICATION_TUNING.pointRockClearanceM;
  const seg = 48;
  const pts: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    pts.push(Math.cos(a0) * r, Math.sin(a0) * r, 0, Math.cos(a1) * r, Math.sin(a1) * r, 0);
  }
  const e = REPLICATION_TUNING.emergenceKm * 1000;
  pts.push(0, 0, 0, 0, 0, -e);
  // Emergence marker: a small cross at the emergence position.
  pts.push(-30, 0, -e, 30, 0, -e, 0, -30, -e, 0, 30, -e);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return g;
}
const RANGE_GEO = buildRangeGeometry();

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _o = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/** World replication points (instanced placeholder), the placement preview and the arrival gate. */
const ReplicationPoints = memo(function ReplicationPoints() {
  const store = useStore();
  const worldOrigin = useWorldOrigin();
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const ghostRef = useRef<THREE.Mesh>(null!);
  const rangeRef = useRef<THREE.LineSegments>(null!);

  useEffect(() => {
    const mesh = meshRef.current;
    for (let i = 0; i < MAX_POINTS; i++) mesh.setMatrixAt(i, _zero);
    mesh.instanceMatrix.needsUpdate = true;
  }, []);

  useFrame(() => {
    // ── Points ──
    const points = store.get(replicationPointsAtom);
    const mesh = meshRef.current;
    const wo = worldOrigin.worldOriginKm;
    const ship = worldOrigin.shipPosKm;
    let n = 0;
    for (let i = 0; i < points.length && n < MAX_POINTS; i++) {
      const pt = points[i];
      if (!isFrameId(pt.frameId)) continue;
      frameOriginKm(pt.frameId, _o);
      const x = _o.x + pt.positionKm[0], y = _o.y + pt.positionKm[1], z = _o.z + pt.positionKm[2];
      const dx = x - ship.x, dy = y - ship.y, dz = z - ship.z;
      if (dx * dx + dy * dy + dz * dz > DRAW_RANGE_KM * DRAW_RANGE_KM) continue;
      _p.set((x - wo.x) * 1000, (y - wo.y) * 1000, (z - wo.z) * 1000);
      _q.set(pt.quaternion[0], pt.quaternion[1], pt.quaternion[2], pt.quaternion[3]);
      mesh.setMatrixAt(n++, _m.compose(_p, _q, _s));
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;

    // ── Placement preview: follows the (interpolated) nose; colour from the last HUD-rate check ──
    const preview = store.get(placementModeAtom);
    const ghost = ghostRef.current;
    const range = rangeRef.current;
    ghost.visible = range.visible = preview;
    if (preview) {
      const d = REPLICATION_TUNING.placeDistanceKm * 1000;
      _fwd.copy(shipView.forward);
      // The ship mesh sits at the local origin.
      ghost.position.set(_fwd.x * d, _fwd.y * d, _fwd.z * d);
      _q.setFromUnitVectors(_p.set(0, 0, 1), _fwd);
      ghost.quaternion.copy(_q);
      range.position.copy(ghost.position);
      range.quaternion.copy(_q);
      ghost.material = placementPreview.valid ? GHOST_OK : GHOST_BAD;
      range.material = placementPreview.valid ? LINE_OK : LINE_BAD;
    }

    // ── Arrival gate: recovery stays paused until the area around the ship has streamed in ──
    if (repositionState.arrivalSince > 0) {
      repositionState.arrivalFrames++;
      const now = performance.now();
      const rt = getActiveAsteroidRuntime();
      const s = getLocalPlayerShip();
      const chunksIn = !rt || !s || arrivalChunksReady(s.absPosKm, ARRIVAL_REACH_KM, (f, k) => rt.getFieldRuntime(f)?.hasChunk(k) ?? false);
      const ready = repositionState.arrivalFrames >= ARRIVAL_MIN_FRAMES && chunksIn && nearFieldLoadSettled();
      if (ready || now - repositionState.arrivalSince > ARRIVAL_TIMEOUT_MS) endArrival(now);
    }
  });

  return (
    <>
      <instancedMesh ref={meshRef} args={[POINT_GEO, POINT_MAT, MAX_POINTS]} frustumCulled={false} />
      <mesh ref={ghostRef} geometry={POINT_GEO} material={GHOST_OK} visible={false} frustumCulled={false} />
      <lineSegments ref={rangeRef} geometry={RANGE_GEO} material={LINE_OK} visible={false} frustumCulled={false} />
    </>
  );
});

export default ReplicationPoints;
