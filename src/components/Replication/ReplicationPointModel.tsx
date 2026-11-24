import { useEffect, useMemo, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useStore } from "jotai";
import {
  DynamicDrawUsage, Group, InstancedMesh, type Material, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Quaternion, Vector3, type Texture,
} from "three";
import { shipView } from "@/components/Camera/shipView";
import { FRAME_PRIORITY_PLAYER_SHIP } from "@/components/frameOrder";
import { readCollisionMeshes } from "@/components/models/collisionMeshes";
import { emitterColor } from "@/components/space/emissivePhotometry";
import { registerPreExposedEmissive } from "@/components/space/preExposedEmissive";
import { useSpillLightmaps, withSpillLightmap } from "@/components/space/spillBake";
import { beaconFlash, emitLightPoints, fadingLampMaterial, readLightTemplate, type LightTemplate } from "@/components/space/lightPoints";
import type { ReplicationPoint } from "@/save/types";
import { getLocalPlayerShip } from "@/sim/entities";
import { frameOriginKm, isFrameId } from "@/sim/frames";
import { nearField, type NearFieldColliderId } from "@/sim/physics/nearField";
import { MAX_POINTS, REPLICATION_TUNING } from "@/sim/replication/points";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { placementPreview, replicationPointsAtom } from "@/store/replication";
import { simEpochMsAtom } from "@/store/simTime";

const BASE = "/models/stations/replication-r4";
const RENDER_ASSETS = [BASE + ".glb", BASE + "-lod1.glb", BASE + "-lod2.glb"];
const COLLISION_ASSET = BASE + "-collision.glb";
const DRAW_RANGE_M = 400_000;
const LOD_DISTANCE_M = [600, 1_100];
/** Lamps stay visible as light points far past the mesh draw range (VFX plan §1.2: ~mag 2 at 400 km). */
const LIGHT_RANGE_M = 3_000_000;
const MAST_LIGHT_MATERIAL = "Amber mast beacons";
/** Characteristic lamp size per material, m (build.py: lens 0.73×0.58, mast lamp ⌀0.64) — the crossfade's px. */
const LAMP_SIZE_M: Record<string, number> = { "Amber indicators": 0.65, [MAST_LIGHT_MATERIAL]: 0.64 };
const HYSTERESIS = 0.12;
const COLLIDER_RANGE_KM = 2;
const COLLIDER_KEEP_KM = COLLIDER_RANGE_KM * 1.2;

const GHOST_OK = new MeshBasicMaterial({ color: emitterColor("replication_preview"), wireframe: true, transparent: true, opacity: 0.38, depthWrite: false });
const GHOST_BAD = new MeshBasicMaterial({ color: emitterColor("replication_preview_bad"), wireframe: true, transparent: true, opacity: 0.38, depthWrite: false });
[GHOST_OK, GHOST_BAD].forEach((material) => registerPreExposedEmissive(material));

const _camera = new Vector3();
const _position = new Vector3();
const _quat = new Quaternion();
const _one = new Vector3(1, 1, 1);
const _transform = new Matrix4();
const _matrix = new Matrix4();
const _shipOrigin = new Vector3();

/** Visible station counts for the dev harness. */
export const replicationPointStats = { drawn: 0, lods: [0, 0, 0] };

function newBatch(scene: Group, spill: Texture | undefined) {
  scene.updateMatrixWorld(true);
  const group = new Group();
  const draws: { mesh: InstancedMesh; local: Matrix4 }[] = [];
  const lamps: Material[] = [];
  const beacons: Material[] = [];
  scene.traverse((part) => {
    if (!(part instanceof Mesh)) return;
    const material = part.material;
    const emissive = material instanceof MeshStandardMaterial && material.emissive.getHex() !== 0;
    // S3: hull surfaces carry their LOD's baked lamp spill (TEXCOORD_1).
    let surface: Material = emissive ? material : withSpillLightmap(material, spill);
    if (material instanceof MeshStandardMaterial && emissive) {
      const blinks = material.name === MAST_LIGHT_MATERIAL;
      // Fades out below a few px while its light points (L2) take over the flux.
      const lamp = fadingLampMaterial(material, LAMP_SIZE_M[material.name] ?? 0.65);
      lamp.emissive.copy(emitterColor(blinks ? "replication_mast_beacon" : "replication_beacon"));
      lamp.emissiveIntensity = 1;
      surface = lamp;
      lamps.push(lamp);
      if (blinks) beacons.push(lamp);
    }
    const mesh = new InstancedMesh(part.geometry, surface, MAX_POINTS);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.receiveShadow = mesh.castShadow = true;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    group.add(mesh);
    draws.push({ mesh, local: part.matrixWorld.clone() });
  });
  return { group, draws, lamps, beacons };
}

function lodFor(distanceM: number, previous: number | undefined): number {
  const near = LOD_DISTANCE_M[0] * (previous === undefined ? 1 : previous === 0 ? 1 + HYSTERESIS : 1 - HYSTERESIS);
  const far = LOD_DISTANCE_M[1] * (previous === undefined ? 1 : previous < 2 ? 1 + HYSTERESIS : 1 - HYSTERESIS);
  return distanceM < near ? 0 : distanceM < far ? 1 : 2;
}

