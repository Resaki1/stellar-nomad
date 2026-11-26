"use client";

import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useAtomValue, useStore } from "jotai";
import { memo, Suspense, useEffect, useMemo, useRef } from "react";
import {
  EdgesGeometry, Group, LineBasicMaterial, LineSegments, LOD, Matrix4,
  Mesh, Quaternion, Vector3,
} from "three";
import { FRAME_PRIORITY_PLAYER_SHIP, FRAME_PRIORITY_REMOTE_SHIPS } from "@/components/frameOrder";
import { emitterColor } from "@/components/space/emissivePhotometry";
import { registerPreExposedEmissive } from "@/components/space/preExposedEmissive";
import { beaconFlash, emitLightPoints } from "@/components/space/lightPoints";
import { pushBeam, pushBeamLights } from "@/components/VFX/beams";
import { castAsteroidRayInField, copyHit, createAsteroidRayHit } from "@/sim/asteroids/asteroidRaycast";
import { getActiveAsteroidRuntime } from "@/sim/asteroids/runtimeContext";
import { systemConfigAtom } from "@/store/system";
import type { SystemConfig } from "@/sim/systemTypes";
import { simEpochMsAtom } from "@/store/simTime";
import type { ReplicationPoint, ShipPose, Vec3Tuple } from "@/save/types";
import { getLocalPlayerShip, localRenderPose } from "@/sim/entities";
import { frameOriginKm, type FrameId } from "@/sim/frames";
import { miningLegPosition, miningLegVelocity } from "@/sim/industry/sortie";
import { droneFlightProgress, minimumDroneFlightS } from "@/sim/industry/route";
import type { DepotRecord, DroneRecord } from "@/sim/industry/types";
import { readCollisionMeshes } from "@/components/models/collisionMeshes";
import { nearField, type NearFieldColliderId } from "@/sim/physics/nearField";
import type { ColliderShape } from "@/sim/physics/types";
import { isSimPaused } from "@/sim/simPause";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { worldAuthority } from "@/sim/world/worldAuthority";
import { industryAtom } from "@/store/industry";
import { replicationPointsAtom } from "@/store/replicationMirror";
import { depotPlacementAtom, depotPlacementPreview, sampleDepotPlacementPose, droneLiveKm } from "@/store/industryHud";
import { DroneMotion, MiningLegClock, smoothProgress } from "./droneMotion";
import { DRONE_LOD_DISTANCES_M, useDroneRenderAssets, type DroneRenderAssets } from "./DroneModel";
import { DEPOT_COLLISION_ASSET, DEPOT_LOD_ASSETS, DEPOT_LOD_DISTANCES_M, refineryMountMatrix, useDepotRenderAssets, type DepotRenderAssets } from "./DepotModel";

const REFINERY_BASE = "/models/stations/depot-refinery";
const REFINERY_LOD_ASSETS = [REFINERY_BASE + ".glb", REFINERY_BASE + "-lod1.glb", REFINERY_BASE + "-lod2.glb"];
const REFINERY_COLLISION_ASSET = REFINERY_BASE + "-collision.glb";

const DEPOT_RENDER_KM = 14;
/** Depot lamps stay visible as light points well past the mesh range (VFX plan §1). */
const DEPOT_LIGHT_RANGE_KM = 1_000;
const _lampMatrix = new Matrix4();
const _unit = new Vector3(1, 1, 1);
const DEPOT_COLLISION_KM = 3;
const DRONE_RENDER_KM = 3;
/** A visible drone this close to the local ship carries a collider at its drawn pose (WP2). */
const DRONE_COLLISION_KM = 0.4;
const BEAM_FADE_S = 0.6;

/** Drone laser power relative to the stock ship laser (beam radiance ∝ power, VFX plan B3). */
const DRONE_BEAM_POWER = 0.5;
const _beamEnd = new Vector3();
const _droneHit = createAsteroidRayHit();
const _droneFieldHit = createAsteroidRayHit();

