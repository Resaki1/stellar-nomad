"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import * as THREE from "three";
import { Billboard, Line } from "@react-three/drei";

import {
  miningStateAtom,
  type TargetedAsteroid,
  TARGET_FOCUS_TIME_S,
} from "@/store/mining";
import { systemConfigAtom } from "@/store/system";
import { useAsteroidRuntime } from "@/sim/asteroids/runtimeContext";
import { useWorldOrigin } from "@/sim/worldOrigin";
import type { AsteroidChunkData } from "@/sim/asteroids/runtimeTypes";
import { distancePointToAabbKm } from "@/sim/asteroids/shapes";
import { getAsteroidMiningReward, computeMiningDurationS } from "@/sim/asteroids/resources";
import { addCargoAtom } from "@/store/cargo";

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
const MINING_AIM_GRACE_S = 0.15; // small forgiveness for jitter
const MINING_AIM_RADIUS_SCALE = 1.08;
const MINING_AIM_RADIUS_BONUS_M = 0.75;

// Targeting assist
const TARGET_HIT_RADIUS_SCALE = 1.25;
const TARGET_HIT_RADIUS_BONUS_M = 4;

// Beam visuals
const BEAM_CORE_WIDTH_PX = 2.0;
const BEAM_HALO_WIDTH_PX = 7.0;
const BEAM_PULSE_COUNT = 6; // more noticeable and still cheap
const BEAM_PULSE_SPEED = 1.1; // cycles per second
const BEAM_PULSE_SIZE_M = 10;

// Reduced muzzle glow
const MUZZLE_GLOW_SIZE_M = 4.5;
const IMPACT_GLOW_SIZE_M = 14;

// Highlight visuals
const HIGHLIGHT_SEGMENTS = 96;
const HIGHLIGHT_RADIUS_MULT = 1.15;
const HIGHLIGHT_CORE_WIDTH_PX = 2.0;
const HIGHLIGHT_HALO_WIDTH_PX = 7.0;

// Ship lookup (beam starts at ship tip)
const PLAYER_SHIP_NAME = "playerShip";

// --------------------
// Colors (no arrays in JSX)
// --------------------
const COLOR_BEAM_HALO = new THREE.Color(0.35, 0.85, 1.0);
const COLOR_BEAM_CORE = new THREE.Color(0.9, 0.98, 1.0);
const COLOR_GLOW_MUZZLE = new THREE.Color(0.65, 0.9, 1.0);
const COLOR_GLOW_IMPACT = new THREE.Color(0.45, 0.85, 1.0);
const COLOR_PULSE = new THREE.Color(0.75, 0.95, 1.0);

const COLOR_HIGHLIGHT_HALO = new THREE.Color(0.35, 0.85, 1.0);
const COLOR_HIGHLIGHT_CORE = new THREE.Color(0.85, 0.97, 1.0);
const COLOR_HIGHLIGHT_ARC = new THREE.Color(0.7, 0.95, 1.0);

// --------------------
// Temp objects (avoid allocations)
// --------------------
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _cameraKm = new THREE.Vector3();

const _centerLocal = new THREE.Vector3();
const _toCenter = new THREE.Vector3();
const _beamEnd = new THREE.Vector3();
const _tmp = new THREE.Vector3();

// Ship nose compute temps
const _shipBox = new THREE.Box3();
const _tmpBox = new THREE.Box3();
const _invRootWorld = new THREE.Matrix4();
const _meshToRoot = new THREE.Matrix4();

function makeCirclePoints(segments: number): Array<[number, number, number]> {
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push([Math.cos(a), Math.sin(a), 0]);
  }
  return pts;
}

function makeArcPoints(
  segments: number,
  startAngleRad: number,
  endAngleRad: number
): Array<[number, number, number]> {
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const a = THREE.MathUtils.lerp(startAngleRad, endAngleRad, t);
    pts.push([Math.cos(a), Math.sin(a), 0]);
  }
  return pts;
}

function clamp01(x: number) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function raySphereIntersectT(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  center: THREE.Vector3,
  radius: number
): number | null {
  _toCenter.copy(center).sub(origin);
  const tca = _toCenter.dot(dir);
  if (tca < 0) return null;

  const d2 = _toCenter.lengthSq() - tca * tca;
  const r2 = radius * radius;
  if (d2 > r2) return null;

  const thc = Math.sqrt(Math.max(r2 - d2, 0));
  const t0 = tca - thc;
  const t1 = tca + thc;

  if (t0 >= 0) return t0;
  if (t1 >= 0) return t1;
  return null;
}

