import { useEffect, useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useStore } from "jotai";
import { Mesh, MeshStandardMaterial, Vector3, type Group } from "three";
import type { MeshStandardNodeMaterial } from "three/webgpu";
import { emitterColor, type EmitterId } from "@/components/space/emissivePhotometry";
import { beaconFlash, fadingLampMaterial, readLightTemplate, type LightTemplate } from "@/components/space/lightPoints";
import { registerPreExposedEmissive } from "@/components/space/preExposedEmissive";
import { useSpillLightmaps, withSpillLightmap } from "@/components/space/spillBake";
import { simEpochMsAtom } from "@/store/simTime";

const BASE = "/models/drones/base-drone";
const DRONE_LOD_ASSETS = [BASE + ".glb", BASE + "-lod1.glb", BASE + "-lod2.glb"];
export const DRONE_LOD_DISTANCES_M = [0, 100, 320];

const LAMPS = {
  "Amber drone status": { emitter: "drone_status", sizeM: 0.105, blink: false },
  "Amber drone beacon": { emitter: "drone_beacon", sizeM: 0.108, blink: true },
} satisfies Record<string, { emitter: EmitterId; sizeM: number; blink: boolean }>;

export type DroneRenderAssets = {
  scenes: Group[];
  lights: LightTemplate;
  miningPosition: Vector3;
  miningDirection: Vector3;
};

/** Share the uploaded geometry, textures and synchronized lamp materials across the fleet. */
export function useDroneRenderAssets(): DroneRenderAssets {
  const models = useGLTF(DRONE_LOD_ASSETS, false, false);
  // S3: each LOD's baked lamp spill (TEXCOORD_1), tools/models/spill-bake.mjs.
  const spill = useSpillLightmaps(BASE, DRONE_LOD_ASSETS.length);
  const store = useStore();
  const { assets, lamps, setBeaconIntensity } = useMemo(() => {
    const lamps: MeshStandardNodeMaterial[] = [];
    const beacons: MeshStandardNodeMaterial[] = [];
    const scenes = models.map(({ scene }, lod) => {
      const template = scene.clone(true);
      template.traverse(object => {
        if (!(object instanceof Mesh) || !(object.material instanceof MeshStandardMaterial)) return;
        const lamp = LAMPS[object.material.name as keyof typeof LAMPS];
        if (!lamp) {
          object.castShadow = object.receiveShadow = true;
          withSpillLightmap(object.material, spill[lod]);
          return;
        }
        const material = fadingLampMaterial(object.material, lamp.sizeM);
        emitterColor(lamp.emitter, material.emissive);
        material.emissiveIntensity = 1;
        lamps.push(material);
        if (lamp.blink) beacons.push(material);
        object.material = material;
      });
      return template;
    });
    // S3: steady lamps' spill is baked; the pooled spill light handles the beacons.
    const lights = readLightTemplate(scenes[0], true);
    const mining = scenes[0].getObjectByName("socket_mining");
    if (!mining) throw new Error("Base drone is missing its mining socket");
    const miningPosition = new Vector3().setFromMatrixPosition(mining.matrixWorld);
    const miningDirection = new Vector3().setFromMatrixColumn(mining.matrixWorld, 2).normalize();
    const setBeaconIntensity = (intensity: number) => {
      for (const material of beacons) material.emissiveIntensity = intensity;
    };
    return { assets: { scenes, lights, miningPosition, miningDirection }, lamps, setBeaconIntensity };
  }, [models, spill]);

  useEffect(() => {
    const unregister = lamps.map(material => registerPreExposedEmissive(material));
    return () => {
      unregister.forEach(remove => remove());
      lamps.forEach(material => material.dispose());
    };
  }, [lamps]);

  useFrame(() => setBeaconIntensity(beaconFlash(store.get(simEpochMsAtom))));

  return assets;
}
