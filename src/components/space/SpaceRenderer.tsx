"use client";

import { useContext, useEffect, useMemo } from "react";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, EffectComposerContext, SMAA, ToneMapping } from "@react-three/postprocessing";
import { KernelSize, RenderPass, ToneMappingMode } from "postprocessing";
import * as THREE from "three";
import type { ReactNode } from "react";
import { SCALED_UNITS_PER_KM } from "@/sim/units";

const LOCAL_CAMERA_NEAR = 0.01;
const LOCAL_CAMERA_FAR = 20_000;
const SCALED_CAMERA_NEAR = 0.001;
const SCALED_CAMERA_FAR = 2_000_000;

type SpaceRendererProps = {
  scaled: ReactNode;
  local: ReactNode;
  bloom?: boolean;
  toneMapping?: boolean;
};

type RenderPassInserterProps = {
  scene: THREE.Scene;
  camera: THREE.Camera;
};

const RenderPassInserter = ({ scene, camera }: RenderPassInserterProps) => {
  const composerContext = useContext(EffectComposerContext);

  useEffect(() => {
    if (!composerContext?.composer) return;

    const renderPass = new RenderPass(scene, camera);
    composerContext.composer.insertPass(renderPass, 0);

    return () => {
      composerContext.composer.removePass(renderPass);
      renderPass.dispose?.();
    };
  }, [camera, composerContext, scene]);

  return null;
};

const SpaceRenderer = ({ scaled, local, bloom, toneMapping }: SpaceRendererProps) => {
  const { camera: localCamera, size, scene: defaultScene } = useThree();

  const scaledScene = useMemo(() => new THREE.Scene(), []);
  const scaledCamera = useMemo(() => {
    const clone = (localCamera as THREE.PerspectiveCamera).clone();
    clone.near = SCALED_CAMERA_NEAR;
    clone.far = SCALED_CAMERA_FAR;
    clone.updateProjectionMatrix();
    return clone;
  }, [localCamera]);

  useEffect(() => {
    const perspective = localCamera as THREE.PerspectiveCamera;
    perspective.near = LOCAL_CAMERA_NEAR;
    perspective.far = LOCAL_CAMERA_FAR;
    perspective.updateProjectionMatrix();
  }, [localCamera]);

  useEffect(() => {
    scaledCamera.aspect = size.width / size.height;
    scaledCamera.updateProjectionMatrix();
  }, [scaledCamera, size.height, size.width]);

  useFrame(() => {
    const perspectiveCamera = localCamera as THREE.PerspectiveCamera;
    scaledCamera.position
      .copy(perspectiveCamera.position)
      .multiplyScalar(SCALED_UNITS_PER_KM);
    scaledCamera.quaternion.copy(perspectiveCamera.quaternion);
    scaledCamera.fov = perspectiveCamera.fov;
    scaledCamera.aspect = perspectiveCamera.aspect;
    scaledCamera.updateProjectionMatrix();
  });

  return (
    <>
      {createPortal(scaled, scaledScene)}
      {createPortal(local, defaultScene)}
      <EffectComposer
        camera={localCamera}
        scene={defaultScene}
        frameBufferType={THREE.HalfFloatType}
        multisampling={8}
        autoClear={true}
      >
        <RenderPassInserter scene={scaledScene} camera={scaledCamera} />
        {bloom ? (
          <Bloom
            intensity={0.02}
            luminanceThreshold={1}
            kernelSize={KernelSize.VERY_SMALL}
          />
        ) : null}
        {toneMapping ? <ToneMapping mode={ToneMappingMode.ACES_FILMIC} /> : null}
        <SMAA />
      </EffectComposer>
    </>
  );
};

export default SpaceRenderer;
