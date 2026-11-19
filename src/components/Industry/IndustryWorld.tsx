"use client";

import { useFrame } from "@react-three/fiber";
import { useAtomValue } from "jotai";
import { memo, useEffect, useMemo, useRef } from "react";
import {
  BoxGeometry, BufferGeometry, Color, CylinderGeometry, DodecahedronGeometry, Group, IcosahedronGeometry, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, Quaternion, Vector3,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { FRAME_PRIORITY_REMOTE_SHIPS } from "@/components/frameOrder";
import { registerPreExposedEmissive } from "@/components/space/preExposedEmissive";
import type { ShipPose } from "@/save/types";
import { getLocalPlayerShip, localRenderPose } from "@/sim/entities";
import { frameOriginKm } from "@/sim/frames";
import { INDUSTRY_SOURCES, type IndustrySource } from "@/sim/industry/catalog";
import type { DepotRecord, DroneRecord, IndustryState } from "@/sim/industry/types";
import { DEPOT_HULL } from "@/sim/physics/depotShape";
import { nearField, type NearFieldColliderId } from "@/sim/physics/nearField";
import { isSimPaused } from "@/sim/simPause";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { industryAtom } from "@/store/industry";
import { depotPlacementAtom, depotPlacementPreview, sampleDepotPlacementPose } from "@/store/industryHud";

const DEPOT_RENDER_KM = 14;
const DEPOT_COLLISION_KM = 3;
const DRONE_RENDER_KM = 3;
const SOURCE_RENDER_KM = 3;
const BOX = new BoxGeometry();
const TANK_BODY = new CylinderGeometry(1, 1, 1, 16).rotateX(Math.PI * 0.5);
const TANK_CAP = new CylinderGeometry(0.52, 1, 1, 16).rotateX(Math.PI * 0.5);
const SOURCE_GEOMETRY = new DodecahedronGeometry(1, 0);
const DRONE_GEOMETRY = new IcosahedronGeometry(1, 0);

const FRAME = new MeshStandardMaterial({ color: "#293745", metalness: 0.75, roughness: 0.62 });
const SHELL = new MeshStandardMaterial({ color: "#a7b2b9", metalness: 0.48, roughness: 0.57 });
const TANK = new MeshStandardMaterial({ color: "#986532", metalness: 0.38, roughness: 0.8 });
const RADIATOR = new MeshStandardMaterial({ color: "#244661", metalness: 0.7, roughness: 0.46 });
const ROBOTIC = new MeshStandardMaterial({ color: "#637a88", metalness: 0.65, roughness: 0.43 });
const RUBBER = new MeshStandardMaterial({ color: "#111819", metalness: 0.08, roughness: 0.9 });
const PROSPECT = new MeshStandardMaterial({ color: "#9da2a5", metalness: 0.2, roughness: 0.94 });
const LIGHT = new MeshBasicMaterial({ color: new Color(0.22, 0.66, 1.45), toneMapped: false });
const AMBER = new MeshBasicMaterial({ color: new Color(1.8, 0.66, 0.08), toneMapped: false });
const BEAM = new MeshBasicMaterial({ color: new Color(0.05, 0.7, 1.7), transparent: true, opacity: 0.75, depthWrite: false, toneMapped: false });
const PREVIEW_GOOD = new MeshBasicMaterial({ color: new Color("#43dcb6"), transparent: true, opacity: 0.32, depthWrite: false });
const PREVIEW_BAD = new MeshBasicMaterial({ color: new Color("#f17e5a"), transparent: true, opacity: 0.32, depthWrite: false });
for (const material of [LIGHT, AMBER, BEAM]) registerPreExposedEmissive(material);

const materials = { core: SHELL, spine: FRAME, front: FRAME, tank: TANK, outrigger: FRAME, radiator: RADIATOR };
const _from = new Vector3(), _to = new Vector3();
const _via = new Vector3();
const _origin = new Vector3(), _droneOffset = new Vector3(), _direction = new Vector3(), _offset = new Vector3();
const _orientation = new Quaternion();
const _forward = new Vector3(0, 0, 1);

type Position = Pick<ShipPose, "frameId" | "positionKm">;

function prospectWorksite(source: IndustrySource, depots: readonly DepotRecord[]): IndustrySource {
  const [x, y, z] = source.positionKm;
  // A prospect is a field location. Show its local survey pocket clear of any depot erected at the marker.
  let offsetKm = 0.085;
  while (depots.some(d => d.frameId === source.frameId &&
    Math.hypot(d.positionKm[0] - x, d.positionKm[1] - y - offsetKm, d.positionKm[2] - z) < 0.065)) offsetKm += 0.145;
  return { ...source, positionKm: [x, y + offsetKm, z] };
}

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

type DepotMaterial = MeshStandardMaterial | MeshBasicMaterial;

/** Share one batch per material across depots. The preview keeps the conservative contact outline. */
function depotMeshes(preview: boolean): { geometry: BufferGeometry; material: DepotMaterial }[] {
  const batches = new Map<DepotMaterial, BufferGeometry[]>();
  function part(material: DepotMaterial, p: readonly number[], s: readonly number[], source: BufferGeometry = BOX): void {
    const existing = batches.get(material);
    const piece = source.clone().scale(s[0], s[1], s[2]).translate(p[0], p[1], p[2]);
    if (existing) existing.push(piece);
    else batches.set(material, [piece]);
  }
  if (preview) {
    for (const { position, size } of DEPOT_HULL) part(PREVIEW_GOOD, position, size);
  } else {
    for (const { part: kind, position, size } of DEPOT_HULL) {
      if (kind === "tank") continue;
      part(materials[kind], position, size);
    }
    // Pressure vessels in square load-bearing racks. Straps and corner rails follow the contact envelope.
    for (const side of [-1, 1]) {
      const x = side * 11;
      part(TANK, [x, -1, 0], [2.9, 3.65, 12.2], TANK_BODY);
      part(TANK, [x, -1, 7.02], [2.9, 3.65, 1.85], TANK_CAP);
      part(TANK, [x, -1, -7.02], [2.9, -3.65, -1.85], TANK_CAP);
      for (const z of [-4.6, 4.6]) part(ROBOTIC, [x, -1, z], [2.98, 3.78, 0.95], TANK_BODY);
      for (const a of [-1, 1]) {
        for (const b of [-1, 1]) part(FRAME, [x + a * 2.73, -1 + b * 3.72, 0], [0.52, 0.52, 16]);
      }
      for (const z of [-7.72, 7.72]) {
        for (const b of [-1, 1]) part(ROBOTIC, [x, -1 + b * 3.68, z], [5.75, 0.55, 0.56]);
      }
      part(FRAME, [x, -1, 8.02], [0.95, 0.95, 0.13], TANK_BODY);

      // Radiator louvers sit in framed edge supports, with bright navigation lamps at the tips.
      for (const dx of [-2.82, 2.82]) part(ROBOTIC, [side * 25 + dx, 0, -4], [0.35, 0.7, 12]);
      for (const z of [-9.8, -6.9, -4, -1.1, 1.8]) part(FRAME, [side * 25, 0.38, z], [5.55, 0.2, 0.28]);
      part(ROBOTIC, [side * 25, 0.4, -4], [0.31, 0.16, 11.5]);
      part(AMBER, [side * 27.75, 0.45, 1.65], [0.46, 0.2, 0.46]);
      for (const z of [-5.2, -2.8]) part(ROBOTIC, [side * 19, 0.92, z], [9.9, 0.52, 0.36]);

      // Hardware and yellow guide brackets around the closed transfer port.
      part(ROBOTIC, [side * 5.7, 0, 15.83], [0.62, 5.8, 0.46]);
      part(SHELL, [side * 3.65, -2.25, 16.12], [0.44, 1.0, 0.35]);
      part(SHELL, [side * 3.65, 2.25, 16.12], [0.44, 1.0, 0.35]);
      part(LIGHT, [side * 5.65, 1, 16.07], [0.12, 1.7, 0.08]);
      part(FRAME, [side * 5.4, 3.64, 0], [1.8, 0.9, 21.6]);
    }
    part(RUBBER, [0, 0.12, 16.035], [8.8, 4.1, 0.12]);
    part(ROBOTIC, [0, 0.12, 16.13], [7.05, 3.12, 0.17]);
    part(RUBBER, [0, 0.12, 16.25], [0.22, 2.65, 0.08]);
    part(AMBER, [0, -2.27, 16.15], [6.9, 0.11, 0.1]);
    part(LIGHT, [0, 2.2, 16.12], [6.65, 0.2, 0.13]);
    part(ROBOTIC, [0, 4.08, -3], [6, 0.42, 13]);
    for (const z of [-8, -6, -4, -2, 0, 2]) part(FRAME, [0, 4.32, z], [5.55, 0.1, 0.28]);
    part(SHELL, [0, 3.28, -16], [4.9, 0.65, 4.95]);
    part(AMBER, [0, 1.72, -19.02], [3.8, 0.22, 0.06]);
  }
  return Array.from(batches, ([material, pieces]) => {
    const geometry = mergeGeometries(pieces);
    for (const piece of pieces) piece.dispose();
    return { geometry, material };
  });
}

const DEPOT_MESHES = depotMeshes(false);
const PREVIEW_MESHES = depotMeshes(true);

function DepotHull({ preview = false, refinery = false }: { preview?: boolean; refinery?: boolean }) {
  const meshes = preview ? PREVIEW_MESHES : DEPOT_MESHES;
  return <>
    {meshes.map(({ geometry, material }) => (
      <mesh key={material.uuid} geometry={geometry} material={material} />
    ))}
    {refinery && <mesh geometry={BOX} material={AMBER} position={[0, -2.75, -19.02]} scale={[4.3, 0.83, 0.08]} />}
  </>;
}

const Station = memo(function Station({ depot }: { depot: DepotRecord }) {
  const ref = useRef<Group>(null!);
  const worldOrigin = useWorldOrigin();
  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    scenePosition(depot, worldOrigin.worldOriginKm, g.position);
    g.visible = g.position.lengthSq() <= (DEPOT_RENDER_KM * 1000) ** 2;
  }, FRAME_PRIORITY_REMOTE_SHIPS);
  return <group ref={ref} name={`depot:${depot.id}`} quaternion={depot.quaternion} visible={false}>
    <DepotHull refinery={depot.refinery} />
  </group>;
});

