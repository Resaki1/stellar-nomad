"use client";

import { shipView } from "@/components/Camera/shipView";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { hudHiddenAtom } from "@/store/store";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import * as THREE from "three";
import { Billboard } from "@react-three/drei";
import { registerPreExposedEmissive } from "@/components/space/preExposedEmissive";
import { pushBeam, pushBeamLights } from "@/components/VFX/beams";

import {
  miningStateAtom,
  pingWorldBuffer,
  miningBeamRequest,
  pulseCycleBuffer,
  miningBeamView,
  pulseMiningActiveAtom,
  asteroidMinedSignalAtom,
  inspectControl,
  type TargetedAsteroid,
  TARGET_FOCUS_TIME_S,
  PULSE_ON_S,
  PULSE_CYCLE_S,
} from "@/store/mining";
import { systemConfigAtom } from "@/store/system";
import { useAsteroidRuntime } from "@/sim/asteroids/runtimeContext";
import { newOpId, runOperation } from "@/store/operations";
import { buildMineOperation } from "@/sim/asteroids/mineOperation";
import { signalAudioActionAtom } from "@/store/audioSignals";
import { useWorldOrigin } from "@/sim/worldOrigin";
import type { AsteroidChunkData } from "@/sim/asteroids/runtimeTypes";
import { distancePointToAabbKm } from "@/sim/asteroids/shapes";
import { castAsteroidRayInField, copyHit, createAsteroidRayHit, rayHitInstance } from "@/sim/asteroids/asteroidRaycast";
import { getAsteroidMiningReward, computeMiningDurationS } from "@/sim/asteroids/resources";
import { remoteBurstLog, spawnVFXEventAtom } from "@/store/vfx";
import { shipConfigAtom, effectiveShipConfigAtom } from "@/store/shipConfig";
import { addToastAtom } from "@/store/toast";
import { computedModifiersAtom, getFlag, getMultiplier } from "@/store/modules";
import { shipRes, shipResControl } from "@/store/shipResources";
import { INSPECT_RANGE_M, INSPECT_TIME_S } from "@/data/content";
import { playAudio } from "@/audio";
import { isSimPaused } from "@/sim/simPause";
import { buildInspectOperation } from "@/sim/asteroids/inspectOperation";
import { localBeamPose, localRenderPose } from "@/sim/entities";
import { getLocalPlayerId } from "@/save/playerId";
import { onLoadedRockDestroyed } from "@/sim/asteroids/runtimeContext";
import { isFrameId, SYSTEM_FRAME_ID } from "@/sim/frames";

let _miningWorkSeen = 0;
/** Beam seconds the resource step granted since the last call (power-throttled, executed time). */
function takeMiningWork(): number {
  const total = shipRes.meter.miningWorkS;
  const work = total - _miningWorkSeen;
  _miningWorkSeen = total;
  return work > 0 ? work : 0;
}

// --------------------
// Gameplay / tuning
// --------------------
const MAX_TARGETING_DISTANCE_M = 10_000;
const MAX_TARGETING_DISTANCE_KM = MAX_TARGETING_DISTANCE_M / 1000;

// Targeting updates / stability
const RAYCAST_INTERVAL_S = 0.05; // 20 Hz ray selection
const STATE_COMMIT_INTERVAL_S = 1 / 30; // 30 Hz UI commits
const TARGET_LOCK_GRACE_S = 0.18;

// Requiring aim during mining
/** VFX plan §2 B1 (open question 3): a miss halts progress after one ray tick; no bending. */
const MINING_MISS_GRACE_S = 0.05;

// Targeting assist
const TARGET_HIT_RADIUS_SCALE = 1.25;
const TARGET_HIT_RADIUS_BONUS_M = 4;

// Beam visuals: the shared BeamRenderer (`src/components/VFX/beams.ts`, VFX plan §2 B2).

// Highlight visuals
const HIGHLIGHT_SEGMENTS = 96;
const HIGHLIGHT_RADIUS_MULT = 1.15;
const HIGHLIGHT_CORE_WIDTH_PX = 2.0;
const HIGHLIGHT_HALO_WIDTH_PX = 7.0;

// Ship lookup (beam starts at ship tip)
const PLAYER_SHIP_NAME = "playerShip";

// Ping Array
const MAX_PING_INDICATORS = 128;

// --------------------
// Colors (no arrays in JSX)
// --------------------
const COLOR_HIGHLIGHT_HALO = new THREE.Color(0.35, 0.85, 1.0);
const COLOR_HIGHLIGHT_CORE = new THREE.Color(0.85, 0.97, 1.0);
const COLOR_HIGHLIGHT_ARC = new THREE.Color(0.7, 0.95, 1.0);

// --------------------
// Temp objects (avoid allocations)
// --------------------
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _cameraKm = new THREE.Vector3();

const _tmp = new THREE.Vector3();
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  // Dev probe for vfx-beam.mjs: the player's beam this frame, plus the nose axis it must follow.
  (window as unknown as { __beam: unknown }).__beam = () => ({
    ...miningBeamView, hit: miningBeamView.hit.value,
    forward: shipView.forward.toArray(), radiusM: _beamHit.radiusM, t: _beamHit.t, castMs: _castMs,
    // Hit point's distance from the rock centre / radius: 1.000 would be the bounding sphere.
    surfOverR: Math.hypot(_beamHit.point[0] - _beamHit.center[0], _beamHit.point[1] - _beamHit.center[1],
      _beamHit.point[2] - _beamHit.center[2]) / Math.max(_beamHit.radiusM, 1e-9),
  });
}
/** Nearest beam hit this frame, and the field anchor (km) its field-local metres are relative to. */
const _beamHit = createAsteroidRayHit();
const _fieldHit = createAsteroidRayHit();
let _beamHitAnchor: readonly number[] = [0, 0, 0];
/** Last beam cast's CPU time, ms (dev probe). */
let _castMs = 0;

// Ship nose compute temps
const _shipBox = new THREE.Box3();
const _tmpBox = new THREE.Box3();
const _invRootWorld = new THREE.Matrix4();
const _meshToRoot = new THREE.Matrix4();

function makeCircleArray(segments: number): Float32Array {
  const arr = new Float32Array((segments + 1) * 3);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    arr[i * 3] = Math.cos(a);
    arr[i * 3 + 1] = Math.sin(a);
    arr[i * 3 + 2] = 0;
  }
  return arr;
}

