import { useEffect, useMemo, type JSX, type RefObject } from "react";
import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { LOD, Mesh, Vector3, type Group } from "three";
import { FRAME_PRIORITY_REMOTE_SHIPS } from "@/components/frameOrder";
import EngineExhaust, { type ExhaustConfig } from "@/components/VFX/EngineExhaust";
import { readCollisionMeshes } from "../collisionMeshes";
import type { ColliderShape } from "@/sim/physics/types";

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
  useEffect(() => {
    onCollisionShape(readCollisionMeshes(collision.scene));
  }, [collision.scene, onCollisionShape]);
  return (
    <group {...props} dispose={null}>
      <primitive object={hull} />
      <EngineExhaust configs={nozzles} intensityRef={thrust} />
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