/** First rock surface along a drone's beam (VFX plan §2 B1/B2), into `out` (scene metres). */
function castDroneBeam(system: SystemConfig, wo: Vector3, origin: Vector3, dir: Vector3, maxM: number, out: Vector3): boolean {
  const runtime = getActiveAsteroidRuntime();
  if (!runtime) return false;
  let best = maxM;
  let anchor: readonly number[] | null = null;
  for (const field of system.asteroidFields ?? []) {
    if (field.enabled === false) continue;
    const fr = runtime.getFieldRuntime(field.id);
    if (!fr) continue;
    const a = field.anchorKm;
    if (castAsteroidRayInField(fr.chunks, (wo.x - a[0]) * 1000 + origin.x, (wo.y - a[1]) * 1000 + origin.y,
      (wo.z - a[2]) * 1000 + origin.z, dir.x, dir.y, dir.z, best, _droneFieldHit)) {
      best = _droneFieldHit.t;
      copyHit(_droneFieldHit, _droneHit);
      anchor = a;
    }
  }
  if (!anchor) return false;
  out.set((anchor[0] - wo.x) * 1000 + _droneHit.point[0], (anchor[1] - wo.y) * 1000 + _droneHit.point[1],
    (anchor[2] - wo.z) * 1000 + _droneHit.point[2]);
  return true;
}
const PREVIEW_GOOD = new LineBasicMaterial({ name: "Clear depot outline", color: emitterColor("replication_preview"), transparent: true, opacity: 0.8, depthWrite: false });
const PREVIEW_BAD = new LineBasicMaterial({ name: "Blocked depot outline", color: emitterColor("replication_preview_bad"), transparent: true, opacity: 0.8, depthWrite: false });
for (const material of [PREVIEW_GOOD, PREVIEW_BAD]) registerPreExposedEmissive(material);

const _from = new Vector3(), _to = new Vector3();
const _origin = new Vector3(), _droneOffset = new Vector3(), _direction = new Vector3(), _offset = new Vector3();
const _orientation = new Quaternion();
const _colliderKm = new Vector3();
const _forward = new Vector3(0, 0, 1);
const _up = new Vector3(0, 1, 0);

type Position = Pick<ShipPose, "frameId" | "positionKm">;
type Destination = Position & Partial<Pick<ShipPose, "quaternion">>;

/** Resolve into the view-relative metre frame, keeping the small relative differences in f64. */
function scenePosition(pose: Position, worldOrigin: Readonly<Vector3>, into: Vector3): Vector3 {
  const p = pose.positionKm;
  if (localRenderPose.atMs >= 0 && localRenderPose.frameId === pose.frameId) {
    const r = localRenderPose.relKm;
    return into.set((p[0] - r[0]) * 1000, (p[1] - r[1]) * 1000, (p[2] - r[2]) * 1000);
  }
  frameOriginKm(pose.frameId, into).sub(worldOrigin);
  return into.set((into.x + p[0]) * 1000, (into.y + p[1]) * 1000, (into.z + p[2]) * 1000);
}

function DepotRefinery({ mount, depotLod }: { mount: DepotRenderAssets["refineryMount"]; depotLod: LOD }) {
  const models = useGLTF(REFINERY_LOD_ASSETS, false, false);
  const instances = useMemo(() => models.map(({ scene }) => scene.clone(true)), [models]);
  const ref = useRef<Group>(null!);
  useFrame(() => {
    const group = ref.current;
    if (!group) return;
    const level = depotLod.getCurrentLevel();
    group.children.forEach((child, i) => { child.visible = i === level; });
  }, FRAME_PRIORITY_REMOTE_SHIPS + 0.1);
  return <group ref={ref} name="depotRefinery" matrix={mount} matrixAutoUpdate={false} dispose={null}>
    {instances.map((object, level) => (
      <primitive key={level} object={object} name={`refineryLOD${level}`} visible={level === 0} />
    ))}
  </group>;
}

const Station = memo(function Station({ depot, assets }: { depot: DepotRecord; assets: DepotRenderAssets }) {
  const ref = useRef<Group>(null!);
  const store = useStore();
  const worldOrigin = useWorldOrigin();
  const lod = useMemo(() => {
    const model = new LOD();
    model.autoUpdate = false;
    assets.scenes.forEach((scene, level) => {
      const instance = scene.clone(true);
      instance.name = `depotLOD${level}`;
      instance.visible = level === 0;
      model.addLevel(instance, DEPOT_LOD_DISTANCES_M[level], 0.12);
    });
    return model;
  }, [assets]);
  useFrame(({ camera }) => {
    const group = ref.current;
    if (!group) return;
    scenePosition(depot, worldOrigin.worldOriginKm, group.position);
    const distSq = group.position.lengthSq();
    if (distSq <= (DEPOT_LIGHT_RANGE_KM * 1000) ** 2) {
      _lampMatrix.compose(group.position, group.quaternion, _unit);
      emitLightPoints(assets.lights, _lampMatrix, beaconFlash(store.get(simEpochMsAtom)));
    }
    group.visible = distSq <= (DEPOT_RENDER_KM * 1000) ** 2;
    if (!group.visible) return;
    lod.updateWorldMatrix(true, false);
    lod.update(camera);
  }, FRAME_PRIORITY_REMOTE_SHIPS);
  return <group ref={ref} name={`depot:${depot.id}`} quaternion={depot.quaternion} visible={false} dispose={null}>
    <primitive object={lod} name="depotLOD" />
    {depot.refinery && <Suspense fallback={null}>
      <DepotRefinery mount={assets.refineryMount} depotLod={lod} />
    </Suspense>}
  </group>;
});

