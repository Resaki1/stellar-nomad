"use client";

import { memo, useEffect, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useStore } from "jotai";
import { wrecksAtom, collectWreckAtom, isDeadAtom } from "@/store/death";
import { cargoRemainingUnitsAtom, addCargoAtom } from "@/store/cargo";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { emitterColor } from "@/components/space/emissivePhotometry";
import { registerPreExposedEmissive } from "@/components/space/preExposedEmissive";

// ── Tuning ───────────────────────────────────────────────────────────
/** Beam locks on when ship is within this range (km). */
const BEAM_ACTIVATION_KM = 0.3; // 300 meters
/** Cargo collected when cube reaches this distance from ship (km). */
const COLLECTION_DIST_KM = 0.01; // 10 meters
/** Pull speed — fraction of remaining distance closed per second. */
const PULL_RATE = 1.5;

/** Max wrecks we allocate GPU slots for. */
const MAX_WRECKS = 16;

const BOX_SIZE = 2; // meters

// ── Shared geometry + materials ──────────────────────────────────────
const WRECK_GEO = new THREE.BoxGeometry(BOX_SIZE, BOX_SIZE, BOX_SIZE);
const WRECK_MAT = new THREE.MeshStandardMaterial({
  color: new THREE.Color(0.35, 0.35, 0.38),
  roughness: 0.85,
  metalness: 0.2,
  // ⚠⚠ EMISSIVE REMOVED — LIGHTING_PLAN D26 step 1, and it derives to zero.
  // This was `(0.08, 0.08, 0.1) × 0.4` = **197 cd/m²** of hull self-emission. A
  // wrecked hull holding 600 K of residual heat emits **6.0e-7 cd/m²**, i.e.
  // 3.3e8× less; and there is no temperature that glows visibly without also
  // being visibly molten (1000 K, where "dull red heat" appears, is 2.7 cd/m²
  // and still invisible on screen). So the old value was not a dim glow, it was
  // ambient light smuggled in as emission — the exact defect D26 is about.
  //
  // 🔑 A cold object in space is lit by the sun and the sky, and both of those
  // are now real: `SunLight` is distance-correct (Phase 3a) and the sky is an
  // actual SH probe over the star catalogue (D29). If wrecks turn out to be hard
  // to FIND, that is a navigation-marker problem, not a material problem — do
  // not put the glow back.
  emissiveIntensity: 0,
});

// Salvage tractor beam. Design value, but now a STATED one: 3,972 cd/m² at the
// material and 2,383 cd/m² rendered through the 0.6 opacity below — matching the
// authored (0.4, 0.7, 1.0) exactly. Sci-fi tech has no physical referent to
// derive from; what matters is that it sits on the same scale as everything else
// and that it is pre-exposed. See emissivePhotometry.ts.
const BEAM_MAT = new THREE.LineBasicMaterial({
  color: emitterColor("wreck_beam"),
  transparent: true,
  opacity: 0.6,
});

// D25: session-lifetime singleton, so one registration. ⚠ Only the BEAM is
// registered — `WRECK_MAT` no longer emits, and registering a black `emissive`
// would add a permanent zero row to the audit for nothing. If a wreck ever
// gains a real emissive (running lights, a reactor breach), register it then:
// the registry auto-targets `emissive` on a lit material and `color` on an unlit
// one, because scaling a lit material's `color` would pre-expose its REFLECTANCE.
registerPreExposedEmissive(BEAM_MAT);

// Beam line geometry — 2 points, updated every frame
const BEAM_GEO = new THREE.BufferGeometry();
const beamPositions = new Float32Array(MAX_WRECKS * 2 * 3); // 2 verts per beam, 3 floats each
BEAM_GEO.setAttribute("position", new THREE.BufferAttribute(beamPositions, 3));

// ── Reusable temps ───────────────────────────────────────────────────
const _pos = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _zeroMat = new THREE.Matrix4().makeScale(0, 0, 0);

// ── Per-wreck beam state (position in simulation km) ─────────────────
type BeamState = {
  wreckId: string;
  /** Current position in simulation km (pulled away from anchor toward ship). */
  x: number; y: number; z: number;
  /** Is the beam currently active (ship in range)? */
  active: boolean;
};

