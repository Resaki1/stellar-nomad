import { useEffect, useMemo, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useStore } from "jotai";
import { Matrix4, Mesh, MeshStandardMaterial, type Group } from "three";
import type { MeshStandardNodeMaterial } from "three/webgpu";
import { emitterColor, type EmitterId } from "@/components/space/emissivePhotometry";
import { registerPreExposedEmissive } from "@/components/space/preExposedEmissive";
import { beaconFlash, fadingLampMaterial, readLightTemplate, type LightTemplate } from "@/components/space/lightPoints";
import { simEpochMsAtom } from "@/store/simTime";

const BASE = "/models/stations/base-depot";
export const DEPOT_LOD_ASSETS = [BASE + ".glb", BASE + "-lod1.glb", BASE + "-lod2.glb"];
export const DEPOT_COLLISION_ASSET = BASE + "-collision.glb";
export const DEPOT_LOD_DISTANCES_M = [0, 600, 1_100];

const GUIDE_MATERIAL = "Amber depot guides";
const BEACON_MATERIAL = "Amber depot mast beacons";
/** Lamp size for the mesh ↔ light-point crossfade, m (build.py: lamps 0.26–0.30, lens ⌀0.28). */
const LAMP_SIZE_M = 0.28;

export type DepotRenderAssets = {
  scenes: Group[];
  refineryMount: Matrix4;
  /** Lamp light points (VFX plan §1), depot space. */
  lights: LightTemplate;
};

/** The socket exposes +Z out of the rails. The module itself is authored +Y up. */
export function refineryMountMatrix(scene: Group): Matrix4 {
  scene.updateMatrixWorld(true);
  const socket = scene.getObjectByName("socket_upgrade_refinery");
  if (!socket) throw new Error("Base depot is missing its refinery mount socket");
  return socket.matrixWorld.clone().multiply(new Matrix4().makeRotationX(Math.PI / 2));
}

/** Share calibrated materials and geometry across every depot instance. */
export function useDepotRenderAssets(): DepotRenderAssets {
  const models = useGLTF(DEPOT_LOD_ASSETS, false, false);
  const store = useStore();
  const animatedLights = useRef<MeshStandardNodeMaterial[]>([]);
  const { assets, lights, beacons } = useMemo(() => {
    const lights = new Map<MeshStandardMaterial, MeshStandardNodeMaterial>();
    const beacons: MeshStandardNodeMaterial[] = [];
    const scenes = models.map(({ scene }) => {
      const template = scene.clone(true);
      template.traverse((object) => {
        if (object instanceof Mesh) object.receiveShadow = object.castShadow = true;
        if (!(object instanceof Mesh) || !(object.material instanceof MeshStandardMaterial)) return;
        const source = object.material;
        const id: EmitterId | null = source.name === GUIDE_MATERIAL ? "depot_guide"
          : source.name === BEACON_MATERIAL ? "depot_mast_beacon" : null;
        if (id === null) return;
        let light = lights.get(source);
        if (!light) {
          light = fadingLampMaterial(source, LAMP_SIZE_M);
          emitterColor(id, light.emissive);
          light.emissiveIntensity = 1;
          lights.set(source, light);
          if (id === "depot_mast_beacon") beacons.push(light);
        }
        object.material = light;
      });
      return template;
    });
    const template = readLightTemplate(scenes[0]);
    return { assets: { scenes, refineryMount: refineryMountMatrix(scenes[0]), lights: template }, lights, beacons };
  }, [models]);

  useEffect(() => {
    const unregister = Array.from(lights.values(), light => registerPreExposedEmissive(light));
    animatedLights.current = beacons;
    return () => {
      animatedLights.current = [];
      unregister.forEach(dispose => dispose());
      lights.forEach(light => light.dispose());
    };
  }, [lights, beacons]);

  useFrame(() => {
    const intensity = beaconFlash(store.get(simEpochMsAtom));
    for (const beacon of animatedLights.current) beacon.emissiveIntensity = intensity;
  });

  return assets;
}