function DepotStations({ depots }: { depots: readonly DepotRecord[] }) {
  const assets = useDepotRenderAssets();
  return <>{depots.map(depot => <Station key={depot.id} depot={depot} assets={assets} />)}</>;
}

function DepotPreviewModel() {
  const { scene } = useGLTF(DEPOT_LOD_ASSETS[2], false, false);
  const outline = useMemo(() => {
    const group = new Group();
    scene.updateMatrixWorld(true);
    scene.traverse(object => {
      if (!(object instanceof Mesh)) return;
      // Expose the collar, truss and solar trays through the end-on placement view.
      const edges = new EdgesGeometry(object.geometry, 24).applyMatrix4(object.matrixWorld);
      group.add(new LineSegments(edges, PREVIEW_GOOD));
    });
    return group;
  }, [scene]);
  useEffect(() => () => {
    outline.traverse(part => { if (part instanceof LineSegments) part.geometry.dispose(); });
  }, [outline]);
  const ref = useRef<Group>(null!);
  const lastValid = useRef<boolean | null>(null);
  const worldOrigin = useWorldOrigin();
  useFrame(() => {
    const group = ref.current;
    if (!group) return;
    group.visible = sampleDepotPlacementPose() && depotPlacementPreview.ready;
    if (!group.visible) return;
    scenePosition(depotPlacementPreview, worldOrigin.worldOriginKm, group.position);
    group.quaternion.fromArray(depotPlacementPreview.quaternion);
    if (lastValid.current !== depotPlacementPreview.valid) {
      lastValid.current = depotPlacementPreview.valid;
      const material = lastValid.current ? PREVIEW_GOOD : PREVIEW_BAD;
      group.traverse(object => { if (object instanceof LineSegments) object.material = material; });
    }
  }, FRAME_PRIORITY_REMOTE_SHIPS);
  return <group ref={ref} name="depotPlacementPreview" visible={false}>
    <primitive object={outline} />
  </group>;
}

function DepotPreview() {
  const placement = useAtomValue(depotPlacementAtom);
  return placement ? <Suspense fallback={null}><DepotPreviewModel /></Suspense> : null;
}

type StationEntry = { pose: ShipPose; handle: NearFieldColliderId };

function samePose(a: ShipPose, b: ShipPose): boolean {
  return a === b || (a.frameId === b.frameId &&
    a.positionKm.every((n, i) => n === b.positionKm[i]) &&
    a.quaternion.every((n, i) => n === b.quaternion[i]));
}

function DepotColliders({ depots }: { depots: readonly DepotRecord[] }) {
  const { scene } = useGLTF(DEPOT_COLLISION_ASSET, false, false);
  const shape = useMemo(() => readCollisionMeshes(scene), [scene]);
  return <DepotColliderSet depots={depots} shape={shape} tag="depot" />;
}

function RefineryColliders({ depots }: { depots: readonly DepotRecord[] }) {
  const [base] = useGLTF(DEPOT_LOD_ASSETS, false, false);
  const { scene } = useGLTF(REFINERY_COLLISION_ASSET, false, false);
  const shape = useMemo(() => readCollisionMeshes(scene, refineryMountMatrix(base.scene)), [scene, base.scene]);
  return <DepotColliderSet depots={depots} shape={shape} tag="depotRefinery" />;
}