function DepotPreview() {
  const name = useAtomValue(depotPlacementAtom);
  const ref = useRef<Group>(null!);
  const lastValid = useRef<boolean | null>(null);
  const worldOrigin = useWorldOrigin();
  useFrame(() => {
    if (!name || !ref.current) return;
    const g = ref.current;
    g.visible = sampleDepotPlacementPose() && depotPlacementPreview.ready;
    if (!g.visible) return;
    scenePosition(depotPlacementPreview, worldOrigin.worldOriginKm, g.position);
    g.quaternion.fromArray(depotPlacementPreview.quaternion);
    if (lastValid.current !== depotPlacementPreview.valid) {
      lastValid.current = depotPlacementPreview.valid;
      const material = lastValid.current ? PREVIEW_GOOD : PREVIEW_BAD;
      g.traverse(object => { if (object instanceof Mesh) object.material = material; });
    }
  }, FRAME_PRIORITY_REMOTE_SHIPS);
  useEffect(() => () => { lastValid.current = null; }, [name]);
  return name ? <group ref={ref} name="depotPlacementPreview" visible={false}><DepotHull preview /></group> : null;
}

type StationEntry = { pose: ShipPose; handles: NearFieldColliderId[] };

function DepotColliders({ depots }: { depots: IndustryState["depots"] }) {
  const entries = useRef(new Map<string, StationEntry>());
  useEffect(() => {
    const all = entries.current;
    return () => {
      all.forEach(entry => entry.handles.forEach(id => nearField.removeCollider(id)));
      all.clear();
    };
  }, []);
  useFrame(() => {
    const ship = getLocalPlayerShip();
    if (!ship) return;
    const all = entries.current;
    all.forEach((entry, key) => {
      if (!depots.some(depot => depot.id === key) || !withinColliderRange(entry.pose, ship, DEPOT_COLLISION_KM * 1.2)) {
        entry.handles.forEach(id => nearField.removeCollider(id));
        all.delete(key);
      }
    });
    for (const depot of depots) {
      if (all.has(depot.id) || !withinColliderRange(depot, ship, DEPOT_COLLISION_KM)) continue;
      _orientation.fromArray(depot.quaternion);
      const handles = DEPOT_HULL.map(({ position, size }) => {
        const p = depot.positionKm;
        _offset.fromArray(position).multiplyScalar(0.001).applyQuaternion(_orientation);
        _offset.set(_offset.x + p[0], _offset.y + p[1], _offset.z + p[2]);
        return nearField.addCollider({ kind: "box", halfX: size[0] / 2, halfY: size[1] / 2, halfZ: size[2] / 2 },
          depot.frameId, _offset, _orientation, "depot");
      });
      all.set(depot.id, { pose: depot, handles });
    }
  }, FRAME_PRIORITY_REMOTE_SHIPS);
  return null;
}

