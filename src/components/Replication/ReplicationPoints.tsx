"use client";

import { memo, Suspense, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import { isFrameId } from "@/sim/frames";
import { getLocalPlayerShip } from "@/sim/entities";
import { emitterColor } from "@/components/space/emissivePhotometry";
import { registerPreExposedEmissive } from "@/components/space/preExposedEmissive";
import { REPLICATION_BERTH, REPLICATION_TUNING } from "@/sim/replication/points";
import { arrivalChunksReady } from "@/sim/replication/clearance";
import { ARRIVAL_TIMEOUT_MS, endArrival, repositionState } from "@/sim/ship/reposition";
import { nearFieldLoadSettled } from "@/sim/physics/nearField";
import { getActiveAsteroidRuntime } from "@/sim/asteroids/runtimeContext";
import { placementModeAtom, placementPreview, replicationPointsAtom } from "@/store/replication";
import { shipView } from "@/components/Camera/shipView";
import { ReplicationPointColliders, ReplicationPointGhost, ReplicationPointModels } from "./ReplicationPointModel";

/** Arrival gate: streamed chunks within this reach of the ship, km. */
const ARRIVAL_REACH_KM = 1.5;
const ARRIVAL_MIN_FRAMES = 3;

const LINE_OK = new THREE.LineBasicMaterial({ color: emitterColor("replication_preview"), transparent: true, opacity: 0.6 });
const LINE_BAD = new THREE.LineBasicMaterial({ color: emitterColor("replication_preview_bad"), transparent: true, opacity: 0.6 });
[LINE_OK, LINE_BAD].forEach((m) => registerPreExposedEmissive(m));

/** Range indicator: the rock-clearance ring and the emergence leg outside the berth. */
function buildRangeGeometry(): THREE.BufferGeometry {
  const r = REPLICATION_TUNING.pointRockClearanceM;
  const seg = 48;
  const pts: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    pts.push(Math.cos(a0) * r, Math.sin(a0) * r, 0, Math.cos(a1) * r, Math.sin(a1) * r, 0);
  }
  const { yM, faceZM, spawnClearanceM } = REPLICATION_BERTH;
  const e = faceZM - spawnClearanceM;
  pts.push(0, yM, faceZM, 0, yM, e);
  pts.push(-8, yM, e, 8, yM, e, 0, yM - 8, e, 0, yM + 8, e);
  // Point the marker away from the door, along the new ship's nose.
  pts.push(0, yM, e, 0, yM, e - 12, 0, yM, e - 12, -4, yM, e - 7, 0, yM, e - 12, 4, yM, e - 7);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return g;
}
const RANGE_GEO = buildRangeGeometry();

/** World replication points, placement preview and the recovery arrival gate. */
const ReplicationPoints = memo(function ReplicationPoints() {
  const points = useAtomValue(replicationPointsAtom);
  const preview = useAtomValue(placementModeAtom);
  const hasDeployedPoint = points.some((point) => !point.starter && isFrameId(point.frameId));
  const rangeRef = useRef<THREE.LineSegments>(null!);

  useFrame(() => {
    const range = rangeRef.current;
    range.visible = preview;
    if (preview) {
      range.position.copy(shipView.forward).multiplyScalar(REPLICATION_TUNING.placeDistanceKm * 1000);
      range.quaternion.copy(shipView.quaternion);
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
      {hasDeployedPoint && (
        <>
          <Suspense fallback={null}><ReplicationPointColliders /></Suspense>
          <Suspense fallback={null}><ReplicationPointModels /></Suspense>
        </>
      )}
      {preview && <Suspense fallback={null}><ReplicationPointGhost /></Suspense>}
      <lineSegments ref={rangeRef} geometry={RANGE_GEO} material={LINE_OK} visible={false} frustumCulled={false} />
    </>
  );
});

export default ReplicationPoints;