export function ReplicationPointModels() {
  const store = useStore();
  const worldOrigin = useWorldOrigin();
  const models = useGLTF(RENDER_ASSETS, false, false);
  const spill = useSpillLightmaps(BASE, RENDER_ASSETS.length);
  const batches = useMemo(() => models.map(({ scene }, lod) => newBatch(scene, spill[lod])), [models, spill]);
  // One lamp set for every LOD: points don't merge into light bars.
  // S3: steady lamps' spill is baked into the station textures; the spill lights skip them.
  const lights = useMemo<LightTemplate>(() => readLightTemplate(models[0].scene, true), [models]);
  const previous = useRef(new Map<string, number>());
  const previousPoints = useRef<readonly ReplicationPoint[] | null>(null);

  useEffect(() => {
    const unregister = batches.flatMap(({ lamps }) => lamps.map((material) => registerPreExposedEmissive(material)));
    return () => {
      unregister.forEach((fn) => fn());
      for (const { draws, lamps } of batches) {
        draws.forEach(({ mesh }) => mesh.dispose());
        lamps.forEach((material) => material.dispose());
      }
      replicationPointStats.drawn = 0;
      replicationPointStats.lods.fill(0);
    };
  }, [batches]);

  useFrame(({ camera }) => {
    const points = store.get(replicationPointsAtom);
    const levels = previous.current;
    if (previousPoints.current !== points) {
      levels.clear();
      previousPoints.current = points;
    }
    const counts = replicationPointStats.lods;
    counts.fill(0);
    let total = 0;
    const flash = beaconFlash(store.get(simEpochMsAtom));
    camera.getWorldPosition(_camera);
    for (const point of points) {
      if (point.starter || !isFrameId(point.frameId)) continue;
      const [x, y, z] = point.positionKm;
      frameOriginKm(point.frameId, _position);
      _position.set(_position.x + x, _position.y + y, _position.z + z)
        .sub(worldOrigin.worldOriginKm).multiplyScalar(1000);
      const distance = _position.distanceTo(_camera);
      if (distance > LIGHT_RANGE_M) continue;
      _transform.compose(_position, _quat.fromArray(point.quaternion), _one);
      emitLightPoints(lights, _transform, flash);
      if (distance > DRAW_RANGE_M || total === MAX_POINTS) continue;
      const level = lodFor(distance, levels.get(point.id));
      levels.set(point.id, level);
      for (const { mesh, local } of batches[level].draws) {
        mesh.setMatrixAt(counts[level], _matrix.multiplyMatrices(_transform, local));
      }
      counts[level]++;
      total++;
    }
    batches.forEach(({ draws, beacons }, level) => {
      for (const beacon of beacons) (beacon as MeshStandardMaterial).emissiveIntensity = flash;
      for (const { mesh } of draws) {
        mesh.count = counts[level];
        if (mesh.count) mesh.instanceMatrix.needsUpdate = true;
      }
    });
    replicationPointStats.drawn = total;
  });

  return <>{batches.map(({ group }, level) => <primitive key={level} object={group} name={`replicationPointLOD${level}`} />)}</>;
}

export function ReplicationPointGhost() {
  const { scene } = useGLTF(RENDER_ASSETS[2], false, false);
  const group = useMemo(() => scene.clone(true), [scene]);
  const lastValid = useRef<boolean | null>(null);
  useFrame(() => {
    group.position.copy(shipView.forward).multiplyScalar(REPLICATION_TUNING.placeDistanceKm * 1000);
    group.quaternion.copy(shipView.quaternion);
    if (lastValid.current === placementPreview.valid) return;
    lastValid.current = placementPreview.valid;
    const material = placementPreview.valid ? GHOST_OK : GHOST_BAD;
    group.traverse((part) => {
      if (part instanceof Mesh) part.material = material;
    });
  });
  return <primitive object={group} name="replicationPointPlacementPreview" />;
}

function samePose(a: ReplicationPoint, b: ReplicationPoint): boolean {
  return a.frameId === b.frameId &&
    a.positionKm.every((n, axis) => n === b.positionKm[axis]) &&
    a.quaternion.every((n, axis) => n === b.quaternion[axis]);
}

export function ReplicationPointColliders() {
  const store = useStore();
  const { scene } = useGLTF(COLLISION_ASSET, false, false);
  const shape = useMemo(() => readCollisionMeshes(scene), [scene]);
  const entries = useRef(new Map<string, { point: ReplicationPoint; handle: NearFieldColliderId }>());
  const seen = useRef(new Set<string>());

  useEffect(() => {
    const installed = entries.current;
    return () => {
      installed.forEach(({ handle }) => nearField.removeCollider(handle));
      installed.clear();
    };
  }, [shape]);

  // Register before the ship steps, after this frame's ephemeris is available.
  useFrame(() => {
    const ship = getLocalPlayerShip();
    if (!ship) return;
    const installed = entries.current;
    const nearby = seen.current;
    nearby.clear();
    frameOriginKm(ship.frameId, _shipOrigin);
    for (const point of store.get(replicationPointsAtom)) {
      if (point.starter || !isFrameId(point.frameId)) continue;
      const entry = installed.get(point.id);
      const [x, y, z] = point.positionKm;
      frameOriginKm(point.frameId, _position).sub(_shipOrigin);
      _position.set(_position.x + x, _position.y + y, _position.z + z);
      const range = entry ? COLLIDER_KEEP_KM : COLLIDER_RANGE_KM;
      if (_position.distanceToSquared(ship.posKm) > range * range) continue;
      nearby.add(point.id);
      if (entry && (entry.point === point || samePose(entry.point, point))) continue;
      const handle = nearField.addCollider(
        shape, point.frameId, _position.fromArray(point.positionKm), _quat.fromArray(point.quaternion), "replicationPoint",
      );
      if (entry) nearField.removeCollider(entry.handle);
      installed.set(point.id, { point, handle });
    }
    installed.forEach(({ handle }, id) => {
      if (nearby.has(id)) return;
      nearField.removeCollider(handle);
      installed.delete(id);
    });
  }, FRAME_PRIORITY_PLAYER_SHIP - 0.1);

  return null;
}