function withinColliderRange(pose: Position, ship: NonNullable<ReturnType<typeof getLocalPlayerShip>>, km: number): boolean {
  const p = pose.positionKm;
  const s = ship.posKm;
  _origin.set(0, 0, 0);
  if (pose.frameId !== ship.frameId) frameOriginKm(pose.frameId, _origin).sub(frameOriginKm(ship.frameId, _offset));
  return (p[0] - s.x + _origin.x) ** 2 + (p[1] - s.y + _origin.y) ** 2 + (p[2] - s.z + _origin.z) ** 2 <= km ** 2;
}

const Prospect = memo(function Prospect({ source }: { source: (typeof INDUSTRY_SOURCES)[number] }) {
  const ref = useRef<Group>(null!);
  const worldOrigin = useWorldOrigin();
  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    scenePosition(source, worldOrigin.worldOriginKm, g.position);
    g.visible = g.position.lengthSq() <= (SOURCE_RENDER_KM * 1000) ** 2;
  }, FRAME_PRIORITY_REMOTE_SHIPS);
  return <group ref={ref} name={`industrySource:${source.id}`} visible={false}>
    <mesh geometry={SOURCE_GEOMETRY} material={PROSPECT} scale={[7, 4, 5]} />
    <mesh geometry={SOURCE_GEOMETRY} material={RADIATOR} position={[3, 1, -1]} rotation={[0.2, 0.1, 0.6]} scale={[3.5, 2.8, 1.4]} />
    <mesh geometry={SOURCE_GEOMETRY} material={PROSPECT} position={[-10, 3, 7]} rotation={[1, 0.7, 0.4]} scale={[2.8, 2.2, 2.1]} />
  </group>;
});

