import { createContext, useContext, useMemo } from "react";
import { useGLTF, Merged, type MergedProps } from "@react-three/drei";
import type { GLTF } from "three-stdlib";
import type { Mesh, MeshStandardMaterial } from "three";

type GLTFResult = GLTF & {
  nodes: {
    Daphne_LP001_1_0: Mesh;
  };
  materials: {
    material: MeshStandardMaterial;
  };
};

type MergedInstances = Parameters<MergedProps["children"]>[0];

const context = createContext<MergedInstances | null>(null);

export function Instances({
  children,
  ...props
}: Omit<MergedProps, "meshes" | "children"> & { children: React.ReactNode }) {
  const { nodes } = useGLTF(
    "/models/asteroids/asteroid01.glb"
  ) as unknown as GLTFResult;

  const meshes = useMemo(
    () => ({
      DaphneLP: nodes.Daphne_LP001_1_0,
    }),
    [nodes]
  );

  return (
    <Merged meshes={meshes} {...props}>
      {(...instances) => (
        <context.Provider value={instances[0]}>{children}</context.Provider>
      )}
    </Merged>
  );
}

export function Asteroid01(props: React.ComponentPropsWithoutRef<"group">) {
  const instances = useContext(context);
  if (!instances) return null;

  return (
    <group {...props} dispose={null} frustumCulled={false}>
      <instances.DaphneLP
        rotation={[-Math.PI / 2, 0, 0]}
        scale={0.125}
        frustumCulled={false}
      />
    </group>
  );
}

useGLTF.preload("/models/asteroids/asteroid01.glb");