function makeArcArray(
  segments: number,
  startAngleRad: number,
  endAngleRad: number
): Float32Array {
  const arr = new Float32Array((segments + 1) * 3);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const a = THREE.MathUtils.lerp(startAngleRad, endAngleRad, t);
    arr[i * 3] = Math.cos(a);
    arr[i * 3 + 1] = Math.sin(a);
    arr[i * 3 + 2] = 0;
  }
  return arr;
}

/** Ref handle for updating beam line positions each frame. */
type NativeLineHandle = {
  setPositions: (positions: number[]) => void;
  setOpacity: (opacity: number) => void;
};

/**
 * WebGPU-compatible replacement for drei's <Line>.
 * Uses native THREE.Line + LineBasicMaterial (auto-converted to NodeMaterial).
 * Line width is always 1px (GPU limitation), but avoids LineMaterial crash.
 */
const NativeLineSegment = memo(
  forwardRef<
    NativeLineHandle,
    {
      points: Float32Array | Array<[number, number, number]>;
      color: THREE.Color;
      opacity: number;
      depthTest?: boolean;
      depthWrite?: boolean;
      blending?: THREE.Blending;
      frustumCulled?: boolean;
    }
  >(function NativeLineSegment(
    { points, color, opacity, depthTest = true, depthWrite = false, blending = THREE.AdditiveBlending, frustumCulled = false },
    ref
  ) {
    const matRef = useRef<THREE.LineBasicMaterial>(null!);

    const lineObj = useMemo(() => {
      const geo = new THREE.BufferGeometry();
      let arr: Float32Array;
      if (points instanceof Float32Array) {
        arr = new Float32Array(points);
      } else {
        arr = new Float32Array(points.length * 3);
        for (let i = 0; i < points.length; i++) {
          arr[i * 3] = points[i][0];
          arr[i * 3 + 1] = points[i][1];
          arr[i * 3 + 2] = points[i][2];
        }
      }
      geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));

      const mat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthTest,
        depthWrite,
        blending,
        toneMapped: false,
      });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = frustumCulled;
      return line;
    }, [points, color, opacity, depthTest, depthWrite, blending, frustumCulled]);

    // D25: the beam is emissive and its colour is a plain CPU value, so it has
    // to be rescaled per frame from its authored colour. MEASURED as a missing
    // site by `__lum.preExposure(8)` — the laser darkened 8×.
    //
    // 🐛 FIXED HERE: this used to call `registerPreExposedEmissive(mat)` INSIDE
    // the useMemo above and drop the disposer. Every time one of those seven
    // dependencies changed, a new material was registered and the dead one was
    // never removed — so the registry grew for the whole session and kept
    // writing to disposed materials every frame. The registry's own doc warned
    // about exactly this; the warning was written and then not followed.
    useEffect(() => {
      const mat = lineObj.material as THREE.LineBasicMaterial;
      const unregister = registerPreExposedEmissive(mat);
      return () => {
        unregister();
        mat.dispose();
        lineObj.geometry.dispose();
      };
    }, [lineObj]);

    useImperativeHandle(ref, () => ({
      setPositions(positions: number[]) {
        const attr = lineObj.geometry.getAttribute("position") as THREE.BufferAttribute;
        const arr = attr.array as Float32Array;
        const count = Math.min(positions.length, arr.length);
        for (let i = 0; i < count; i++) arr[i] = positions[i];
        attr.needsUpdate = true;
      },
      setOpacity(value: number) {
        (lineObj.material as THREE.LineBasicMaterial).opacity = value;
      },
    }), [lineObj]);

    return <primitive object={lineObj} />;
  })
);

function clamp01(x: number) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Computes a stable "nose point" in the ship root's local space.
 * Ship forward is assumed to be +Z in model space.
 */
export function computeShipNoseLocal(root: THREE.Object3D, out: THREE.Vector3): boolean {
  _shipBox.makeEmpty();

  root.updateMatrixWorld(true);
  _invRootWorld.copy(root.matrixWorld).invert();
  const socket = root.getObjectByName("socket_mining");
  if (socket) {
    out.setFromMatrixPosition(socket.matrixWorld).applyMatrix4(_invRootWorld);
    return true;
  }

  let hadAnyMesh = false;

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom) return;

    hadAnyMesh = true;

    if (!geom.boundingBox) geom.computeBoundingBox();
    if (!geom.boundingBox) return;

    _tmpBox.copy(geom.boundingBox);

    _meshToRoot.multiplyMatrices(_invRootWorld, mesh.matrixWorld);
    _tmpBox.applyMatrix4(_meshToRoot);

    _shipBox.union(_tmpBox);
  });

  if (!hadAnyMesh || _shipBox.isEmpty()) return false;

  out.set(
    (_shipBox.min.x + _shipBox.max.x) / 2,
    (_shipBox.min.y + _shipBox.max.y) / 2,
    _shipBox.max.z
  );

  return true;
}

type MiningBeamProps = {
  start: THREE.Vector3;
  end: THREE.Vector3;
  /** Another pilot's beam (mutable): skipped while off; its pulse phase rides in `dim`. */
  remote?: { on: boolean; dim: boolean };
  /** The beam ends on a surface (impact spot drawn); false = it runs to its full range. */
  hit?: { value: boolean };
  /** Laser power multiplier (B3): core radiance ∝ power, width ∝ power^¼. */
  power?: number;
};

/** Pulse-train envelope: sharp rise (τ 15 ms), quick fall (τ 40 ms) — B3's visible pulses. */
function pulseEnvelope(): number {
  const t = pulseCycleBuffer.timer;
  if (!pulseCycleBuffer.pulsing) return 1;
  return t < PULSE_ON_S ? 1 - Math.exp(-t / 0.015) : Math.exp(-(t - PULSE_ON_S) / 0.04);
}

/**
 * One mining beam, drawn by the shared BeamRenderer (VFX plan §2 B2) with its muzzle and
 * impact as light points (B4). Player, co-op pilots and drones all go through `pushBeam`.
 */
export const MiningBeam = ({ start, end, remote, hit, power = 1 }: MiningBeamProps) => {
  useFrame(() => {
    if (remote && !remote.on) return;
    const intensity = remote ? (remote.dim ? 0 : 1) : pulseEnvelope();
    if (intensity <= 0.002) return;
    pushBeam(start.x, start.y, start.z, end.x, end.y, end.z, intensity, power);
    pushBeamLights(start.x, start.y, start.z, end.x, end.y, end.z, hit ? hit.value : true, intensity, power);
  });
  return null;
};

type AsteroidHighlightProps = {
  positionLocal: [number, number, number];
  radiusM: number;
  focus01: number;
  mining: boolean;
  miningProgress01: number;
};