function UtilityDrone({ drone, home, dest, index }: { drone: DroneRecord; home: DepotRecord; dest: Position | undefined; index: number }) {
  const ship = useRef<Group>(null!);
  const beam = useRef<Mesh>(null!);
  const phase = useRef({ kind: drone.phase, remainingS: drone.remainingS, elapsedS: 0 });
  const worldOrigin = useWorldOrigin();
  const lane = index % 2 === 0 ? 1 : -1;
  useFrame((_, delta) => {
    const g = ship.current;
    const ray = beam.current;
    if (!g || !ray) return;
    const w = worldOrigin.worldOriginKm;
    const now = performance.now();
    const drive = phase.current;
    const flying = drone.phase === "outbound" || drone.phase === "returning";
    const work = drone.phase === "working" && drone.status === "extracting" && dest;
    if (drive.kind !== drone.phase || drive.remainingS !== drone.remainingS) {
      drive.kind = drone.phase;
      drive.remainingS = drone.remainingS;
      drive.elapsedS = 0;
    } else if (!isSimPaused()) {
      drive.elapsedS = Math.min(1, drive.elapsedS + Math.min(delta, 0.15));
    }
    // Draw up to one second of the current leg. Arrival and work still require a committed phase change.
    const progress = flying && drone.durationS > 0 ? 1 - Math.max(0, drive.remainingS - drive.elapsedS) / drone.durationS : 0;

    _orientation.fromArray(home.quaternion);
    _droneOffset.set(lane * 8, 10, -12).applyQuaternion(_orientation);
    scenePosition(home, w, _from).add(_droneOffset);
    if (dest) scenePosition(dest, w, _to);
    else _to.copy(_from);
    if (drone.job?.kind === "extract") {
      _to.x += lane * 7; _to.y += 11; _to.z += 9;
    } else {
      _to.x += lane * 7; _to.y += 10; _to.z -= 13;
    }

    if (!dest || drone.phase === "idle") {
      g.position.copy(_from);
      g.quaternion.copy(_orientation);
    } else if (drone.phase === "working") {
      g.position.copy(_to);
      if (work) {
        g.position.x += Math.sin(now / 1000 + index) * 0.6;
        g.position.y += Math.cos(now / 1300 + index) * 0.35;
      }
    } else {
      const returning = drone.phase === "returning";
      let legProgress = returning ? 1 - progress : progress;
      if (drone.via && drone.via.fraction > 0 && drone.via.fraction < 1) {
        scenePosition(drone.via, w, _via);
        const fraction = drone.via.fraction;
        if (legProgress <= fraction) {
          _to.copy(_via);
          legProgress /= fraction;
        } else {
          _from.copy(_via);
          legProgress = (legProgress - fraction) / (1 - fraction);
        }
      }
      // Hold direction and pass the same waypoints. Ease departures and arrivals on distant segments
      // so the drive transition is visible within the close rendering range.
      if (_from.distanceToSquared(_to) > 20_000 ** 2) {
        legProgress = legProgress < 0.5 ? 4 * legProgress ** 3 : 1 - 4 * (1 - legProgress) ** 3;
      }
      g.position.lerpVectors(_from, _to, legProgress);
      _direction.subVectors(_to, _from).multiplyScalar(returning ? -1 : 1);
      if (_direction.lengthSq() > 1) g.quaternion.setFromUnitVectors(_forward, _direction.normalize());
    }
    g.visible = g.position.lengthSq() <= (DRONE_RENDER_KM * 1000) ** 2;
    ray.visible = !!work && g.visible;
    if (work && g.visible) {
      scenePosition(dest, w, _to);
      _to.x += Math.sin(now / 840 + index) * 2;
      _to.z += Math.cos(now / 690 + index) * 1.5;
      _direction.subVectors(_to, g.position);
      ray.position.copy(g.position).addScaledVector(_direction, 0.5);
      ray.scale.set(0.16, 0.16, _direction.length());
      ray.quaternion.setFromUnitVectors(_forward, _direction.normalize());
      g.quaternion.copy(ray.quaternion);
    }
  }, FRAME_PRIORITY_REMOTE_SHIPS);
  return <>
    <group ref={ship} name={`drone:${drone.id}`} visible={false}>
      <mesh geometry={DRONE_GEOMETRY} material={FRAME} scale={[1.6, 1.25, 2.7]} />
      <mesh geometry={BOX} material={TANK} position={[-1.47, 0, -0.23]} scale={[0.74, 0.9, 2.5]} />
      <mesh geometry={BOX} material={TANK} position={[1.47, 0, -0.23]} scale={[0.74, 0.9, 2.5]} />
      <mesh geometry={BOX} material={LIGHT} position={[0, 0.12, 2.13]} scale={[0.85, 0.22, 0.24]} />
      <mesh geometry={BOX} material={AMBER} position={[0, 0, -2.13]} scale={[0.95, 0.7, 0.25]} />
    </group>
    <mesh ref={beam} geometry={BOX} material={BEAM} name={`droneBeam:${drone.id}`} visible={false} />
  </>;
}

export default function IndustryWorld() {
  const { depots, drones } = useAtomValue(industryAtom);
  const prospects = useMemo(() => INDUSTRY_SOURCES.map(source => prospectWorksite(source, depots)), [depots]);
  return <>
    <DepotColliders depots={depots} />
    <DepotPreview />
    {depots.map(depot => <Station key={depot.id} depot={depot} />)}
    {prospects.map(source => <Prospect key={source.id} source={source} />)}
    {drones.map((drone, index) => {
      const home = depots.find(d => d.id === drone.homeId);
      const job = drone.job;
      const dest = !job ? undefined : job.kind === "extract" ? prospects.find(s => s.id === job.targetId) : depots.find(d => d.id === job.targetId);
      return home ? <UtilityDrone key={drone.id} drone={drone} home={home} dest={dest} index={index} /> : null;
    })}
  </>;
}