/**
 * Returns a point ON the true sphere surface if the ray hits either:
 * - true sphere (exact), or
 * - inflated aim sphere (approx; maps to true sphere in that direction)
 */
function computeRayToAsteroidSurfacePoint(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  center: THREE.Vector3,
  trueRadius: number,
  aimRadius: number,
  outPoint: THREE.Vector3
): boolean {
  const tTrue = raySphereIntersectT(origin, dir, center, trueRadius);
  if (tTrue !== null) {
    outPoint.copy(origin).addScaledVector(dir, tTrue);
    return true;
  }

  const tAim = raySphereIntersectT(origin, dir, center, aimRadius);
  if (tAim !== null) {
    _tmp.copy(origin).addScaledVector(dir, tAim);
    _tmp.sub(center);
    if (_tmp.lengthSq() < 1e-6) _tmp.set(0, 0, 1);
    else _tmp.normalize();
    outPoint.copy(center).addScaledVector(_tmp, trueRadius);
    return true;
  }

  return false;
}

/**
 * Computes a stable "nose point" in the ship root's local space.
 * Ship forward is assumed to be +Z in model space.
 */
function computeShipNoseLocal(root: THREE.Object3D, out: THREE.Vector3): boolean {
  _shipBox.makeEmpty();

  root.updateMatrixWorld(true);
  _invRootWorld.copy(root.matrixWorld).invert();

  let hadAnyMesh = false;

  root.traverse((obj) => {
    const mesh = obj as any;
    if (!mesh?.isMesh) return;
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
  progress01: number;
};

const MiningBeam = ({ start, end, progress01 }: MiningBeamProps) => {
  const coreRef = useRef<any>(null);
  const haloRef = useRef<any>(null);

  const muzzleRef = useRef<THREE.Sprite | null>(null);
  const impactRef = useRef<THREE.Sprite | null>(null);
  const pulseRefs = useRef<Array<THREE.Sprite | null>>([]);

  const glowTexture = useMemo(() => {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      tex.needsUpdate = true;
      return tex;
    }

    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0.0, "rgba(255,255,255,1)");
    g.addColorStop(0.2, "rgba(255,255,255,0.7)");
    g.addColorStop(0.6, "rgba(255,255,255,0.15)");
    g.addColorStop(1.0, "rgba(255,255,255,0)");

    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }, []);

  const placeholderPoints = useMemo(
    () =>
      [
        [0, 0, 0] as [number, number, number],
        [0, 0, 0] as [number, number, number],
      ] as Array<[number, number, number]>,
    []
  );

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();

    // Update line geometry every frame
    const positions = [start.x, start.y, start.z, end.x, end.y, end.z];

    const core = coreRef.current as any;
    if (core?.geometry?.setPositions) core.geometry.setPositions(positions);

    const halo = haloRef.current as any;
    if (halo?.geometry?.setPositions) halo.geometry.setPositions(positions);

    // Vector start->end (for general beam metrics)
    const sx = start.x, sy = start.y, sz = start.z;
    const ex = end.x, ey = end.y, ez = end.z;

    const dxSE = ex - sx;
    const dySE = ey - sy;
    const dzSE = ez - sz;
    const len = Math.sqrt(dxSE * dxSE + dySE * dySE + dzSE * dzSE);

    // Beam intensity (keep subtle flicker for the beam itself)
    const ramp = 0.65 + 0.35 * clamp01(progress01 * 1.25);
    const flicker = 0.9 + 0.1 * Math.sin(t * 16.0 + len * 0.01);
    const beamIntensity = ramp * flicker;

    // Muzzle glow (small + dim)
    if (muzzleRef.current) {
      muzzleRef.current.position.copy(start);
      const s = MUZZLE_GLOW_SIZE_M * (0.92 + 0.08 * Math.sin(t * 10.0));
      muzzleRef.current.scale.set(s, s, 1);

      const mat = muzzleRef.current.material as THREE.SpriteMaterial;
      mat.opacity = 0.14 * beamIntensity;
    }

    // Impact glow (stronger)
    if (impactRef.current) {
      impactRef.current.position.copy(end);
      const s = IMPACT_GLOW_SIZE_M * (0.9 + 0.2 * Math.sin(t * 11.0 + 1.7));
      impactRef.current.scale.set(s, s, 1);

      const mat = impactRef.current.material as THREE.SpriteMaterial;
      mat.opacity = 0.6 * beamIntensity;
    }

    // Pulses: asteroid -> ship, linear and stable (no random jitter).
    // Use end->start direction.
    const dxES = sx - ex;
    const dyES = sy - ey;
    const dzES = sz - ez;

    // Pulse alpha should NOT inherit the flicker; keep it clean.
    const pulseBase = 0.38 * ramp;

    for (let i = 0; i < BEAM_PULSE_COUNT; i++) {
      const spr = pulseRefs.current[i];
      if (!spr) continue;

      // phase: 0 at asteroid (end), 1 at ship (start)
      const phase = (t * BEAM_PULSE_SPEED + i / BEAM_PULSE_COUNT) % 1;

      spr.position.set(ex + dxES * phase, ey + dyES * phase, ez + dzES * phase);

      // Smooth fade-in/out near endpoints (prevents popping without “random flicker”)
      const fadeIn = phase < 0.12 ? phase / 0.12 : 1;
      const fadeOut = phase > 0.88 ? (1 - phase) / 0.12 : 1;
      const alpha = Math.max(0, Math.min(1, fadeIn * fadeOut));

      const s = BEAM_PULSE_SIZE_M * (0.9 + 0.25 * alpha);
      spr.scale.set(s, s, 1);

      const mat = spr.material as THREE.SpriteMaterial;
      mat.opacity = pulseBase * alpha;
    }

    if (core?.material) core.material.opacity = 0.78 * beamIntensity;
    if (halo?.material) halo.material.opacity = 0.16 * beamIntensity;
  });

  return (
    <group renderOrder={2000}>
      <Line
        ref={haloRef}
        points={placeholderPoints}
        color={COLOR_BEAM_HALO}
        worldUnits={false}
        lineWidth={BEAM_HALO_WIDTH_PX}
        transparent
        opacity={0.16}
        depthTest
        depthWrite={false}
        toneMapped={false}
        blending={THREE.AdditiveBlending}
        frustumCulled={false}
      />

      <Line
        ref={coreRef}
        points={placeholderPoints}
        color={COLOR_BEAM_CORE}
        worldUnits={false}
        lineWidth={BEAM_CORE_WIDTH_PX}
        transparent
        opacity={0.78}
        depthTest
        depthWrite={false}
        toneMapped={false}
        blending={THREE.AdditiveBlending}
        frustumCulled={false}
      />

      <sprite ref={muzzleRef}>
        <spriteMaterial
          map={glowTexture}
          color={COLOR_GLOW_MUZZLE}
          transparent
          opacity={0.12}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          depthTest
          toneMapped={false}
        />
      </sprite>

      <sprite ref={impactRef}>
        <spriteMaterial
          map={glowTexture}
          color={COLOR_GLOW_IMPACT}
          transparent
          opacity={0.45}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          depthTest
          toneMapped={false}
        />
      </sprite>

      {Array.from({ length: BEAM_PULSE_COUNT }).map((_, i) => (
        <sprite
          // eslint-disable-next-line react/no-array-index-key
          key={i}
          ref={(el) => {
            pulseRefs.current[i] = el;
          }}
        >
          <spriteMaterial
            map={glowTexture}
            color={COLOR_PULSE}
            transparent
            opacity={0.2}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            depthTest
            toneMapped={false}
          />
        </sprite>
      ))}
    </group>
  );
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

  const circlePts = useMemo(() => makeCirclePoints(HIGHLIGHT_SEGMENTS), []);
  const arcPts = useMemo(() => makeArcPoints(32, -Math.PI * 0.15, Math.PI * 0.45), []);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();

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
          <Line
            points={circlePts}
            color={COLOR_HIGHLIGHT_HALO}
            worldUnits={false}
            lineWidth={HIGHLIGHT_HALO_WIDTH_PX}
            transparent
            opacity={haloOpacity}
            depthTest={false}
            depthWrite={false}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
          />

          <Line
            points={circlePts}
            color={COLOR_HIGHLIGHT_CORE}
            worldUnits={false}
            lineWidth={HIGHLIGHT_CORE_WIDTH_PX}
            transparent
            opacity={coreOpacity}
            depthTest={false}
            depthWrite={false}
            toneMapped={false}
            blending={THREE.AdditiveBlending}
          />

          <group ref={arcRef}>
            <Line
              points={arcPts}
              color={COLOR_HIGHLIGHT_ARC}
              worldUnits={false}
              lineWidth={HIGHLIGHT_CORE_WIDTH_PX}
              transparent
              opacity={arcOpacity}
              depthTest={false}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.AdditiveBlending}
            />
          </group>
        </group>
      </Billboard>
    </group>
  );
};

