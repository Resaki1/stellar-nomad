"use client";

import { ReactNode, useContext, useEffect, useMemo } from "react";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { EffectComposer, Bloom, ToneMapping, SMAA, EffectComposerContext } from "@react-three/postprocessing";
import { KernelSize, RenderPass, ToneMappingMode } from "postprocessing";
import { HalfFloatType } from "three";
import { LOCAL_TO_SCALED_FROM_LOCAL_UNITS } from "@/sim/units";

const LOCAL_CAMERA_NEAR = 0.01;
// 20,000 km expressed in local meters
const LOCAL_CAMERA_FAR = 20_000 * 1000;
const SCALED_CAMERA_NEAR = 0.001;
const SCALED_CAMERA_FAR = 2_000_000;

const tempScaledPos = new THREE.Vector3();

type DualScenePassesProps = {
  scaledScene: THREE.Scene;
  scaledCamera: THREE.PerspectiveCamera;
  localScene: THREE.Scene;
  localCamera: THREE.PerspectiveCamera;
};

const DualScenePasses = ({ scaledScene, scaledCamera, localScene, localCamera }: DualScenePassesProps) => {
  const { composer } = useContext(EffectComposerContext);

  const scaledPass = useMemo(() => new RenderPass(scaledScene, scaledCamera), [scaledCamera, scaledScene]);
  const localPass = useMemo(() => new RenderPass(localScene, localCamera), [localCamera, localScene]);

  useEffect(() => {
    scaledPass.clear = true;
    localPass.clear = false;
    localPass.clearDepth = true;

    composer.addPass(scaledPass);
    composer.addPass(localPass);

    return () => {
      composer.removePass(scaledPass);
      composer.removePass(localPass);
      scaledPass.dispose?.();
      localPass.dispose?.();
    };
  }, [composer, localPass, scaledPass]);

  return null;
};

export type SpaceRendererProps = {
  scaled: ReactNode;
  local: ReactNode;
  postprocess?: {
    bloom: boolean;
    toneMapping: boolean;
  };
};

const SpaceRenderer = ({ scaled, local, postprocess }: SpaceRendererProps) => {
  const size = useThree((state) => state.size);
  const localCamera = useThree((state) => state.camera as THREE.PerspectiveCamera);

  const scaledScene = useMemo(() => new THREE.Scene(), []);
  const localScene = useMemo(() => new THREE.Scene(), []);
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
  }, 1);

  return (
    <>
      {createPortal(scaled, scaledScene)}
      {createPortal(local, localScene)}
      <EffectComposer
        autoClear={false}
        frameBufferType={HalfFloatType}
        multisampling={8}
        renderPriority={1}
      >
        <DualScenePasses
          localCamera={localCamera}
          localScene={localScene}
          scaledCamera={scaledCamera}
          scaledScene={scaledScene}
        />
        {postprocess?.bloom ? (
          <Bloom intensity={0.02} luminanceThreshold={1} kernelSize={KernelSize.VERY_SMALL} />
        ) : null}
        {postprocess?.toneMapping ? <ToneMapping mode={ToneMappingMode.ACES_FILMIC} /> : null}
        <SMAA />
      </EffectComposer>
    </>
  );
};

export default SpaceRenderer;
