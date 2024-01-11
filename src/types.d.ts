import "@react-three/fiber";

declare module "@react-three/fiber" {
  interface ThreeElements {
    atmosphereShaderMaterial: ReactThreeFiber.MaterialNode<
      THREE.ShaderMaterial,
      [THREE.ShaderMaterialParameters]
    >;
  }
}