const MiningSystem = () => {
  const { camera, scene } = useThree();
  const worldOrigin = useWorldOrigin();
  const asteroidRuntime = useAsteroidRuntime();
  const systemConfig = useAtomValue(systemConfigAtom);

  const [miningState, setMiningState] = useAtom(miningStateAtom);

  // Latest mining state ref (avoid render timing issues inside useFrame)
  const miningStateRef = useRef(miningState);
  useEffect(() => {
    miningStateRef.current = miningState;
  }, [miningState]);

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
  const targetLostTimeRef = useRef(0);
  const targetingTimeRef = useRef(0);

  const miningAimLostTimeRef = useRef(0);

  const currentSnapshotRef = useRef<TargetedAsteroid | null>(null);
  const miningProgressRef = useRef(0);

  // One frame delay to remove the asteroid after state update is committed
  const pendingRemovalIdRef = useRef<number | null>(null);
  const pendingMiningRewardRef = useRef<
    { instanceId: number; fieldId: string; resourceId: string; amount: number } | null
    >(null);
  
  const shipPosLocalRef = useRef(new THREE.Vector3());
  const beamStartLocalRef = useRef(new THREE.Vector3());
  const beamEndLocalRef = useRef(new THREE.Vector3());

  // FIX: lock beam endpoint on the asteroid once mining starts
  // Store as offset from asteroid center so it remains correct under world-origin recentering.
  const lockedEndOffsetFromCenterRef = useRef(new THREE.Vector3(0, 0, 0));
  const lockedEndForAsteroidIdRef = useRef<number | null>(null);

  const miningDurationSRef = useRef<number>(5);
  const miningDurationForAsteroidIdRef = useRef<number | null>(null);

  const addCargo = useSetAtom(addCargoAtom);

  const removeAsteroid = useCallback(
    (instanceId: number) => {
      const loc = asteroidRuntime.findInstanceLocation(instanceId);
      if (!loc) return;

      const fieldRuntime = asteroidRuntime.getFieldRuntime(loc.fieldId);
      if (!fieldRuntime) return;

      fieldRuntime.destroyInstance(instanceId);
    },
    [asteroidRuntime]
  );

  const getTargetSnapshot = useCallback(
    (instanceId: number): TargetedAsteroid | null => {
      const loc = asteroidRuntime.findInstanceLocation(instanceId);
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

  const findNearestAsteroidOnRay = useCallback((): TargetedAsteroid | null => {
    const shipKm = worldOrigin.shipPosKm;

    camera.getWorldDirection(_rayDir);
    _rayOrigin.copy(camera.position);

    // camera position in sim-km
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
          if (distShipSq > MAX_TARGETING_DISTANCE_M * MAX_TARGETING_DISTANCE_M) continue;

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
          if (preferredId !== null && instanceId === preferredId) {
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

        if (aabbDistKm > MAX_TARGETING_DISTANCE_KM + chunk.maxRadiusM / 1000) return;
        checkChunk(chunk, fieldAnchor);
      });
    });

    return locked ?? best;
  }, [asteroidRuntime, camera, fieldAnchorMap, worldOrigin]);

  useFrame((_, delta) => {
    pendingRemovalIdRef.current = null;

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

      if (!isMiningNow) {
        const hit = findNearestAsteroidOnRay();
        const hitId = hit?.instanceId ?? null;

        const prevId = targetIdRef.current;

        if (hitId !== null) {
          targetLostTimeRef.current = 0;

          if (prevId !== hitId) {
            targetIdRef.current = hitId;
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
      snapshot = getTargetSnapshot(targetId);

      if (!snapshot) {
        targetIdRef.current = null;
        targetingTimeRef.current = 0;
        targetLostTimeRef.current = 0;
      } else if (snapshot.distanceM > MAX_TARGETING_DISTANCE_M) {
        targetIdRef.current = null;
        targetingTimeRef.current = 0;
        targetLostTimeRef.current = 0;
        snapshot = null;
      }
    }

    currentSnapshotRef.current = snapshot;

    // --- Targeting time accumulation (only while not mining)
    if (snapshot && !isMiningNow) {
      targetingTimeRef.current += delta;
    } else if (!snapshot) {
      targetingTimeRef.current = 0;
    }

    const isFocused = !!snapshot && targetingTimeRef.current >= TARGET_FOCUS_TIME_S;

    // --- Mining progression + must keep aim
    let cancelMining = false;

    if (isMiningNow) {
      // Mining requires a valid focused target
      if (!snapshot || !isFocused) {
        cancelMining = true;
        miningProgressRef.current = 0;
        miningAimLostTimeRef.current = 0;
        lockedEndForAsteroidIdRef.current = null;
      } else {
        _rayOrigin.copy(camera.position);
        camera.getWorldDirection(_rayDir);

        _centerLocal.set(
          snapshot.positionLocal[0],
          snapshot.positionLocal[1],
          snapshot.positionLocal[2]
        );

        const aimRadius = snapshot.radiusM * MINING_AIM_RADIUS_SCALE + MINING_AIM_RADIUS_BONUS_M;

        // FIX: lock a beam endpoint ONCE (when mining starts / target changes), then keep it fixed.
        if (lockedEndForAsteroidIdRef.current !== snapshot.instanceId) {
          const ok = computeRayToAsteroidSurfacePoint(
            _rayOrigin,
            _rayDir,
            _centerLocal,
            snapshot.radiusM,
            aimRadius,
            _beamEnd
          );

          if (ok) {
            lockedEndOffsetFromCenterRef.current.copy(_beamEnd).sub(_centerLocal);
          } else {
            // Fallback: point facing the ship nose (still fixed once set)
            lockedEndOffsetFromCenterRef.current.copy(beamStartLocalRef.current).sub(_centerLocal);
            if (lockedEndOffsetFromCenterRef.current.lengthSq() < 1e-6) {
              lockedEndOffsetFromCenterRef.current.set(0, 0, 1);
            } else {
              lockedEndOffsetFromCenterRef.current.normalize();
            }
            lockedEndOffsetFromCenterRef.current.multiplyScalar(snapshot.radiusM);
          }

          lockedEndForAsteroidIdRef.current = snapshot.instanceId;
          miningDurationSRef.current = computeMiningDurationS(snapshot.radiusM);
        }

        // Always place beam end at the locked point (NOT at the camera ray each frame)
        beamEndLocalRef.current.copy(_centerLocal).add(lockedEndOffsetFromCenterRef.current);

        // Aim gating (must keep asteroid under reticle)
        const aimed = raySphereIntersectT(_rayOrigin, _rayDir, _centerLocal, aimRadius) !== null;

        if (aimed) {
          miningAimLostTimeRef.current = 0;

          // Advance mining
          miningProgressRef.current += delta / miningDurationSRef.current;

          if (miningProgressRef.current >= 1) {
            miningProgressRef.current = 1;
            pendingRemovalIdRef.current = snapshot.instanceId;

            // Compute deterministic mining reward before we clear the snapshot
            const fieldId = snapshot.location.fieldId;
            const reward = getAsteroidMiningReward(
              systemConfig,
              fieldId,
              snapshot.instanceId,
              snapshot.radiusM
            );
            if (reward) {
              pendingMiningRewardRef.current = {
                instanceId: snapshot.instanceId,
                fieldId,
                resourceId: reward.resourceId,
                amount: reward.amount,
              };
            }

            // Completed => stop mining and clear target
            cancelMining = true;
            targetIdRef.current = null;
            targetingTimeRef.current = 0;
            targetLostTimeRef.current = 0;
            currentSnapshotRef.current = null;

            lockedEndForAsteroidIdRef.current = null;
          }
        } else {
          miningAimLostTimeRef.current += delta;

          if (miningAimLostTimeRef.current > MINING_AIM_GRACE_S) {
            // Lost aim => cancel mining and clear target
            cancelMining = true;
            miningProgressRef.current = 0;
            miningAimLostTimeRef.current = 0;

            targetIdRef.current = null;
            targetingTimeRef.current = 0;
            targetLostTimeRef.current = 0;
            currentSnapshotRef.current = null;

            lockedEndForAsteroidIdRef.current = null;
          }
        }
      }
    } else {
      miningProgressRef.current = 0;
      miningAimLostTimeRef.current = 0;
      lockedEndForAsteroidIdRef.current = null;
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
      const nextFocused = snapshotForState ? nextTargetingTimeS >= TARGET_FOCUS_TIME_S : false;

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
        };
      });
    }

    // Apply side effect: remove asteroid
    const removeId = pendingRemovalIdRef.current;
    if (removeId !== null) {
      const reward = pendingMiningRewardRef.current;
      if (reward && reward.instanceId === removeId) {
        addCargo({ resourceId: reward.resourceId, amount: reward.amount });
      }

      removeAsteroid(removeId);
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
      ? clamp01(miningState.targetingTimeS / TARGET_FOCUS_TIME_S)
      : 0;

  return (
    <>
      {showHighlight && miningState.targetedAsteroid && (
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
          progress01={clamp01(miningState.miningProgress)}
        />
      )}
    </>
  );
};

export default MiningSystem;