const AsteroidHighlight = ({
  positionLocal,
  radiusM,
  focus01,
  mining,
  miningProgress01,
}: AsteroidHighlightProps) => {
  const ringRef = useRef<THREE.Group | null>(null);
  const arcRef = useRef<THREE.Group | null>(null);

  const circlePts = useMemo(() => makeCircleArray(HIGHLIGHT_SEGMENTS), []);
  const arcPts = useMemo(() => makeArcArray(32, -Math.PI * 0.15, Math.PI * 0.45), []);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;

    if (ringRef.current) {
      const pulse = 1 + Math.sin(t * 3.5) * 0.02 * (0.2 + 0.8 * focus01);
      const base = radiusM * HIGHLIGHT_RADIUS_MULT;
      ringRef.current.scale.setScalar(base * pulse);
      ringRef.current.rotation.z = t * 0.25;
    }

    if (arcRef.current) {
      const speed = mining ? 1.6 : 0.9;
      arcRef.current.rotation.z = -t * speed;
    }
  });

  const coreOpacity = (0.15 + 0.65 * focus01) * (mining ? 1.0 : 0.85);
  const haloOpacity = (0.04 + 0.18 * focus01) * (mining ? 1.15 : 1.0);
  const arcOpacity = (0.12 + 0.28 * focus01) * (0.7 + 0.6 * miningProgress01);

  return (
    <group position={positionLocal} renderOrder={1500}>
      <Billboard>
        <group ref={ringRef}>
          <NativeLineSegment
            points={circlePts}
            color={COLOR_HIGHLIGHT_HALO}
            opacity={haloOpacity}
            depthTest={false}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />

          <NativeLineSegment
            points={circlePts}
            color={COLOR_HIGHLIGHT_CORE}
            opacity={coreOpacity}
            depthTest={false}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />

          <group ref={arcRef}>
            <NativeLineSegment
              points={arcPts}
              color={COLOR_HIGHLIGHT_ARC}
              opacity={arcOpacity}
              depthTest={false}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </group>
        </group>
      </Billboard>
    </group>
  );
};

