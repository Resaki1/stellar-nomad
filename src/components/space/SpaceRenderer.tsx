"use client";

import { createContext, ReactNode, useContext, useEffect, useMemo } from "react";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { LOCAL_TO_SCALED_FROM_LOCAL_UNITS } from "@/sim/units";
import { EffectComposerContext } from "@react-three/postprocessing";
import { RenderPass } from "postprocessing";

const LOCAL_CAMERA_NEAR = 0.01;
// 20,000 km expressed in local meters
const LOCAL_CAMERA_FAR = 20_000 * 1000;
const SCALED_CAMERA_NEAR = 0.001;
const SCALED_CAMERA_FAR = 2_000_000;

const tempScaledPos = new THREE.Vector3();

export type SpaceRendererProps = {
  scaled: ReactNode;
  local: ReactNode;
  effects?: ReactNode;
};

export const ScaledSpaceContext = createContext<{
  scaledScene: THREE.Scene;
  scaledCamera: THREE.PerspectiveCamera;
} | null>(null);

export const ScaledRenderPass = () => {
  const scaledContext = useContext(ScaledSpaceContext);
  const composerContext = useContext(EffectComposerContext);

  useEffect(() => {
    if (!scaledContext || !composerContext) return;

    const pass = new RenderPass(
      scaledContext.scaledScene,
      scaledContext.scaledCamera,
    );
    // Render scaled space before the default scene pass.
    composerContext.composer.passes.unshift(pass);

    return () => {
      composerContext.composer.removePass(pass);
      pass.dispose();
    };
  }, [composerContext, scaledContext]);

  return null;
};

const SpaceRenderer = ({ scaled, local, effects }: SpaceRendererProps) => {
  const size = useThree((state) => state.size);
  const localCamera = useThree((state) => state.camera as THREE.PerspectiveCamera);

  const scaledScene = useMemo(() => new THREE.Scene(), []);
  const scaledCamera = useMemo(() => localCamera.clone(), [localCamera]);

  useEffect(() => {
    localCamera.near = LOCAL_CAMERA_NEAR;
    localCamera.far = LOCAL_CAMERA_FAR;
    localCamera.updateProjectionMatrix();
  }, [localCamera]);

  useEffect(() => {
    scaledCamera.near = SCALED_CAMERA_NEAR;
    scaledCamera.far = SCALED_CAMERA_FAR;
    scaledCamera.fov = localCamera.fov;
    scaledCamera.aspect = size.width / size.height;
    scaledCamera.updateProjectionMatrix();
  }, [localCamera.fov, scaledCamera, size.height, size.width]);

  useFrame(() => {
    tempScaledPos
      .copy(localCamera.position)
      .multiplyScalar(LOCAL_TO_SCALED_FROM_LOCAL_UNITS);
    scaledCamera.position.copy(tempScaledPos);
    scaledCamera.quaternion.copy(localCamera.quaternion);
  }, 2);

  return (
    <ScaledSpaceContext.Provider
      value={{
        scaledScene,
        scaledCamera,
      }}
    >
      {effects}
      {createPortal(scaled, scaledScene)}
      {local}
    </ScaledSpaceContext.Provider>
  );
};

export default SpaceRenderer;