const WreckCollector = memo(function WreckCollector() {
  const store = useStore();
  const worldOrigin = useWorldOrigin();
  const meshRef = useRef<THREE.InstancedMesh>(null!);
  const beamLinesRef = useRef<THREE.LineSegments>(null!);
  const beamStatesRef = useRef<Map<string, BeamState>>(new Map());

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
    const beamLines = beamLinesRef.current;
    const isDead = store.get(isDeadAtom);
    const originKm = worldOrigin.worldOriginKm;
    const shipKm = worldOrigin.shipPosKm;
    const states = beamStatesRef.current;

    // Prune beam states for wrecks that no longer exist
    const wreckIds = new Set(wrecks.map((w) => w.id));
    states.forEach((_, id) => { if (!wreckIds.has(id)) states.delete(id); });

    const activationR2 = BEAM_ACTIVATION_KM * BEAM_ACTIVATION_KM;
    const collectR2 = COLLECTION_DIST_KM * COLLECTION_DIST_KM;
    let beamCount = 0;
    const posAttr = beamLines?.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;

    for (let i = 0; i < MAX_WRECKS; i++) {
      if (i >= wrecks.length) {
        if (mesh) mesh.setMatrixAt(i, _zeroMat);
        continue;
      }

      const w = wrecks[i];

      // Get or create beam state (position in simulation km)
      let bs = states.get(w.id);
      if (!bs) {
        bs = {
          wreckId: w.id,
          x: w.positionKm[0], y: w.positionKm[1], z: w.positionKm[2],
          active: false,
        };
        states.set(w.id, bs);
      }

      // Distance from ship to wreck's current position (km)
      const dx = bs.x - shipKm.x;
      const dy = bs.y - shipKm.y;
      const dz = bs.z - shipKm.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const inRange = !isDead && d2 < activationR2;
      bs.active = inRange;

      if (inRange) {
        // Pull toward ship position in km — exponential ease-in
        const alpha = 1 - Math.exp(-PULL_RATE * delta);
        bs.x += (shipKm.x - bs.x) * alpha;
        bs.y += (shipKm.y - bs.y) * alpha;
        bs.z += (shipKm.z - bs.z) * alpha;

        // Check collection (distance from current beam pos to ship, in km)
        const cdx = bs.x - shipKm.x;
        const cdy = bs.y - shipKm.y;
        const cdz = bs.z - shipKm.z;
        const cd2 = cdx * cdx + cdy * cdy + cdz * cdz;
        if (cd2 < collectR2) {
          const remaining = store.get(cargoRemainingUnitsAtom);
          if (remaining > 0) {
            const collected = store.set(collectWreckAtom, {
              wreckId: w.id,
              cargoRemaining: remaining,
            });
            for (const [resourceId, amount] of Object.entries(collected)) {
              if (amount > 0) {
                store.set(addCargoAtom, { resourceId, amount });
              }
            }
            continue;
          }
        }
      }
      // When out of range: cube stays at its current km position (no drift back)

      // Convert beam state km → local render-space meters for visuals
      const localX = (bs.x - originKm.x) * 1000;
      const localY = (bs.y - originKm.y) * 1000;
      const localZ = (bs.z - originKm.z) * 1000;

      // Update cube instance matrix
      if (mesh) {
        _pos.set(localX, localY, localZ);
        _mat.compose(_pos, _quat, _scale);
        mesh.setMatrixAt(i, _mat);
      }

      // Update beam line segment (ship at 0,0,0 → cube)
      if (posAttr && inRange) {
        const off = beamCount * 6;
        posAttr.array[off] = 0;
        posAttr.array[off + 1] = 0;
        posAttr.array[off + 2] = 0;
        posAttr.array[off + 3] = localX;
        posAttr.array[off + 4] = localY;
        posAttr.array[off + 5] = localZ;
        beamCount++;
      }
    }

    if (mesh) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.count = Math.min(wrecks.length, MAX_WRECKS);
    }

    if (beamLines && posAttr) {
      for (let j = beamCount * 6; j < posAttr.array.length; j++) {
        posAttr.array[j] = 0;
      }
      posAttr.needsUpdate = true;
      beamLines.geometry.setDrawRange(0, beamCount * 2);
    }
  });

  return (
    <>
      <instancedMesh
        ref={meshRef}
        args={[WRECK_GEO, WRECK_MAT, MAX_WRECKS]}
        frustumCulled={false}
      />
      <lineSegments ref={beamLinesRef} geometry={BEAM_GEO} material={BEAM_MAT} frustumCulled={false} />
    </>
  );
});

export default WreckCollector;