const MiningSystem = () => {
  const { scene } = useThree();
  const worldOrigin = useWorldOrigin();
  const asteroidRuntime = useAsteroidRuntime();
  const store = useStore();
  const hudHidden = useAtomValue(hudHiddenAtom);
  const systemConfig = useAtomValue(systemConfigAtom);

  const [miningState, setMiningState] = useAtom(miningStateAtom);
  const shipConfig = useAtomValue(effectiveShipConfigAtom);

  // Latest mining state ref (avoid render timing issues inside useFrame)
  const miningStateRef = useRef(miningState);
  useEffect(() => {
    miningStateRef.current = miningState;
  }, [miningState]);

  // Latest ship config ref for use inside useFrame
  const shipConfigRef = useRef(shipConfig);
  useEffect(() => {
    shipConfigRef.current = shipConfig;
  }, [shipConfig]);

  // Build field anchor map from system config
  const fieldAnchorMap = useMemo(() => {
    const map = new Map<string, [number, number, number]>();
    for (const field of systemConfig.asteroidFields ?? []) {
      if (field.enabled !== false) map.set(field.id, field.anchorKm);
    }
    return map;
  }, [systemConfig]);

  // Ship object + nose point
  const shipObjRef = useRef<THREE.Object3D | null>(null);
  const shipNoseLocalRef = useRef(new THREE.Vector3(0, 0, 0));
  const shipNoseReadyRef = useRef(false);

  // Internal state refs
  const raycastAccRef = useRef(0);
  const commitAccRef = useRef(0);

  const targetIdRef = useRef<number | null>(null);
  /** Instance ids are unique per chunk only, so the target is (chunk, id). */
  const targetChunkRef = useRef<string>("");
  const targetLostTimeRef = useRef(0);
  const targetingTimeRef = useRef(0);

  const miningAimLostTimeRef = useRef(0);

  const currentSnapshotRef = useRef<TargetedAsteroid | null>(null);
  const miningProgressRef = useRef(0);

  // One frame delay to remove the asteroid after state update is committed
  const pendingRemovalIdRef = useRef<{ instanceId: number; fieldId: string; chunkKey: string } | null>(null);
  const pendingMiningRewardRef = useRef<
    {
      instanceId: number;
      fieldId: string;
      radiusM: number;
    } | null
  >(null);
  
  const shipPosLocalRef = useRef(new THREE.Vector3());
  const beamStartLocalRef = useRef(new THREE.Vector3());
  const beamEndLocalRef = useRef(new THREE.Vector3());


  const miningDurationSRef = useRef<number>(5);
  const miningDurationForAsteroidIdRef = useRef<number | null>(null);

  // --- Pulse mining state
  const pulseMiningActive = useAtomValue(pulseMiningActiveAtom);
  const pulseMiningActiveRef = useRef(pulseMiningActive);
  useEffect(() => { pulseMiningActiveRef.current = pulseMiningActive; }, [pulseMiningActive]);
  const pulseCycleTimerRef = useRef(0);

  const signalAudio = useSetAtom(signalAudioActionAtom);
  const addToast = useSetAtom(addToastAtom);
  const spawnVFX = useSetAtom(spawnVFXEventAtom);
  const incrementMinedSignal = useSetAtom(asteroidMinedSignalAtom);

  // Ping Array: modules state for flags
  const modifiers = useAtomValue(computedModifiersAtom);
  const modifiersRef = useRef(modifiers);
  useEffect(() => { modifiersRef.current = modifiers; }, [modifiers]);

  // Nearby asteroid data for ping bracket overlay (written to atom)
  type RawPingEntry = { instanceId: number; x: number; y: number; z: number; radiusM: number };
  const pingRawRef = useRef<RawPingEntry[]>([]);

  // Every accepted destruction of a loaded rock plays once, including the local player's mine.
  // Resync deltas (by "") are rocks gone while away, not something seen happening.
  useEffect(
    () =>
      onLoadedRockDestroyed((r) => {
        if (r.by === "") return;
        const field = systemConfig.asteroidFields?.find(f => f.id === r.fieldId);
        if (!field) return;
        const a = field.anchorKm;
        const wo = worldOrigin.worldOriginKm;
        const position: [number, number, number] = [
          (a[0] + r.chunkOriginKm[0] - wo.x) * 1000 + r.localM[0],
          (a[1] + r.chunkOriginKm[1] - wo.y) * 1000 + r.localM[1],
          (a[2] + r.chunkOriginKm[2] - wo.z) * 1000 + r.localM[2],
        ];
        const frameId = field.anchorOffsetKm && isFrameId(field.anchorBody) ? field.anchorBody : SYSTEM_FRAME_ID;
        const rel = frameId === SYSTEM_FRAME_ID ? a : field.anchorOffsetKm!;
        spawnVFX({ type: r.cause, position, radiusM: r.radiusM, shake: 0, silent: true, debrisAt: { frameId, positionKm: [
          rel[0] + r.chunkOriginKm[0] + r.localM[0] / 1000,
          rel[1] + r.chunkOriginKm[1] + r.localM[1] / 1000,
          rel[2] + r.chunkOriginKm[2] + r.localM[2] / 1000,
        ] } });
        if (r.cause === "mined" && r.by !== getLocalPlayerId()) {
          remoteBurstLog.push({ at: performance.now(), fieldId: r.fieldId, chunkKey: r.chunkKey, instanceId: r.instanceId, position, radiusM: r.radiusM });
          if (remoteBurstLog.length > 16) remoteBurstLog.shift();
        }
      }),
    [systemConfig, worldOrigin, spawnVFX],
  );

  // Location captured at completion: the chunk may stream out before this runs.
  const removeAsteroid = useCallback(
    (t: { instanceId: number; fieldId: string; chunkKey: string }) =>
      runOperation({ type: "asteroid.destroy", opId: newOpId(), fieldId: t.fieldId, chunkKey: t.chunkKey, instanceId: t.instanceId, cause: "mined" }),
    []
  );

  /** Submit the close inspection of `snap` (the scanner's claim; feedback from the accepted result). */
  const submitInspection = useCallback(
    (snap: TargetedAsteroid) => {
      const loc = snap.location;
      const chunk = asteroidRuntime.getFieldRuntime(loc.fieldId)?.getChunk(loc.chunkKey);
      const inst = chunk?.instancesByModel[loc.modelId];
      if (!chunk || !inst) return;
      const i = loc.localIndex * 3;
      const op = buildInspectOperation(
        systemConfig,
        { fieldId: loc.fieldId, chunkKey: loc.chunkKey, instanceId: snap.instanceId, radiusM: snap.radiusM, chunkOriginKm: chunk.originKm, localM: [inst.positionsM[i], inst.positionsM[i + 1], inst.positionsM[i + 2]] },
        newOpId(),
      );
      if (!op) return;
      runOperation(op, (o) => {
        if (o.status !== "accepted" || o.result.type !== "survey.inspect") return;
        playAudio("mining.inspect.complete");
        // The card's contents row is the result; only a NEW material is worth a notification.
        if (o.result.newFamilies.length > 0) {
          addToast({ message: "New material", kind: "success", audio: "silent", values: o.result.newFamilies.map((id) => ({ id })) });
        }
      });
    },
    [asteroidRuntime, systemConfig, addToast],
  );

  const getTargetSnapshot = useCallback(
    (instanceId: number, chunkKey: string): TargetedAsteroid | null => {
      const fieldId = chunkKey.slice(0, chunkKey.lastIndexOf(":"));
      const loc = asteroidRuntime.getFieldRuntime(fieldId)?.getInstanceLocation(chunkKey, instanceId) ?? null;
      if (!loc) return null;

      const fieldRuntime = asteroidRuntime.getFieldRuntime(loc.fieldId);
      if (!fieldRuntime) return null;

      const chunk = fieldRuntime.getChunk(loc.chunkKey);
      if (!chunk) return null;

      const inst = chunk.instancesByModel[loc.modelId];
      if (!inst) return null;

      const i = loc.localIndex;
      if (i < 0 || i >= inst.count) return null;

      const pIdx = i * 3;
      const ax = inst.positionsM[pIdx];
      const ay = inst.positionsM[pIdx + 1];
      const az = inst.positionsM[pIdx + 2];
      const radiusM = inst.radiiM[i];

      const fieldAnchorKm = fieldAnchorMap.get(loc.fieldId) ?? [0, 0, 0];

      const chunkOriginLocalX =
        (fieldAnchorKm[0] + chunk.originKm[0] - worldOrigin.worldOriginKm.x) * 1000;
      const chunkOriginLocalY =
        (fieldAnchorKm[1] + chunk.originKm[1] - worldOrigin.worldOriginKm.y) * 1000;
      const chunkOriginLocalZ =
        (fieldAnchorKm[2] + chunk.originKm[2] - worldOrigin.worldOriginKm.z) * 1000;

      const xLocal = chunkOriginLocalX + ax;
      const yLocal = chunkOriginLocalY + ay;
      const zLocal = chunkOriginLocalZ + az;

      const dx = xLocal - shipPosLocalRef.current.x;
      const dy = yLocal - shipPosLocalRef.current.y;
      const dz = zLocal - shipPosLocalRef.current.z;
      const distanceM = Math.sqrt(dx * dx + dy * dy + dz * dz);

      return {
        instanceId,
        location: loc,
        distanceM,
        positionLocal: [xLocal, yLocal, zLocal],
        radiusM,
      };
    },
    [asteroidRuntime, fieldAnchorMap, worldOrigin]
  );

  // Collect nearby asteroids within targeting range for ping bracket overlay.
  // Separated from raycast so it can run even while mining.
  const collectPingCandidates = useCallback((): RawPingEntry[] => {
    const shipKm = worldOrigin.shipPosKm;
    const pingEnabled = getFlag(modifiersRef.current, "scanner.pingHighlightEnabled");
    if (!pingEnabled) return [];

    const rangeMult = shipConfigRef.current.scannerRangeMult;
    const maxDistM = MAX_TARGETING_DISTANCE_M * rangeMult;
    const maxDistKm = MAX_TARGETING_DISTANCE_KM * rangeMult;
    const nearbyCollected: RawPingEntry[] = [];

    asteroidRuntime.forEachField((fieldRuntime, fieldId) => {
      const fieldAnchor = fieldAnchorMap.get(fieldId) ?? [0, 0, 0];

      const shipLocalKm: [number, number, number] = [
        shipKm.x - fieldAnchor[0],
        shipKm.y - fieldAnchor[1],
        shipKm.z - fieldAnchor[2],
      ];

      fieldRuntime.chunks.forEach((chunk) => {
        const aabbDistKm = distancePointToAabbKm(
          shipLocalKm[0],
          shipLocalKm[1],
          shipLocalKm[2],
          chunk.aabbMinKm[0],
          chunk.aabbMinKm[1],
          chunk.aabbMinKm[2],
          chunk.aabbMaxKm[0],
          chunk.aabbMaxKm[1],
          chunk.aabbMaxKm[2]
        );

        if (aabbDistKm > maxDistKm + chunk.maxRadiusM / 1000) return;

        const byModel = chunk.instancesByModel;
        const shipCxM = (shipLocalKm[0] - chunk.originKm[0]) * 1000;
        const shipCyM = (shipLocalKm[1] - chunk.originKm[1]) * 1000;
        const shipCzM = (shipLocalKm[2] - chunk.originKm[2]) * 1000;

        const chunkOriginLocalX =
          (fieldAnchor[0] + chunk.originKm[0] - worldOrigin.worldOriginKm.x) * 1000;
        const chunkOriginLocalY =
          (fieldAnchor[1] + chunk.originKm[1] - worldOrigin.worldOriginKm.y) * 1000;
        const chunkOriginLocalZ =
          (fieldAnchor[2] + chunk.originKm[2] - worldOrigin.worldOriginKm.z) * 1000;

        for (const modelId in byModel) {
          const inst = byModel[modelId];
          const positions = inst.positionsM;
          const radii = inst.radiiM;
          const ids = inst.instanceIds;

          for (let i = 0; i < inst.count && nearbyCollected.length < MAX_PING_INDICATORS; i++) {
            const pIdx = i * 3;
            const ax = positions[pIdx];
            const ay = positions[pIdx + 1];
            const az = positions[pIdx + 2];

            const dxS = ax - shipCxM;
            const dyS = ay - shipCyM;
            const dzS = az - shipCzM;
            if (dxS * dxS + dyS * dyS + dzS * dzS > maxDistM * maxDistM) continue;

            nearbyCollected.push({
              instanceId: ids[i],
              x: chunkOriginLocalX + ax,
              y: chunkOriginLocalY + ay,
              z: chunkOriginLocalZ + az,
              radiusM: radii[i],
            });
          }
        }
      });
    });

    return nearbyCollected;
  }, [asteroidRuntime, fieldAnchorMap, worldOrigin]);

  const findNearestAsteroidOnRay = useCallback((): TargetedAsteroid | null => {
    const shipKm = worldOrigin.shipPosKm;
    const rangeMult = shipConfigRef.current.scannerRangeMult;
    const maxDistM = MAX_TARGETING_DISTANCE_M * rangeMult;
    const maxDistKm = MAX_TARGETING_DISTANCE_KM * rangeMult;

    // The nose ray, not the camera's: the chase camera lags, so screen centre is not the nose.
    _rayDir.copy(shipView.forward);
    _rayOrigin.copy(shipView.position);

    // ray origin in sim-km
    _cameraKm.set(
      worldOrigin.worldOriginKm.x + _rayOrigin.x / 1000,
      worldOrigin.worldOriginKm.y + _rayOrigin.y / 1000,
      worldOrigin.worldOriginKm.z + _rayOrigin.z / 1000
    );

    const preferredId = targetIdRef.current;

    let best: TargetedAsteroid | null = null;
    let bestT = Infinity;

    let locked: TargetedAsteroid | null = null;
    let lockedT = Infinity;

    const checkChunk = (chunk: AsteroidChunkData, fieldAnchorKm: [number, number, number]) => {
      const byModel = chunk.instancesByModel;

      // Ship position in field-local km
      const shipFx = shipKm.x - fieldAnchorKm[0];
      const shipFy = shipKm.y - fieldAnchorKm[1];
      const shipFz = shipKm.z - fieldAnchorKm[2];

      // Camera position in field-local km
      const camFx = _cameraKm.x - fieldAnchorKm[0];
      const camFy = _cameraKm.y - fieldAnchorKm[1];
      const camFz = _cameraKm.z - fieldAnchorKm[2];

      // Ship / camera in chunk-local meters
      const shipCxM = (shipFx - chunk.originKm[0]) * 1000;
      const shipCyM = (shipFy - chunk.originKm[1]) * 1000;
      const shipCzM = (shipFz - chunk.originKm[2]) * 1000;

      const camCxM = (camFx - chunk.originKm[0]) * 1000;
      const camCyM = (camFy - chunk.originKm[1]) * 1000;
      const camCzM = (camFz - chunk.originKm[2]) * 1000;

      // Chunk origin in local render meters
      const chunkOriginLocalX =
        (fieldAnchorKm[0] + chunk.originKm[0] - worldOrigin.worldOriginKm.x) * 1000;
      const chunkOriginLocalY =
        (fieldAnchorKm[1] + chunk.originKm[1] - worldOrigin.worldOriginKm.y) * 1000;
      const chunkOriginLocalZ =
        (fieldAnchorKm[2] + chunk.originKm[2] - worldOrigin.worldOriginKm.z) * 1000;

      for (const modelId in byModel) {
        const inst = byModel[modelId];
        const positions = inst.positionsM;
        const radii = inst.radiiM;
        const ids = inst.instanceIds;
        const count = inst.count;

        for (let i = 0; i < count; i++) {
          const pIdx = i * 3;

          const ax = positions[pIdx];
          const ay = positions[pIdx + 1];
          const az = positions[pIdx + 2];

          const radiusM = radii[i];

          // Ship range gate
          const dxS = ax - shipCxM;
          const dyS = ay - shipCyM;
          const dzS = az - shipCzM;

          const distShipSq = dxS * dxS + dyS * dyS + dzS * dzS;
          if (distShipSq > maxDistM * maxDistM) continue;

          // Camera ray test (crosshair selection)
          const dxC = ax - camCxM;
          const dyC = ay - camCyM;
          const dzC = az - camCzM;

          const projT = dxC * _rayDir.x + dyC * _rayDir.y + dzC * _rayDir.z;
          if (projT <= 0) continue;

          const vLenSq = dxC * dxC + dyC * dyC + dzC * dzC;
          const closestDistSq = vLenSq - projT * projT;

          const hitRadius = radiusM * TARGET_HIT_RADIUS_SCALE + TARGET_HIT_RADIUS_BONUS_M;
          if (closestDistSq > hitRadius * hitRadius) continue;

          const instanceId = ids[i] >>> 0;

          const asteroidLocalX = chunkOriginLocalX + ax;
          const asteroidLocalY = chunkOriginLocalY + ay;
          const asteroidLocalZ = chunkOriginLocalZ + az;

          const candidate: TargetedAsteroid = {
            instanceId,
            location: {
              fieldId: chunk.fieldId,
              chunkKey: chunk.key,
              modelId,
              localIndex: i,
            },
            distanceM: Math.sqrt(distShipSq),
            positionLocal: [asteroidLocalX, asteroidLocalY, asteroidLocalZ],
            radiusM,
          };

          // Prefer existing target to reduce flicker
          if (preferredId !== null && instanceId === preferredId && chunk.key === targetChunkRef.current) {
            if (projT < lockedT) {
              locked = candidate;
              lockedT = projT;
            }
            continue;
          }

          if (projT < bestT) {
            best = candidate;
            bestT = projT;
          }
        }
      }
    };

    asteroidRuntime.forEachField((fieldRuntime, fieldId) => {
      const fieldAnchor = fieldAnchorMap.get(fieldId) ?? [0, 0, 0];

      const shipLocalKm: [number, number, number] = [
        shipKm.x - fieldAnchor[0],
        shipKm.y - fieldAnchor[1],
        shipKm.z - fieldAnchor[2],
      ];

      fieldRuntime.chunks.forEach((chunk) => {
        const aabbDistKm = distancePointToAabbKm(
          shipLocalKm[0],
          shipLocalKm[1],
          shipLocalKm[2],
          chunk.aabbMinKm[0],
          chunk.aabbMinKm[1],
          chunk.aabbMinKm[2],
          chunk.aabbMaxKm[0],
          chunk.aabbMaxKm[1],
          chunk.aabbMaxKm[2]
        );

        if (aabbDistKm > maxDistKm + chunk.maxRadiusM / 1000) return;
        checkChunk(chunk, fieldAnchor);
      });
    });

    return locked ?? best;
  }, [asteroidRuntime, fieldAnchorMap, worldOrigin]);

  /** B1: nearest rock surface along a ray from `originLocal` (scene metres) → `_beamHit`. */
  const castBeam = useCallback((originLocal: THREE.Vector3, dir: THREE.Vector3, maxM: number, target: TargetedAsteroid | null): boolean => {
    const t0 = performance.now();
    let best = maxM;
    let found = false;
    const wo = worldOrigin.worldOriginKm;
    // The locked target first: its hit distance shortens the segment, so the field scan below
    // culls almost every chunk (0.2–0.3 ms → measured below when on target).
    if (target) {
      const loc = target.location;
      const chunk = asteroidRuntime.getFieldRuntime(loc.fieldId)?.getChunk(loc.chunkKey);
      const a = fieldAnchorMap.get(loc.fieldId) ?? [0, 0, 0];
      if (chunk && rayHitInstance((wo.x - a[0]) * 1000 + originLocal.x, (wo.y - a[1]) * 1000 + originLocal.y,
        (wo.z - a[2]) * 1000 + originLocal.z, dir.x, dir.y, dir.z, chunk, loc.modelId, loc.localIndex, best, _fieldHit) < best) {
        best = _fieldHit.t;
        found = true;
        copyHit(_fieldHit, _beamHit);
        _beamHitAnchor = a;
      }
    }
    asteroidRuntime.forEachField((fieldRuntime, fieldId) => {
      const a = fieldAnchorMap.get(fieldId) ?? [0, 0, 0];
      const ox = (wo.x - a[0]) * 1000 + originLocal.x;
      const oy = (wo.y - a[1]) * 1000 + originLocal.y;
      const oz = (wo.z - a[2]) * 1000 + originLocal.z;
      if (castAsteroidRayInField(fieldRuntime.chunks, ox, oy, oz, dir.x, dir.y, dir.z, best, _fieldHit)) {
        best = _fieldHit.t;
        found = true;
        copyHit(_fieldHit, _beamHit);
        _beamHitAnchor = a;
      }
    });
    _castMs = performance.now() - t0;
    return found;
  }, [asteroidRuntime, fieldAnchorMap, worldOrigin]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    // Dev micro-benchmark: average ms of `n` beam casts from the current pose (headless timers are 0.1 ms).
    (window as unknown as { __beamBench: unknown }).__beamBench = (n = 200, withTarget = true) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) castBeam(beamStartLocalRef.current, shipView.forward, MAX_TARGETING_DISTANCE_M, withTarget ? currentSnapshotRef.current : null);
      return (performance.now() - t0) / n;
    };
  }, [castBeam]);

  useEffect(() => () => {
    miningBeamRequest.on = false;
    miningBeamView.on = false;
  }, []);

  useFrame((_, delta) => {
    pendingRemovalIdRef.current = null;
    let isOverheatedNow = false;

    // --- Find ship object & compute nose once geometry is available
    if (!shipObjRef.current) {
      const obj = scene.getObjectByName(PLAYER_SHIP_NAME);
      if (obj) shipObjRef.current = obj;
    }
    if (shipObjRef.current && !shipNoseReadyRef.current) {
      shipNoseReadyRef.current = computeShipNoseLocal(shipObjRef.current, shipNoseLocalRef.current);
    }

    // --- Update ship position in local render space (meters)
    shipPosLocalRef.current.set(
      (worldOrigin.shipPosKm.x - worldOrigin.worldOriginKm.x) * 1000,
      (worldOrigin.shipPosKm.y - worldOrigin.worldOriginKm.y) * 1000,
      (worldOrigin.shipPosKm.z - worldOrigin.worldOriginKm.z) * 1000
    );

    // --- Beam start at ship nose (tip). Fallback to ship position if not ready.
    if (shipObjRef.current && shipNoseReadyRef.current) {
      _tmp.copy(shipNoseLocalRef.current);
      shipObjRef.current.localToWorld(_tmp);
      beamStartLocalRef.current.copy(_tmp);
    } else {
      beamStartLocalRef.current.copy(shipPosLocalRef.current);
    }

    const isMiningNow = miningStateRef.current.isMining;

    // --- Raycast selection tick (only when NOT mining)
    raycastAccRef.current += delta;
    if (raycastAccRef.current >= RAYCAST_INTERVAL_S) {
      raycastAccRef.current = 0;

      // Ping collection always runs (even during mining)
      pingRawRef.current = collectPingCandidates();

      if (!isMiningNow) {
        const hit = findNearestAsteroidOnRay();
        const hitId = hit?.instanceId ?? null;

        const prevId = targetIdRef.current;

        if (hitId !== null) {
          targetLostTimeRef.current = 0;

          if (prevId !== hitId || targetChunkRef.current !== hit?.location.chunkKey) {
            targetIdRef.current = hitId;
            targetChunkRef.current = hit?.location.chunkKey ?? "";
            targetingTimeRef.current = 0;
          }
        } else {
          // Grace before dropping target
          if (prevId !== null) {
            targetLostTimeRef.current += RAYCAST_INTERVAL_S;
            if (targetLostTimeRef.current > TARGET_LOCK_GRACE_S) {
              targetIdRef.current = null;
              targetingTimeRef.current = 0;
              targetLostTimeRef.current = 0;
            }
          }
        }
      }
    }

    // --- Resolve target snapshot every frame (authoritative)
    const targetId = targetIdRef.current;

    let snapshot: TargetedAsteroid | null = null;
    if (targetId !== null) {
      snapshot = getTargetSnapshot(targetId, targetChunkRef.current);

      if (!snapshot) {
        targetIdRef.current = null;
        targetingTimeRef.current = 0;
        targetLostTimeRef.current = 0;
      } else if (snapshot.distanceM > MAX_TARGETING_DISTANCE_M * shipConfigRef.current.scannerRangeMult) {
        targetIdRef.current = null;
        targetingTimeRef.current = 0;
        targetLostTimeRef.current = 0;
        snapshot = null;
      }
    }

    currentSnapshotRef.current = snapshot;

    // Keep beam-end ref warm so it's never stale when the beam first appears.
    // Without this, MiningBeam can mount (React state says isMining=true) one
    // frame before the mining block below writes a real endpoint — causing the
    // beam to flash to (0,0,0) or the previous asteroid's position.
    if (snapshot) {
      beamEndLocalRef.current.set(
        snapshot.positionLocal[0],
        snapshot.positionLocal[1],
        snapshot.positionLocal[2]
      );
    }

    // --- Targeting time accumulation (only while not mining)
    if (snapshot && !isMiningNow) {
      targetingTimeRef.current += delta;
    } else if (!snapshot) {
      targetingTimeRef.current = 0;
    }

    const focusTimeS = TARGET_FOCUS_TIME_S * shipConfigRef.current.scannerLockSpeedMult;
    const isFocused = !!snapshot && targetingTimeRef.current >= focusTimeS;

    // --- Close inspection: hold the lock within range; no consumable.
    if (inspectControl.requested) {
      const cfg = shipConfigRef.current;
      if (!snapshot || !isFocused || isMiningNow || snapshot.instanceId !== inspectControl.targetId) {
        inspectControl.requested = false;
        inspectControl.progress = 0;
      } else if (snapshot.distanceM <= INSPECT_RANGE_M * cfg.scannerInspectRangeMult && !isSimPaused()) {
        inspectControl.progress += delta / (INSPECT_TIME_S * cfg.scannerInspectTimeMult);
        if (inspectControl.progress >= 1) {
          inspectControl.requested = false;
          inspectControl.progress = 0;
          submitInspection(snapshot);
        }
      }
    }

    // --- Mining progression + must keep aim
    let cancelMining = false;

    if (isMiningNow) {
      // Mining requires a valid focused target
      if (!snapshot || !isFocused) {
        cancelMining = true;
        miningProgressRef.current = 0;
        miningAimLostTimeRef.current = 0;
      } else {
        // B1: the beam fires straight along the ship's forward axis from the mining socket and
        // ends on the first rock SURFACE it meets (the drawn LOD0 mesh). It never bends;
        // mining progresses only while that surface is the locked target.
        const cfg = shipConfigRef.current;
        const rangeM = MAX_TARGETING_DISTANCE_M * cfg.scannerRangeMult;
        const start = beamStartLocalRef.current;
        const hit = castBeam(start, shipView.forward, rangeM, snapshot);
        const onTarget = hit && _beamHit.instanceId === snapshot.instanceId && _beamHit.chunkKey === snapshot.location.chunkKey;
        if (hit) {
          beamEndLocalRef.current.set(
            (_beamHitAnchor[0] - worldOrigin.worldOriginKm.x) * 1000 + _beamHit.point[0],
            (_beamHitAnchor[1] - worldOrigin.worldOriginKm.y) * 1000 + _beamHit.point[1],
            (_beamHitAnchor[2] - worldOrigin.worldOriginKm.z) * 1000 + _beamHit.point[2],
          );
        } else {
          beamEndLocalRef.current.copy(start).addScaledVector(shipView.forward, rangeM);
        }
        const v = miningBeamView;
        v.on = true;
        v.hit.value = hit;
        v.onTarget = onTarget;
        start.toArray(v.start);
        beamEndLocalRef.current.toArray(v.end);
        if (hit) {
          v.normal[0] = _beamHit.normal[0]; v.normal[1] = _beamHit.normal[1]; v.normal[2] = _beamHit.normal[2];
          v.rock.fieldId = _beamHit.fieldId; v.rock.chunkKey = _beamHit.chunkKey; v.rock.instanceId = _beamHit.instanceId;
        } else {
          v.rock.instanceId = -1;
        }
        v.power = cfg.miningPowerMult;

        if (miningDurationForAsteroidIdRef.current !== snapshot.instanceId) {
          miningDurationForAsteroidIdRef.current = snapshot.instanceId;
          miningDurationSRef.current = computeMiningDurationS(snapshot.radiusM) / cfg.miningSpeedMult;
        }

        // A miss halts mining after one ray tick (grazing the outline must not stutter).
        miningAimLostTimeRef.current = onTarget ? 0 : miningAimLostTimeRef.current + delta;
        const hitting = miningAimLostTimeRef.current <= MINING_MISS_GRACE_S;

        {
          // --- Pulse mining cycle logic
          const isPulseMode = pulseMiningActiveRef.current &&
            getFlag(modifiersRef.current, "ability.pulseMiningEnabled");

          let beamFiring = true; // continuous mode: always firing

          if (isPulseMode) {
            // Advance pulse cycle timer
            pulseCycleTimerRef.current = (pulseCycleTimerRef.current + delta) % PULSE_CYCLE_S;
            beamFiring = pulseCycleTimerRef.current < PULSE_ON_S;

            // Update shared buffer for beam visual
            pulseCycleBuffer.timer = pulseCycleTimerRef.current;
            pulseCycleBuffer.beamOn = beamFiring;
            pulseCycleBuffer.pulsing = true;
          } else {
            pulseCycleBuffer.beamOn = true;
            pulseCycleBuffer.pulsing = false;
          }

          // Heat and extraction rate come from the ship resource step (one thermal store,
          // reactor-throttled work on executed time): request the beam, consume granted seconds.
          miningBeamRequest.on = beamFiring;
          shipResControl.beamTargetId = snapshot.instanceId;
          const work = takeMiningWork();

          if (shipRes.miningTripped) {
            isOverheatedNow = true;
            cancelMining = true;
            miningProgressRef.current = 0;
            miningAimLostTimeRef.current = 0;
            targetIdRef.current = null;
            targetingTimeRef.current = 0;
            targetLostTimeRef.current = 0;
            currentSnapshotRef.current = null;
            pulseCycleTimerRef.current = 0;
          } else if (hitting) {
            miningProgressRef.current += work / miningDurationSRef.current;
          }

          if (miningProgressRef.current >= 1) {
            miningProgressRef.current = 1;
            pendingRemovalIdRef.current = {
              instanceId: snapshot.instanceId,
              fieldId: snapshot.location.fieldId,
              chunkKey: snapshot.location.chunkKey,
            };

            // Compute deterministic mining reward before we clear the snapshot
            const fieldId = snapshot.location.fieldId;
            const reward = getAsteroidMiningReward(
              systemConfig,
              fieldId,
              snapshot.instanceId,
              snapshot.radiusM,
              snapshot.location.chunkKey
            );
            if (reward) {
              pendingMiningRewardRef.current = {
                instanceId: snapshot.instanceId,
                fieldId,
                radiusM: snapshot.radiusM,
              };
            }

            // Completed => stop mining and clear target
            cancelMining = true;
            targetIdRef.current = null;
            targetingTimeRef.current = 0;
            targetLostTimeRef.current = 0;
            currentSnapshotRef.current = null;

          }
        }
      }
    } else {
      miningProgressRef.current = 0;
      miningAimLostTimeRef.current = 0;
      pulseCycleTimerRef.current = 0;
      pulseCycleBuffer.beamOn = true;
      pulseCycleBuffer.pulsing = false;
    }
    if (!isMiningNow || cancelMining) miningBeamView.on = false;
    if (!isMiningNow || cancelMining) miningBeamRequest.on = false;
    if (!miningBeamRequest.on) takeMiningWork();

    // The beam as drawn, in the ship's frame: co-op poses show it to the other pilots.
    {
      const bp = localBeamPose, rp = localRenderPose, e = beamEndLocalRef.current;
      bp.on = isMiningNow && !cancelMining && miningStateRef.current.targetedAsteroid !== null && rp.atMs >= 0;
      if (bp.on) {
        bp.dim = !pulseCycleBuffer.beamOn;
        bp.miss = !miningBeamView.hit.value;
        bp.atMs = rp.atMs;
        bp.frameId = rp.frameId;
        bp.relKm[0] = rp.relKm[0] + e.x / 1000;
        bp.relKm[1] = rp.relKm[1] + e.y / 1000;
        bp.relKm[2] = rp.relKm[2] + e.z / 1000;
      }
    }

    // Force an immediate state commit if we just cancelled or completed mining
    if (cancelMining || pendingRemovalIdRef.current !== null) {
      commitAccRef.current = STATE_COMMIT_INTERVAL_S;
    }

    // --- Commit to Jotai
    commitAccRef.current += delta;
    if (commitAccRef.current >= STATE_COMMIT_INTERVAL_S) {
      commitAccRef.current = 0;

      const snapshotForState = currentSnapshotRef.current;
      const nextTargetingTimeS = snapshotForState ? targetingTimeRef.current : 0;
      const nextFocused = snapshotForState ? nextTargetingTimeS >= focusTimeS : false;

      setMiningState((prev) => {
        let nextIsMining = prev.isMining;

        if (cancelMining) nextIsMining = false;
        if (nextIsMining && (!snapshotForState || !nextFocused)) nextIsMining = false;

        const nextMiningProgress = nextIsMining ? clamp01(miningProgressRef.current) : 0;

        return {
          targetedAsteroid: snapshotForState,
          targetingTimeS: nextTargetingTimeS,
          isFocused: nextFocused,
          isMining: nextIsMining,
          miningProgress: nextMiningProgress,
          laserHeat: shipRes.heat01,
          isOverheated: shipRes.miningTripped || isOverheatedNow,
          inspectProgress: inspectControl.requested ? Math.max(0.001, inspectControl.progress) : 0,
        };
      });

    }

    // --- Write world-space ping data for PingBrackets3D ---
    {
      const targetId = targetIdRef.current;
      const rawPing = pingRawRef.current;
      const out = [];
      for (let p = 0; p < rawPing.length; p++) {
        const entry = rawPing[p];
        if (entry.instanceId === targetId) continue;
        out.push(entry);
      }
      pingWorldBuffer.candidates = out;
      pingWorldBuffer.generation++;
    }

    // Mine the asteroid; reward, loot VFX and signals come from the accepted result only.
    const removal = pendingRemovalIdRef.current;
    if (removal !== null) {
      const reward = pendingMiningRewardRef.current;
      if (reward && reward.instanceId === removal.instanceId) {
        const cfg = shipConfigRef.current;
        const op = buildMineOperation(
          systemConfig,
          { ...removal, radiusM: reward.radiusM },
          { miningEfficiencyMult: cfg.miningEfficiencyMult },
          newOpId(),
          // Executed beam seconds: progress only grows by granted work, so a finished rock took its duration.
          miningDurationSRef.current,
        );
        runOperation(op, (o) => {
          if (o.status !== "accepted" || o.result.type !== "asteroid.mine") return;
          const granted = o.result.granted;
          if (Object.keys(granted).length > 0) {
            signalAudio("loot.acquire");
            const values = Object.entries(granted).sort((a, b) => b[1] - a[1]).map(([id, amount]) => ({ id, amount }));
            addToast({ message: "Mined", kind: "success", audio: "silent", values });
          }
          incrementMinedSignal((c) => c + 1);
        });
      } else {
        removeAsteroid(removal);
      }

      pendingRemovalIdRef.current = null;
      pendingMiningRewardRef.current = null;
    }
  });

  // Highlight shows only once focused (or while mining)
  const showHighlight =
    miningState.targetedAsteroid !== null && (miningState.isFocused || miningState.isMining);

  const showBeam = miningState.isMining && miningState.targetedAsteroid !== null;

  const focus01 =
    miningState.targetedAsteroid !== null
      ? clamp01(miningState.targetingTimeS / (TARGET_FOCUS_TIME_S * shipConfig.scannerLockSpeedMult))
      : 0;

  return (
    <>
      {!hudHidden && showHighlight && miningState.targetedAsteroid && (
        <AsteroidHighlight
          positionLocal={miningState.targetedAsteroid.positionLocal}
          radiusM={miningState.targetedAsteroid.radiusM}
          focus01={focus01}
          mining={miningState.isMining}
          miningProgress01={clamp01(miningState.miningProgress)}
        />
      )}

      {showBeam && (
        <MiningBeam
          start={beamStartLocalRef.current}
          end={beamEndLocalRef.current}
          hit={miningBeamView.hit}
          power={shipConfig.miningPowerMult}
        />
      )}
    </>
  );
};

export default MiningSystem;