function DepotColliderSet({ depots, shape, tag }: {
  depots: readonly DepotRecord[];
  shape: ColliderShape;
  tag: "depot" | "depotRefinery";
}) {
  const entries = useRef(new Map<string, StationEntry>());
  const byId = useMemo(() => new Map(depots.map(depot => [depot.id, depot])), [depots]);

  useEffect(() => {
    const all = entries.current;
    return () => {
      all.forEach(({ handle }) => nearField.removeCollider(handle));
      all.clear();
    };
  }, [shape]);

  useFrame(() => {
    const ship = getLocalPlayerShip();
    if (!ship) return;
    const all = entries.current;
    all.forEach((entry, key) => {
      const depot = byId.get(key);
      if (depot && samePose(entry.pose, depot) && withinColliderRange(depot, ship, DEPOT_COLLISION_KM * 1.2)) return;
      nearField.removeCollider(entry.handle);
      all.delete(key);
    });
    for (const depot of depots) {
      if (all.has(depot.id) || !withinColliderRange(depot, ship, DEPOT_COLLISION_KM)) continue;
      const handle = nearField.addCollider(
        shape, depot.frameId, _offset.fromArray(depot.positionKm), _orientation.fromArray(depot.quaternion), tag,
      );
      all.set(depot.id, { pose: depot, handle });
    }
  }, FRAME_PRIORITY_PLAYER_SHIP - 0.1);
  return null;
}

function withinColliderRange(pose: Position, ship: NonNullable<ReturnType<typeof getLocalPlayerShip>>, km: number): boolean {
  const p = pose.positionKm;
  const s = ship.posKm;
  _origin.set(0, 0, 0);
  if (pose.frameId !== ship.frameId) frameOriginKm(pose.frameId, _origin).sub(frameOriginKm(ship.frameId, _offset));
  return (p[0] - s.x + _origin.x) ** 2 + (p[1] - s.y + _origin.y) ** 2 + (p[2] - s.z + _origin.z) ** 2 <= km ** 2;
}

