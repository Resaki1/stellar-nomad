/*
Auto-generated by: https://github.com/pmndrs/gltfjsx
Command: npx gltfjsx@6.2.13 scene.gltf -T -S -t -s -i -I -D 
Files: scene.gltf [5.29KB] > scene-transformed.glb [1.23MB] (-23232%)
Author: pasquill (https://sketchfab.com/pasquill)
License: CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)
Source: https://sketchfab.com/3d-models/asteroid-low-poly-9a43ef48a70647188576ccb5987b7e64
Title: Asteroid low poly
*/

import {
  useMemo,
  useContext,
  createContext,
  ForwardRefExoticComponent,
} from "react";
import { useGLTF, Merged } from "@react-three/drei";
import { GLTF } from "three-stdlib";

type GLTFResult = GLTF & {
  nodes: {
    Daphne_LP001_1_0: THREE.Mesh;
  };
  materials: {
    material: THREE.MeshStandardMaterial;
  };
};

type ContextType = Record<
  string,
  ForwardRefExoticComponent<JSX.IntrinsicElements["mesh"]>
>;

const context = createContext({} as ContextType);
export function Instances({
  children,
  ...props
}: JSX.IntrinsicElements["group"]) {
  const { nodes } = useGLTF("/models/asteroids/asteroid01.glb") as GLTFResult;
  const instances = useMemo(
    () => ({
      DaphneLP: nodes.Daphne_LP001_1_0,
    }),
    [nodes]
  );
  return (
    <Merged meshes={instances} {...props}>
      {(instances: ContextType) => (
        <context.Provider
          value={instances}
          // eslint-disable-next-line react/no-children-prop
          children={children}
        />
      )}
    </Merged>
  );
}

export function Asteroid01(props: JSX.IntrinsicElements["group"]) {
  const instances = useContext(context);
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