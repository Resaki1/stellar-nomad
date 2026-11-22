import { useEffect, useMemo, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { Mesh, MeshStandardMaterial, Vector3, type Group } from "three";
import { emitterColor, type EmitterId } from "@/components/space/emissivePhotometry";
import { registerPreExposedEmissive } from "@/components/space/preExposedEmissive";

const BASE = "/models/stations/base-depot";
export const DEPOT_LOD_ASSETS = [BASE + ".glb", BASE + "-lod1.glb", BASE + "-lod2.glb"];
export const DEPOT_COLLISION_ASSET = BASE + "-collision.glb";
export const DEPOT_LOD_DISTANCES_M = [0, 600, 1_100];

const GUIDE_MATERIAL = "Amber depot guides";
const BEACON_MATERIAL = "Amber depot mast beacons";
const FLASH_PERIOD_S = 2;
const FLASH_DURATION_S = 0.45;

export type DepotRenderAssets = {
  scenes: Group[];
  refineryMount: Vector3;
};

/** Share calibrated materials and geometry across every depot instance. */
export function useDepotRenderAssets(): DepotRenderAssets {
  const models = useGLTF(DEPOT_LOD_ASSETS, false, false);
  const animatedLights = useRef<MeshStandardMaterial[]>([]);
  const { assets, lights, beacons } = useMemo(() => {
    const lights = new Map<MeshStandardMaterial, MeshStandardMaterial>();
    const beacons: MeshStandardMaterial[] = [];
    const scenes = models.map(({ scene }) => {
      const template = scene.clone(true);
      template.traverse((object) => {
        if (!(object instanceof Mesh) || !(object.material instanceof MeshStandardMaterial)) return;
        const source = object.material;
        const id: EmitterId | null = source.name === GUIDE_MATERIAL ? "depot_guide"
          : source.name === BEACON_MATERIAL ? "depot_mast_beacon" : null;
        if (id === null) return;
        let light = lights.get(source);
        if (!light) {
          light = source.clone();
          emitterColor(id, light.emissive);
          light.emissiveIntensity = 1;
          lights.set(source, light);
          if (id === "depot_mast_beacon") beacons.push(light);
        }
        object.material = light;
      });
      return template;
    });
    const mount = scenes[0].getObjectByName("socket_upgrade_refinery");
    if (!mount) throw new Error("Base depot is missing its refinery mount socket");
    const refineryMount = mount.getWorldPosition(new Vector3());
    refineryMount.y += 0.18;
    return { assets: { scenes, refineryMount }, lights, beacons };
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

  useFrame(({ clock }) => {
    const intensity = clock.elapsedTime % FLASH_PERIOD_S < FLASH_DURATION_S ? 1 : 0;
    for (const beacon of animatedLights.current) beacon.emissiveIntensity = intensity;
  });

  return assets;
}