function UtilityDrone({ drone, home, dest, index, assets }: {
  drone: DroneRecord; home: DepotRecord; dest: Destination | undefined; index: number; assets: DroneRenderAssets;
}) {
  const ship = useRef<Group>(null!);
  const lod = useMemo(() => {
    const model = new LOD();
    model.autoUpdate = false;
    assets.scenes.forEach((scene, level) => {
      const instance = scene.clone(true);
      instance.name = `droneLOD${level}`;
      instance.visible = level === 0;
      model.addLevel(instance, DRONE_LOD_DISTANCES_M[level], 0.12);
    });
    return model;
  }, [assets]);
  const motion = useMemo(() => new DroneMotion(), []);
  const clock = useMemo(() => new MiningLegClock(), []);
  const pose = useMemo(() => ({
    frameId: home.frameId, positionKm: [0, 0, 0] as Vec3Tuple,
    velocity: [0, 0, 0] as Vec3Tuple, previous: new Vector3(), correction: new Vector3(), active: false,
  }), [home.frameId]); // The tuple is rewritten every frame.
  const store = useStore();
  const target = useRef<Destination | undefined>(undefined);
  const drawn = useRef(false);
  const worldOrigin = useWorldOrigin();
  const lane = index % 2 === 0 ? 1 : -1;
  const collider = useRef<NearFieldColliderId | null>(null);
  useEffect(() => () => {
    if (collider.current !== null) nearField.removeCollider(collider.current);
    collider.current = null;
  }, []);
  useFrame(({ camera }, delta) => {
    const g = ship.current;
    if (!g) return;
    const w = worldOrigin.worldOriginKm;
    const dt = isSimPaused() ? 0 : Math.min(delta, 0.15);
    if (!drone.sortie && (dt > 0 || !drawn.current)) motion.advance(drone, dt);
    if (motion.targetId === drone.job?.targetId && drone.phase !== "idle") target.current = dest;

    _orientation.fromArray(home.quaternion);
    _droneOffset.set(lane * 8, 10, -12).applyQuaternion(_orientation);
    scenePosition(home, w, _from).add(_droneOffset);
    const timeS = motion.timeS;
    const returnStartS = motion.legS + motion.workS;
    const returning = timeS >= returnStartS;
    const onTrip = motion.legS > 0 && timeS < returnStartS + motion.legS;
    const rock = motion.rock;
    const destination: Destination | undefined = rock ?? target.current;
    let visibleFlight = !onTrip;
    let strength = 0;

    const sortie = drone.sortie;
    if (sortie) {
      const changed = clock.advance(drone, dt);
      const flying = drone.phase === "outbound" || drone.phase === "returning";
      if (flying) {
        miningLegPosition(sortie.leg, clock.elapsed, drone.durationS, pose.positionKm);
        miningLegVelocity(sortie.leg, clock.elapsed, drone.durationS, pose.velocity);
        _direction.fromArray(pose.velocity);
        if (_direction.lengthSq() > 1e-12) _orientation.setFromUnitVectors(_forward, _direction.normalize());
        else _orientation.copy(g.quaternion);
      } else {
        const at = sortie.leg.toKm;
        for (let axis = 0; axis < 3; axis++) pose.positionKm[axis] = at[axis];
        _orientation.copy(g.quaternion);
      }
      // The host can recall at a different instant than this client's predicted pose.
      // Reconcile in the body's frame so a camera movement cannot drag the drone with it.
      if (changed && pose.active) pose.correction.copy(pose.previous).sub(_offset.fromArray(pose.positionKm));
      pose.correction.multiplyScalar(Math.exp(-dt / 0.25));
      pose.previous.fromArray(pose.positionKm).add(pose.correction).toArray(pose.positionKm);
      pose.active = visibleFlight = true;
      scenePosition(pose, w, g.position);
      const workRock = drone.flight?.rock;
      if (drone.phase === "working" && workRock && !worldAuthority.asteroids.has(workRock.fieldId, workRock.chunkKey, workRock.instanceId)) {
        const t = clock.elapsed;
        strength = smoothProgress(t / BEAM_FADE_S) * smoothProgress((drone.durationS - t) / BEAM_FADE_S);
        scenePosition(workRock, w, _to);
        _orientation.setFromUnitVectors(_forward, _direction.subVectors(_to, g.position).normalize());
      }
    } else if (!onTrip || !destination || motion.via || home.frameId !== destination.frameId) {
      g.position.copy(_from);
    } else {
      scenePosition(destination, w, _to);
      if (rock) {
        // Approach from the near side of the rock, keeping both drone lanes out of the hulls.
        _direction.subVectors(_from, _to).normalize();
        _droneOffset.crossVectors(_up, _direction);
        if (_droneOffset.lengthSq() < 1e-6) _droneOffset.set(1, 0, 0);
        _to.addScaledVector(_direction, rock.radiusM + 14)
          .addScaledVector(_droneOffset.normalize(), lane * 5);
      } else if (destination.quaternion) {
        _orientation.fromArray(destination.quaternion);
        _to.add(_droneOffset.set(lane * 7, 10, -13).applyQuaternion(_orientation));
      }

      const pathKm = _from.distanceTo(_to) / 1000;
      // Legacy funded trips still settle in the authority. Draw only trips the physical profile can fly.
      visibleFlight = minimumDroneFlightS(pathKm, motion.profile) <= motion.legS;
      if (!visibleFlight) {
        g.position.copy(_from);
      } else if (timeS >= motion.legS && !returning) {
        g.position.copy(_to);
        if (rock) {
          const workS = timeS - motion.legS;
          if (!worldAuthority.asteroids.has(rock.fieldId, rock.chunkKey, rock.instanceId)) {
            strength = smoothProgress(workS / BEAM_FADE_S) * smoothProgress((motion.workS - workS) / BEAM_FADE_S);
          }
          scenePosition(destination, w, _to);
          _direction.subVectors(_to, g.position).normalize();
          _orientation.setFromUnitVectors(_forward, _direction);
        }
      } else {
        const elapsedS = returning ? timeS - returnStartS : timeS;
        const fraction = droneFlightProgress(pathKm, elapsedS, motion.legS, motion.profile);
        g.position.lerpVectors(_from, _to, returning ? 1 - fraction : fraction);
        _direction.subVectors(_to, _from).multiplyScalar(returning ? -1 : 1);
        if (_direction.lengthSq() > 1) _orientation.setFromUnitVectors(_forward, _direction.normalize());
      }
    }

    if (!sortie && pose.active) {
      pose.active = false;
      pose.correction.set(0, 0, 0);
      clock.reset();
    }
    const live = droneLiveKm.get(g.name);
    if (live && live.frameId === home.frameId) {
      scenePosition(home, w, _origin);
      _direction.subVectors(g.position, _origin).multiplyScalar(0.001)
        .add(_offset.fromArray(home.positionKm)).toArray(live.positionKm);
    }
    if (!drawn.current) {
      g.quaternion.copy(_orientation);
      drawn.current = true;
    } else {
      g.quaternion.slerp(_orientation, -Math.expm1(-dt / 0.15));
    }

    g.visible = visibleFlight && g.position.lengthSq() <= (DRONE_RENDER_KM * 1000) ** 2;
    syncDroneCollider(collider, assets.shape, g, home, w);
    if (!g.visible) return;
    lod.updateWorldMatrix(true, false);
    lod.update(camera);
    _lampMatrix.compose(g.position, g.quaternion, _unit);
    emitLightPoints(assets.lights, _lampMatrix, beaconFlash(store.get(simEpochMsAtom)));
    if (strength > 0.001) {
      // VFX plan §2 B2: the shared beam, from the emitter along the drone's own axis to the
      // first rock surface (never bent onto the rock's centre).
      _droneOffset.copy(assets.miningPosition).applyMatrix4(_lampMatrix);
      _direction.copy(assets.miningDirection).applyQuaternion(g.quaternion);
      const reach = _to.distanceTo(_droneOffset) + 60;
      const hit = castDroneBeam(store.get(systemConfigAtom), w, _droneOffset, _direction, reach, _beamEnd);
      if (!hit) _beamEnd.copy(_droneOffset).addScaledVector(_direction, Math.max(0, _to.distanceTo(_droneOffset)));
      pushBeam(_droneOffset.x, _droneOffset.y, _droneOffset.z, _beamEnd.x, _beamEnd.y, _beamEnd.z, strength, DRONE_BEAM_POWER, index);
      pushBeamLights(_droneOffset.x, _droneOffset.y, _droneOffset.z, _beamEnd.x, _beamEnd.y, _beamEnd.z, hit, strength, DRONE_BEAM_POWER);
    }
  }, FRAME_PRIORITY_REMOTE_SHIPS);
  return <group ref={ship} name={`drone:${drone.id}`} visible={false} dispose={null}>
    <primitive object={lod} name="droneLOD" />
  </group>;
}

