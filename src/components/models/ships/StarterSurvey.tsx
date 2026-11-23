import { useEffect, useMemo, type JSX, type RefObject } from "react";
import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { LOD, Mesh, Vector3, type Group } from "three";
import { FRAME_PRIORITY_REMOTE_SHIPS } from "@/components/frameOrder";
import EngineExhaust, { type ExhaustConfig } from "@/components/VFX/EngineExhaust";
import { readCollisionMeshes } from "../collisionMeshes";
import type { ColliderShape } from "@/sim/physics/types";
import { ambientAt, createAmbient } from "@/sim/atmosphere";
import { createDrivePlume, drivePlume } from "@/sim/ship/atmoDrive";
import { DEFAULT_RESOURCE_TUNING } from "@/sim/ship/resourceTuning";
import { createThermal, loopTempK, stepBells } from "@/sim/ship/thermal";
import { useWorldOrigin } from "@/sim/worldOrigin";
import { shipRes } from "@/store/shipResources";
import { useBellGlow } from "./bellGlow";

const BASE = "/models/ships/starter-survey";
const HERO = BASE + ".glb";
const COLLISION = BASE + "-collision.glb";
const DISTANT_ASSETS = [BASE + "-lod1.glb", BASE + "-lod2.glb"];
const REMOTE_DISTANCES = [0, 90, 240];
const NOZZLE_RADIUS_M = 0.455;

type SurveyProps = Omit<JSX.IntrinsicElements["group"], "children"> & {
  thrust: RefObject<number>;
  onCollisionShape: (shape: ColliderShape) => void;
};

function hullInstance(source: Group): Group {
  const instance = source.clone(true);
  instance.traverse((part) => {
    if (part instanceof Mesh) part.castShadow = part.receiveShadow = true;
  });
  return instance;
}

function nozzleConfigs(source: Group): ExhaustConfig[] {
  return ["socket_engine_port", "socket_engine_starboard"].map((name) => {
    const socket = source.getObjectByName(name);
    if (!socket) throw new Error(`Starter survey ship is missing ${name}`);
    return { position: socket.getWorldPosition(new Vector3()).toArray(), radius: NOZZLE_RADIUS_M };
  });
}

export function StarterSurvey({ thrust, onCollisionShape, ...props }: SurveyProps) {
  const hero = useGLTF(HERO, false, false);
  const collision = useGLTF(COLLISION, false, false);
  const hull = useMemo(() => hullInstance(hero.scene), [hero.scene]);
  const nozzles = useMemo(() => nozzleConfigs(hero.scene), [hero.scene]);
  // The player's bells: the sim's thermal network (HEAT_SYSTEM_PLAN H1).
  useBellGlow(hull, () => shipRes.thermal.bellK);
  useEffect(() => {
    onCollisionShape(readCollisionMeshes(collision.scene));
  }, [collision.scene, onCollisionShape]);
  return (
    <group {...props} dispose={null}>
      <primitive object={hull} />
      <EngineExhaust configs={nozzles} intensityRef={thrust} audioOwner />
    </group>
  );
}

export function RemoteStarterSurvey({ thrust }: { thrust: RefObject<number> }) {
  const { scene: hero } = useGLTF(HERO, false, false);
  const distant = useGLTF(DISTANT_ASSETS, false, false);
  const nozzles = useMemo(() => nozzleConfigs(hero), [hero]);
  const hull = useMemo(() => {
    const lod = new LOD();
    lod.name = "starterSurveyLOD";
    lod.autoUpdate = false;
    [hero, ...distant.map(({ scene }) => scene)].forEach((scene, level) => {
      const instance = hullInstance(scene);
      instance.name = `starterSurveyLOD${level}`;
      instance.visible = level === 0;
      lod.addLevel(instance, REMOTE_DISTANCES[level], 0.12);
    });
    return lod;
  }, [hero, distant]);

  // Remote bells integrate locally from the synced thrust and the air at the ship: the same
  // model as the owner's, so no protocol change (HEAT_SYSTEM_PLAN §3). All LODs glow.
  const worldOrigin = useWorldOrigin();
  const bells = useMemo(() => ({
    th: createThermal(DEFAULT_RESOURCE_TUNING), amb: createAmbient(), plume: createDrivePlume(),
    loopK: loopTempK(0, DEFAULT_RESOURCE_TUNING), at: new Vector3(),
  }), []);
  useFrame((_, delta) => {
    const b = bells;
    hull.getWorldPosition(b.at);
    const o = worldOrigin.worldOriginKm;
    const amb = ambientAt(o.x + b.at.x / 1000, o.y + b.at.y / 1000, o.z + b.at.z / 1000, b.amb);
    const throttle = thrust.current ?? 0;
    drivePlume(amb.model, amb.altitudeKm, throttle, DEFAULT_RESOURCE_TUNING, b.plume);
    stepBells(b.th, throttle, b.plume.veKmps, b.plume.rhoAmb, 0, amb.model?.surfaceTemperatureK ?? 0, b.loopK, Math.min(delta, 0.1));
  }, FRAME_PRIORITY_REMOTE_SHIPS + 0.05);
  useBellGlow(hull, () => bells.th.bellK, true);

  // Select from the player camera once, after the remote ship's pose is applied.
  // Shadow/render cameras and the co-op warm-up must see that same selection.
  useFrame(({ camera }) => {
    hull.updateWorldMatrix(true, false);
    hull.update(camera);
  }, FRAME_PRIORITY_REMOTE_SHIPS + 0.1);

  return (
    <group dispose={null}>
      <primitive object={hull} />
      <EngineExhaust configs={nozzles} intensityRef={thrust} castLight={false} />
    </group>
  );
}