/** Keep the drone's contact surface on its drawn pose while it is visible and near the local ship. */
function syncDroneCollider(handle: { current: NearFieldColliderId | null }, shape: ColliderShape, g: Group, home: DepotRecord, w: Vector3): void {
  // The world origin sits on the local ship, so scene metres are ship-relative.
  const near = g.visible && g.position.lengthSq() <= (DRONE_COLLISION_KM * 1000) ** 2;
  if (!near) {
    if (handle.current !== null) nearField.removeCollider(handle.current);
    handle.current = null;
    return;
  }
  scenePosition(home, w, _origin);
  _colliderKm.subVectors(g.position, _origin).multiplyScalar(0.001).add(_offset.fromArray(home.positionKm));
  const frameId = home.frameId as FrameId;
  if (handle.current === null) handle.current = nearField.addCollider(shape, frameId, _colliderKm, g.quaternion, "drone");
  else nearField.setColliderPose(handle.current, frameId, _colliderKm, g.quaternion);
}

function UtilityDrones({ depots, drones, points }: {
  depots: readonly DepotRecord[];
  drones: readonly DroneRecord[];
  points: readonly ReplicationPoint[];
}) {
  const assets = useDroneRenderAssets();
  return drones.map((drone, index) => {
    const home = depots.find(d => d.id === drone.homeId);
    const job = drone.job;
    const dest = !job || job.kind === "mine" ? undefined
      : job.targetKind === "point" ? points.find(p => p.id === job.targetId && !p.starter)
      : depots.find(d => d.id === job.targetId);
    return home ? <UtilityDrone key={drone.id} drone={drone} home={home} dest={dest} index={index} assets={assets} /> : null;
  });
}

export default function IndustryWorld() {
  const { depots, drones } = useAtomValue(industryAtom);
  const points = useAtomValue(replicationPointsAtom);
  const upgradedDepots = useMemo(() => depots.filter(depot => depot.refinery), [depots]);
  return <>
    {depots.length > 0 && <>
      <Suspense fallback={null}><DepotColliders depots={depots} /></Suspense>
      <Suspense fallback={null}><DepotStations depots={depots} /></Suspense>
    </>}
    {upgradedDepots.length > 0 && <Suspense fallback={null}><RefineryColliders depots={upgradedDepots} /></Suspense>}
    <DepotPreview />
    {drones.length > 0 && <Suspense fallback={null}>
      <UtilityDrones depots={depots} drones={drones} points={points} />
    </Suspense>}
  </>;
}
